import {
  jsonLineLog,
  MAX_REQUEST_URI_BYTES,
  ValidatorBase,
  type Admission,
  type CheckResult,
  type CursorStore,
  type ValidationStatus,
  type ValidatorChain,
  type ValidatorOptions,
  type VerifiedRequest,
} from "@attest8004/sdk";
import { BaseError, keccak256, zeroHash, type Address, type Hash, type Hex } from "viem";
import type { PreimageCache } from "./collect.ts";
import { MANDATE_V1 } from "./params.ts";
import type { MandateAddresses, MandateReader } from "./reader.ts";
import { mandateRequestOf, runMandateV1 } from "./run.ts";
import type { PinnedBlock } from "./types.ts";

/** How long `check()` waits for the finalized head to reach its floor before it fails (and the base retries). */
export const DEFAULT_PIN_TIMEOUT_MS = 30_000;
/** How often `check()` re-reads the finalized head while it waits. */
export const DEFAULT_PIN_POLL_MS = 250;

export type MandateValidatorOptions = Omit<ValidatorOptions, "tag" | "maxDeadlineAheadSeconds" | "maxRequestBytes"> & {
  /** Ignored: a `MandateValidator` always tags its responses `mandate-v1`. */
  tag?: string;
  /** Ignored: always `MANDATE_V1.maxDeadlineAheadSeconds` (3,600 s), which the spend window relies on. */
  maxDeadlineAheadSeconds?: bigint;
  /**
   * Ignored: always the SDK's `MAX_REQUEST_URI_BYTES` (16,384), the largest request `verify` decodes,
   * so this validator never answers a request that `verify` would call invalid.
   */
  maxRequestBytes?: number;
  reader: MandateReader;
  addresses: MandateAddresses;
  /** The gates (e.g. a DemoAgentVault) whose requests this validator answers. Compared case-insensitively. */
  gates: Address[];
  /** The per-agent rate limit and daily gas budget, checked last in `accepts()`. */
  admission: Admission;
  /** Default {@link DEFAULT_PIN_TIMEOUT_MS} (30,000 ms). */
  pinTimeoutMs?: number;
  /** Default {@link DEFAULT_PIN_POLL_MS} (250 ms). */
  pinPollMs?: number;
  /** The request parts already authenticated against their hash. Default: a new, empty map. */
  cache?: PreimageCache;
};

/**
 * Validator A, `mandate-v1` (SPEC §4.5): the SDK's `ValidatorBase` polling, request checks and
 * canonical evidence, with a deterministic verdict that `verify` can re-run at the evidence's pinned
 * block and reproduce byte for byte.
 *
 * - **`accepts()`**, in order, declining with one `warn` line that names the agent: a gate it doesn't
 *   serve (`GATE_NOT_SERVED`); at the reader's finalized head, no mandate (`NO_MANDATE`), an expired one
 *   (`MANDATE_EXPIRED`) or one set by someone who no longer owns the agent (`MANDATE_STALE`); then the
 *   admission policy (`RATE_LIMITED`, `GAS_BUDGET_EXHAUSTED`), admitted at the cycle head's time. If
 *   that finalized head is still below the request's block (a lagging RPC node), it throws instead of
 *   declining, so the base retries the request later.
 * - **`check()`** pins `P`, runs {@link runMandateV1} at `P`, and caches the request's parts.
 * - **The pin.** `P` is the finalized head at check time, but never below the request's own block nor
 *   below the block this process's last response landed in. And if this process's most recent approval
 *   is answered at `latest` but not yet at the finalized head (a send that landed but threw, so
 *   `onResponded` never ran), `P` waits until it is answered there. So two requests checked back to
 *   back always see each other's approval in their spend. It re-reads the head every `pinPollMs`, and
 *   after `pinTimeoutMs` throws: nothing is posted, and the base retries the request later. This
 *   assumes one validator process per key.
 * - **`onResponded()`** records the response's block for the pin and settles the admission reservation
 *   to the gas limit actually sent. It never throws.
 *
 * The tag is always `mandate-v1`, the deadline horizon always 3,600 s and the request size limit always
 * 16,384 bytes (what `verify` decodes), whatever the options say.
 * Logs are JSON lines on stdout by default (the SDK's `jsonLineLog`, bigints as decimal strings).
 */
