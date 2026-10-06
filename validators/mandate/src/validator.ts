import {
  jsonLineLog,
  MAX_REQUEST_URI_BYTES,
  sendOperatorReport,
  ValidatorBase,
  type Admission,
  type CheckResult,
  type CursorStore,
  type InboxPort,
  type RespondedResponse,
  type ValidationStatus,
  type ValidatorChain,
  type ValidatorOptions,
  type VerifiedRequest,
} from "@attest8004/sdk";
import { BaseError, keccak256, zeroHash, type Address, type Hex } from "viem";
import type { PreimageCache } from "./collect.ts";
import { MANDATE_V1 } from "./params.ts";
import { firstMandateRegistryBlock, mandateAddressesAt, type MandateContracts, type MandateReader } from "./reader.ts";
import { servedGateDecline, servedGateMap } from "./gates.ts";
import { mandateReport } from "./report.ts";
import { mandateRequestOf, runMandateV1 } from "./run.ts";
import type { PinnedBlock } from "./types.ts";
import { approvalsAfterPin } from "./verify.ts";

/** How long `check()` waits for the finalized head to reach its floor before it fails (and the base retries). */
export const DEFAULT_PIN_TIMEOUT_MS = 30_000;
/** How often `check()` re-reads the finalized head while it waits. */
export const DEFAULT_PIN_POLL_MS = 250;
/**
 * How far below the finalized head `P` is pinned. A load-balanced RPC can answer `finalized` from one
 * node and `eth_getLogs` from another a few blocks behind it, and a log range that straddles the
 * serving node's head comes back empty or truncated without an error. Pinning this far below the
 * head keeps every log read at `P` under any node that lags less than this.
 */
export const PIN_LAG_BLOCKS = 5n;

/**
 * A gate this validator answers for, and the agent it answers for there. A DemoAgentVault is bound to
 * one agent, so a request naming it for any other agent could never execute; answering it would only
 * spend this validator's gas.
 */
export interface ServedGate {
  gate: Address;
  agentId: bigint;
}

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
  /**
   * The contracts, with the MandateRegistry history (`mandateContractsFor(chainId)`). A check pinned at
   * `P` records the addresses valid at `P` (`mandateAddressesAt`). `P` is never below the first
   * registry's `fromBlock`: the mandate can't be read before it, and `verify` rejects such a pin.
   */
  contracts: MandateContracts;
  /**
   * The (gate, agent) pairs whose requests this validator answers, e.g. a DemoAgentVault and the one
   * agent it is bound to. Gates are compared case-insensitively. A gate may be listed with several agents.
   */
  gates: ServedGate[];
  /** The per-agent rate limit and daily gas budget, checked last in `accepts()`. */
  admission: Admission;
  /** Default {@link DEFAULT_PIN_TIMEOUT_MS} (30,000 ms). */
  pinTimeoutMs?: number;
  /** Default {@link DEFAULT_PIN_POLL_MS} (250 ms). */
  pinPollMs?: number;
  /** The request parts already authenticated against their hash. Default: a new, empty map. */
  cache?: PreimageCache;
  /**
   * Where operator reports go (P7): after each response lands, a report is sealed to the agent's inbox key and posted
   * to the FindingsBoard, if the agent has one. `null` or absent: no reports, and no inbox reads.
   */
  inbox?: InboxPort | null;
};