export class MandateValidator extends ValidatorBase {
  private readonly chain: ValidatorChain;
  private readonly cursorStore: CursorStore;
  private readonly reader: MandateReader;
  private readonly addresses: MandateAddresses;
  private readonly gates: ReadonlySet<string>;
  private readonly admission: Admission;
  private readonly cache: PreimageCache;
  private readonly pinTimeoutMs: number;
  private readonly pinPollMs: number;
  private readonly emit: (entry: Record<string, unknown>) => void;
  /** The highest block one of this process's responses landed in. */
  private lastResponseBlock: bigint | undefined;
  /** This process's most recent approval (score 100), until it is seen answered at a finalized head. */
  private pendingApproval: Hex | undefined;
  /** The latest `P`'s timestamp: the clock `admission.settle` runs on. */
  private lastPinTimestamp = 0n;
  private caughtUp = false;

  constructor(options: MandateValidatorOptions) {
    const { reader, addresses, gates, admission, pinTimeoutMs, pinPollMs, cache, ...base } = options;
    const log = options.log ?? jsonLineLog;
    super({
      ...base,
      log,
      tag: MANDATE_V1.tag,
      maxDeadlineAheadSeconds: MANDATE_V1.maxDeadlineAheadSeconds,
      maxRequestBytes: MAX_REQUEST_URI_BYTES,
    });
    if (gates.length === 0) throw new Error("a MandateValidator needs at least one gate to serve");
    this.chain = options.chain;
    this.cursorStore = options.cursor;
    this.reader = reader;
    this.addresses = addresses;
    this.gates = new Set(gates.map((gate) => gate.toLowerCase()));
    this.admission = admission;
    this.cache = cache ?? new Map();
    this.pinTimeoutMs = pinTimeoutMs ?? DEFAULT_PIN_TIMEOUT_MS;
    this.pinPollMs = pinPollMs ?? DEFAULT_PIN_POLL_MS;
    this.emit = log;
  }

  /** The base's poll, plus one `info` line each time it catches up with the finalized head. */
  override async pollOnce(): ReturnType<ValidatorBase["pollOnce"]> {
    const result = await super.pollOnce();
    if (result.caughtUp && !this.caughtUp) {
      const block = await this.cursorStore.load().catch(() => undefined);
      this.logLine("info", "caught up", { block });
    }
    this.caughtUp = result.caughtUp;
    return result;
  }

  protected override async accepts(request: VerifiedRequest): Promise<boolean | { decline: string }> {
    const agentId = request.action.agentId;
    if (!this.gates.has(request.gate.toLowerCase())) {
      return { decline: `GATE_NOT_SERVED: agent ${agentId} requested through gate ${request.gate}, which this validator doesn't serve` };
    }
    // Whether to answer at all, not the verdict: read at the finalized head, not at P.
    const head = await this.reader.finalized();
    // A lagging RPC node may not have the request's block yet, nor a mandate set just before it. Those
    // declines are permanent, so throw instead: the base retries the request in a later cycle.
    if (head.number < request.event.blockNumber) {
      throw new Error(`the finalized head (block ${head.number}) is behind the request's block ${request.event.blockNumber}; retry later`);
    }
    const mandate = await this.reader.mandate(agentId, head.number);
    if (mandate === null) return { decline: `NO_MANDATE: agent ${agentId} has no mandate at block ${head.number}` };
    if (mandate.validUntil < head.timestamp) {
      return {
        decline: `MANDATE_EXPIRED: agent ${agentId}'s mandate was valid until ${mandate.validUntil}, before block ${head.number} (time ${head.timestamp})`,
      };
    }
    const owner = await this.reader.ownerOf(agentId, head.number);
    if (owner.toLowerCase() !== mandate.owner.toLowerCase()) {
      return {
        decline: `MANDATE_STALE: agent ${agentId}'s mandate was set by ${mandate.owner}, but ${owner} owns the agent at block ${head.number}`,
      };
    }
    const admitted = this.admission.admit({ requestHash: request.event.requestHash, agentId, now: request.headTimestamp });
    return admitted.ok ? true : { decline: admitted.detail };
  }

  protected override async check(request: VerifiedRequest): Promise<CheckResult> {
    const { requestHash, blockNumber } = request.event;
    const pinned = await this.pin(requestHash, blockNumber);
    if (pinned.timestamp > this.lastPinTimestamp) this.lastPinTimestamp = pinned.timestamp;

    const mandateRequest = mandateRequestOf(request.json, requestHash, blockNumber);
    const result = await runMandateV1({
      reader: this.reader,
      addresses: this.addresses,
      validator: this.chain.address,
      request: mandateRequest,
      pinned,
      cache: this.cache,
    });

    // The base checked that these parts hash to requestHash, so a later spend read can use them
    // instead of finding this response's evidence again.
    const { chainId, gate, agentId, target, value, data, deadline, salt } = mandateRequest;
    this.cache.set(requestHash.toLowerCase() as Hex, { chainId, gate, agentId, target, value, dataHash: keccak256(data), deadline, salt });
    if (result.score === 100) this.pendingApproval = requestHash;
    return result;
  }

  protected override onResponded(response: { requestHash: Hex; score: number; txHash: Hash; blockNumber: bigint; gasLimit: bigint }): void {
    const { requestHash, blockNumber, gasLimit } = response;
    if (this.lastResponseBlock === undefined || blockNumber > this.lastResponseBlock) this.lastResponseBlock = blockNumber;
    try {
      this.admission.settle({ requestHash, gasLimit, now: this.lastPinTimestamp });
    } catch (error) {
      try {
        this.logLine("error", "admission settle failed; the reservation stays at the maximum", { requestHash, error: errorMessage(error) });
      } catch {
        // The response already landed; nothing here may throw.
      }
    }
  }

  /** `P` for one check (see the class doc): the finalized head, once it is high enough and complete. */
  private async pin(requestHash: Hex, requestBlock: bigint): Promise<PinnedBlock> {
    const floor = this.lastResponseBlock !== undefined && this.lastResponseBlock > requestBlock ? this.lastResponseBlock : requestBlock;
    const approval = this.pendingApproval;
    // Only an approval that landed can be waited for; one that never landed has nothing to show at P.
    const mustSee = approval !== undefined && answered(await this.chain.status(approval)) ? approval : undefined;
    const giveUpAt = Date.now() + this.pinTimeoutMs;
    let waiting = false;
    for (;;) {
      const head = await this.reader.finalized();
      if (head.number >= floor && (mustSee === undefined || answered(await this.reader.status(mustSee, head.number)))) {
        if (mustSee !== undefined && this.pendingApproval === mustSee) this.pendingApproval = undefined;
        return head;
      }
      if (Date.now() >= giveUpAt) {
        const missing = mustSee === undefined ? "" : ` with this validator's approval ${mustSee} answered`;
        throw new Error(
          `the finalized head (block ${head.number}) didn't reach block ${floor}${missing} within ${this.pinTimeoutMs} ms; retry later`,
        );
      }
      if (!waiting) {
        waiting = true;
        this.logLine("info", "waiting for the finalized head", { requestHash, head: head.number, floor, approval: mustSee });
      }
      await sleep(this.pinPollMs);
    }
  }

  private logLine(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown>): void {
    const entry: Record<string, unknown> = { level, msg, validator: MANDATE_V1.tag };
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) entry[key] = value;
    this.emit(entry);
  }
}

/** The base's test: its responses always carry a non-zero responseHash and a tag; pending ones neither. */
function answered(status: ValidationStatus): boolean {
  return status.responseHash !== zeroHash || status.tag !== "";
}

/** viem's short message, never its full one (which can carry the RPC URL). */
function errorMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