/**
 * Validator A, `mandate-v1` (SPEC §4.5): the SDK's `ValidatorBase` polling, request checks and
 * canonical evidence, with a deterministic verdict that `verify` can re-run at the evidence's pinned
 * block and reproduce byte for byte.
 *
 * - **`accepts()`**, in order, declining with one `warn` line that names the agent: a gate it doesn't
 *   serve (`GATE_NOT_SERVED`) or serves only for other agents (`GATE_NOT_FOR_AGENT`), both before any
 *   RPC, so nobody can spend this validator's gas by naming its gate for their own agent; at the
 *   reader's finalized head, no mandate (`NO_MANDATE`), an expired one
 *   (`MANDATE_EXPIRED`) or one set by someone who no longer owns the agent (`MANDATE_STALE`); then the
 *   admission policy (`RATE_LIMITED`, `GAS_BUDGET_EXHAUSTED`), admitted at the cycle head's time. If
 *   that finalized head is still below the request's block (a lagging RPC node), it throws instead of
 *   declining, so the base retries the request later.
 * - **`check()`** pins `P`, runs {@link runMandateV1} at `P`, and caches the request's parts.
 * - **The pin.** `P` is {@link PIN_LAG_BLOCKS} (5) blocks below the finalized head at check time, so
 *   every log read at `P` stays under the head of an RPC node that lags the one that answered
 *   `finalized` by fewer blocks than that (a log range past a node's head comes back short, silently).
 *   `P` is never below the request's own block, the block this process's last response landed in, or
 *   the first MandateRegistry's `fromBlock`: until the head is that far ahead, it waits. It also waits
 *   until `P`'s time is no more than 3,600 s before the action's deadline: the base checked that horizon
 *   at the cycle head, which can be later than `P`, and `verify` checks it at `P`. And if this
 *   process's most recent approval is answered at `latest` but not yet at `P` (a send that landed but
 *   threw, so `onResponded` never ran), `P` waits until it is answered there. So two requests checked
 *   back to back always see each other's approval in their spend. It re-reads the head every
 *   `pinPollMs`, and after `pinTimeoutMs` throws: nothing is posted, and the base retries the request
 *   later. This assumes one validator process per key.
 * - **`onResponded()`** records the response's block for the pin and settles the admission reservation
 *   to the gas limit actually sent. Then, with an `inbox`, it posts the operator report (`mandateReport`,
 *   sealed to the agent's inbox key, an explicit gas limit) and settles the report's reservation; a report
 *   that fails is logged and keeps its reservation. It never throws: the verdict has already landed. **`onGaveUp()`** releases the reservation of a
 *   request the base gave up on (`Admission.release`): no response will be sent for it.
 *
 * The tag is always `mandate-v1`, the deadline horizon always 3,600 s and the request size limit always
 * 16,384 bytes (what `verify` decodes), whatever the options say.
 * Logs are JSON lines on stdout by default (the SDK's `jsonLineLog`, bigints as decimal strings).
 */
export class MandateValidator extends ValidatorBase {
  private readonly chain: ValidatorChain;
  private readonly cursorStore: CursorStore;
  private readonly reader: MandateReader;
  private readonly contracts: MandateContracts;
  /** The first MandateRegistry's `fromBlock`: the pin's floor. */
  private readonly firstRegistryBlock: bigint;
  /** The agents each served gate (lower-case) is answered for. */
  private readonly gates: ReadonlyMap<string, ReadonlySet<bigint>>;
  private readonly admission: Admission;
  private readonly cache: PreimageCache;
  private readonly pinTimeoutMs: number;
  private readonly pinPollMs: number;
  private readonly emit: (entry: Record<string, unknown>) => void;
  private readonly inbox: InboxPort | null;
  /** The highest block one of this process's responses landed in. */
  private lastResponseBlock: bigint | undefined;
  /** This process's most recent approval (score 100), until it is seen answered at a pinned block. */
  private pendingApproval: Hex | undefined;
  /** The latest `P`'s timestamp: the clock `admission.settle` runs on. */
  private lastPinTimestamp = 0n;
  private caughtUp = false;

  constructor(options: MandateValidatorOptions) {
    const { reader, contracts, gates, admission, pinTimeoutMs, pinPollMs, cache, inbox, ...base } = options;
    const log = options.log ?? jsonLineLog;
    super({
      ...base,
      log,
      tag: MANDATE_V1.tag,
      maxDeadlineAheadSeconds: MANDATE_V1.maxDeadlineAheadSeconds,
      maxRequestBytes: MAX_REQUEST_URI_BYTES,
    });
    if (gates.length === 0) throw new Error("a MandateValidator needs at least one gate to serve");
    if (contracts.mandateRegistries.length === 0) throw new Error("a MandateValidator needs at least one MandateRegistry in its history");
    this.chain = options.chain;
    this.cursorStore = options.cursor;
    this.reader = reader;
    this.contracts = contracts;
    this.firstRegistryBlock = firstMandateRegistryBlock(contracts);
    this.gates = servedGateMap(gates);
    this.admission = admission;
    this.cache = cache ?? new Map();
    this.pinTimeoutMs = pinTimeoutMs ?? DEFAULT_PIN_TIMEOUT_MS;
    this.pinPollMs = pinPollMs ?? DEFAULT_PIN_POLL_MS;
    this.emit = log;
    this.inbox = inbox ?? null;
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

  /** The (gate, agent) allowlist, before any read (P12, AUD-05): `GATE_NOT_SERVED` / `GATE_NOT_FOR_AGENT`. */
  protected override servesLocally(request: VerifiedRequest): true | { decline: string } {
    const notServed = servedGateDecline(this.gates, request.gate, request.action.agentId);
    return notServed === null ? true : { decline: notServed };
  }

  protected override async accepts(request: VerifiedRequest): Promise<boolean | { decline: string }> {
    const agentId = request.action.agentId;
    const notServed = servedGateDecline(this.gates, request.gate, agentId);
    if (notServed !== null) return { decline: notServed };
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
    const pinned = await this.pin(requestHash, blockNumber, request.action.deadline, request.event.agentId);
    if (pinned.timestamp > this.lastPinTimestamp) this.lastPinTimestamp = pinned.timestamp;

    const mandateRequest = mandateRequestOf(request.json, requestHash, blockNumber);
    const result = await runMandateV1({
      reader: this.reader,
      addresses: mandateAddressesAt(this.contracts, pinned.number),
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

  protected override async onResponded(response: RespondedResponse): Promise<void> {
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
    if (this.inbox) await this.postReport(this.inbox, response);
  }

  /** Posts the operator report for a landed response and settles its gas reservation. Never throws. */
  private async postReport(inbox: InboxPort, response: RespondedResponse): Promise<void> {
    const { requestHash } = response;
    try {
      const outcome = await sendOperatorReport(inbox, { report: mandateReport({ evidence: response.evidence, responseHash: response.responseHash }) });
      if (outcome.kind === "posted") {
        this.admission.settleReport({ requestHash, gasLimit: outcome.gasLimit, now: this.lastPinTimestamp });
        const { txHash, blockNumber, gasLimit, envelopeBytes } = outcome;
        this.logLine("info", "operator report posted", { requestHash, txHash, blockNumber, gasLimit, envelopeBytes });
      } else if (outcome.kind === "skipped") {
        this.admission.settleReport({ requestHash, gasLimit: 0n, now: this.lastPinTimestamp });
        this.logLine("info", "operator report skipped", { requestHash, reason: outcome.reason });
      } else {
        this.logLine("error", "operator report failed; its gas reservation stays", { requestHash, error: outcome.error });
      }
    } catch (error) {
      try {
        this.logLine("error", "operator report failed; its gas reservation stays", { requestHash, error: errorMessage(error) });
      } catch {
        // The response already landed; nothing here may throw.
      }
    }
  }

  /**
   * Releases the admission reservation of a request the base gave up on (`Admission.release`): no
   * response will be sent for it. (Every decline happens in `accepts()`, before admission, so there is
   * nothing else to release.)
   */
  protected override onGaveUp(requestHash: Hex): void {
    this.admission.release(requestHash);
  }

  /**
   * `P` for one check (see the class doc): {@link PIN_LAG_BLOCKS} below the finalized head, once that
   * is high enough and complete.
   */
  private async pin(requestHash: Hex, requestBlock: bigint, deadline: bigint, agentId: bigint): Promise<PinnedBlock> {
    let floor = requestBlock;
    if (this.lastResponseBlock !== undefined && this.lastResponseBlock > floor) floor = this.lastResponseBlock;
    if (this.firstRegistryBlock > floor) floor = this.firstRegistryBlock;
    const approval = this.pendingApproval;
    // Only an approval that landed can be waited for; one that never landed has nothing to show at P.
    const mustSee = approval !== undefined && answered(await this.chain.status(approval)) ? approval : undefined;
    // The base checked the deadline horizon against the cycle head's time, which can be later than P's:
    // P's own time must allow it too, as `verify` checks (a later deadline is a request no validator answers).
    const earliestTime = deadline - MANDATE_V1.maxDeadlineAheadSeconds;
    const giveUpAt = Date.now() + this.pinTimeoutMs;
    let waiting = false;
    for (;;) {
      const head = await this.reader.finalized();
      const at = head.number - PIN_LAG_BLOCKS;
      // P12 AUD-02: the floor is also read from the chain, so a restarted process (whose memory is empty) still
      // never pins before its own last approval of this agent that the finalized head shows: `verify` would report it.
      if (
        at >= floor &&
        (mustSee === undefined || answered(await this.reader.status(mustSee, at))) &&
        (await approvalsAfterPin({ reader: this.reader, validator: this.chain.address, agentId, pin: at, upTo: head.number, exclude: requestHash })).length === 0
      ) {
        const pinned = await this.reader.block(at);
        if (pinned.timestamp >= earliestTime) {
          if (mustSee !== undefined && this.pendingApproval === mustSee) this.pendingApproval = undefined;
          return pinned;
        }
      }
      if (Date.now() >= giveUpAt) {
        const missing = mustSee === undefined ? "" : ` with this validator's approval ${mustSee} answered there`;
        throw new Error(
          `the finalized head (block ${head.number}) minus ${PIN_LAG_BLOCKS} blocks didn't reach block ${floor}${missing}, ` +
            `at a time no earlier than ${earliestTime}, within ${this.pinTimeoutMs} ms; retry later`,
        );
      }
      if (!waiting) {
        waiting = true;
        this.logLine("info", "waiting for the finalized head", { requestHash, head: head.number, pin: at, floor, earliestTime, approval: mustSee });
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
