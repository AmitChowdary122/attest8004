import { zeroHash, type Address, type Hash, type Hex } from "viem";
import type { Action } from "./action.ts";
import { MAX_LOG_BLOCK_RANGE } from "./logs.ts";
import {
  MAX_REQUEST_URI_BYTES,
  encodeJsonDataUri,
  parseRequestUri,
  requestHashOfJson,
  requestJsonToAction,
  type RequestJsonV1,
  type RequestRejection,
} from "./request.ts";
import type { RequestEvent, ValidationStatus, ValidatorChain } from "./validator-chain.ts";

/** Where a validator keeps the last block it fully processed. */
export interface CursorStore {
  load(): Promise<bigint | undefined>;
  save(block: bigint): Promise<void>;
}

export class MemoryCursorStore implements CursorStore {
  private block: bigint | undefined;

  constructor(initial?: bigint) {
    this.block = initial;
  }
  async load() {
    return this.block;
  }
  async save(block: bigint) {
    this.block = block;
  }
}

/** A request that passed every check of the base class; `check()` decides the score. */
export interface VerifiedRequest {
  event: RequestEvent;
  json: RequestJsonV1;
  action: Action;
  gate: Address;
  chainId: number;
  /** The head block's timestamp when the request was verified. */
  headTimestamp: bigint;
}

export interface CheckResult {
  /** An integer from 0 to 100. */
  score: number;
  /** Machine-readable reasons, e.g. "TARGET_NOT_ALLOWED". */
  reasons: string[];
  /** Extra evidence fields, e.g. the pinned block number. Must not reuse the base fields' keys. */
  evidence?: Record<string, unknown>;
}

export type SkipReason =
  | RequestRejection
  | "HASH_MISMATCH"
  | "WRONG_VALIDATOR"
  | "AGENT_MISMATCH"
  | "WRONG_CHAIN"
  | "DEADLINE_PASSED"
  | "DEADLINE_TOO_FAR"
  | "ALREADY_RESPONDED";

export type Outcome =
  | { kind: "responded"; requestHash: Hex; score: number; txHash: Hash }
  | { kind: "skipped"; requestHash: Hex; reason: SkipReason; detail?: string }
  | { kind: "gave-up"; requestHash: Hex; error: string };

export interface ValidatorOptions {
  chain: ValidatorChain;
  /** The tag on every response (e.g. "mandate-v1"), also the evidence's `validator` field. */
  tag: string;
  cursor: CursorStore;
  /** First block to scan when the cursor is empty. Default: the current head. */
  startBlock?: bigint;
  /** Default 16,384 bytes (MAX_REQUEST_URI_BYTES). */
  maxRequestBytes?: number;
  /** Ignore requests whose deadline is further ahead than this. Default 3,600 s. */
  maxDeadlineAheadSeconds?: bigint;
  /** Blocks per eth_getLogs query. Default 100 (MAX_LOG_BLOCK_RANGE). */
  maxBlockRange?: bigint;
  /** Attempts to send one response before the cycle fails. Default 3. */
  sendAttempts?: number;
  retryDelayMs?: number;
  /** Failed cycles for one request before it is logged as given up and skipped. Default 5. */
  maxFailedCycles?: number;
  pollIntervalMs?: number;
  /** One JSON object per line on stdout by default. Never given keys or whole request URIs. */
  log?: (entry: Record<string, unknown>) => void;
}

const EVIDENCE_SCHEMA_V1 = "attest8004.evidence.v1";
const RESERVED_EVIDENCE_KEYS = ["schema", "validator", "requestHash", "score", "reasons"];

/**
 * The validator base class (SPEC §4.4). A subclass implements `check()`; the base does the rest:
 *
 * - Polls `ValidationRequest` logs naming this validator with eth_getLogs, from a saved block
 *   cursor, at most `maxBlockRange` blocks per query, up to the finalized head.
 * - Treats `requestURI` as attacker-controlled: only a `data:` URI of at most 16 KB, never fetched.
 * - Doesn't respond at all (it logs the reason) unless the request JSON hashes to the event's
 *   `requestHash`, names this validator, this chain and the event's agentId, and its deadline is
 *   neither past nor more than `maxDeadlineAheadSeconds` ahead.
 * - Checks `getValidationStatus` before working on a request and again before sending, so a
 *   restart never posts twice. Its responses always carry a non-zero responseHash and a tag.
 * - Posts `validationResponse` with an evidence JSON v1 and its keccak256, with an explicit gas
 *   limit (through the chain port), retrying a failed send.
 */
export abstract class ValidatorBase {
  private readonly options: Required<Omit<ValidatorOptions, "startBlock">> & { startBlock: bigint | undefined };
  private readonly failedCycles = new Map<Hex, number>();
  private chainId: number | undefined;

  constructor(options: ValidatorOptions) {
    if (!options.tag) throw new Error("a validator needs a non-empty tag");
    this.options = {
      maxRequestBytes: MAX_REQUEST_URI_BYTES,
      maxDeadlineAheadSeconds: 3_600n,
      maxBlockRange: MAX_LOG_BLOCK_RANGE,
      sendAttempts: 3,
      retryDelayMs: 2_000,
      maxFailedCycles: 5,
      pollIntervalMs: 1_000,
      log: (entry) => console.log(JSON.stringify(entry)),
      ...options,
      startBlock: options.startBlock,
    };
  }

  /** Decides the verdict for a request that passed every check above. */
  protected abstract check(request: VerifiedRequest): Promise<CheckResult>;

  /** Where the evidence goes. Default: a data: URI; responseHash = keccak256 of the JSON bytes. */
  protected async publishEvidence(evidence: Record<string, unknown>): Promise<{ uri: string; hash: Hex }> {
    return encodeJsonDataUri(evidence);
  }

  /** One polling cycle: the next window of blocks after the cursor, up to the head. */
  async pollOnce(): Promise<{ outcomes: Outcome[]; caughtUp: boolean }> {
    const { chain, cursor, maxBlockRange, maxFailedCycles } = this.options;
    this.chainId ??= await chain.chainId();
    const head = await chain.head();
    const last = (await cursor.load()) ?? (this.options.startBlock ?? head.number) - 1n;
    const from = last + 1n;
    if (from > head.number) return { outcomes: [], caughtUp: true };
    const to = head.number < from + maxBlockRange - 1n ? head.number : from + maxBlockRange - 1n;

    const outcomes: Outcome[] = [];
    for (const event of await chain.requestLogs(from, to)) {
      try {
        outcomes.push(await this.handle(event, head.timestamp));
        this.failedCycles.delete(event.requestHash);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failures = (this.failedCycles.get(event.requestHash) ?? 0) + 1;
        if (failures >= maxFailedCycles) {
          this.failedCycles.delete(event.requestHash);
          this.log("error", "gave up on request", { requestHash: event.requestHash, failures, error: message });
          outcomes.push({ kind: "gave-up", requestHash: event.requestHash, error: message });
          continue;
        }
        this.failedCycles.set(event.requestHash, failures);
        this.log("error", "request failed; retrying next cycle", {
          requestHash: event.requestHash,
          failures,
          error: message,
        });
        await cursor.save(event.blockNumber - 1n);
        return { outcomes, caughtUp: false };
      }
    }
    await cursor.save(to);
    return { outcomes, caughtUp: to >= head.number };
  }

  /** Polls until `signal` aborts. Sleeps only when caught up or after a failed cycle. */
  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      let caughtUp = true;
      try {
        ({ caughtUp } = await this.pollOnce());
      } catch (error) {
        this.log("error", "poll failed", { error: error instanceof Error ? error.message : String(error) });
      }
      if (caughtUp && !signal?.aborted) await sleep(this.options.pollIntervalMs, signal);
    }
  }

  private async handle(event: RequestEvent, headTimestamp: bigint): Promise<Outcome> {
    const { chain, tag, maxRequestBytes, maxDeadlineAheadSeconds } = this.options;
    const { requestHash } = event;
    const skip = (reason: SkipReason, detail?: string): Outcome => {
      this.log("warn", "request ignored; no response sent", { requestHash, reason, detail });
      return { kind: "skipped", requestHash, reason, ...(detail ? { detail } : {}) };
    };

    if (answered(await chain.status(requestHash))) return skip("ALREADY_RESPONDED");
    if (event.validator !== chain.address) return skip("WRONG_VALIDATOR", `the event names ${event.validator}`);

    const parsed = parseRequestUri(event.requestURI, maxRequestBytes);
    if (!parsed.ok) return skip(parsed.reason, parsed.detail);
    const { json } = parsed;
    const recomputed = requestHashOfJson(json);
    if (recomputed !== requestHash) return skip("HASH_MISMATCH", `the request JSON hashes to ${recomputed}`);
    if (json.validator !== chain.address) return skip("WRONG_VALIDATOR", `the request names ${json.validator}`);
    if (BigInt(json.agentId) !== event.agentId) {
      return skip("AGENT_MISMATCH", `the request is for agent ${json.agentId}, the event for ${event.agentId}`);
    }
    if (json.chainId !== this.chainId) return skip("WRONG_CHAIN", `the request is for chain ${json.chainId}`);
    const deadline = BigInt(json.action.deadline);
    if (deadline < headTimestamp) return skip("DEADLINE_PASSED", `deadline ${deadline} < head time ${headTimestamp}`);
    if (deadline > headTimestamp + maxDeadlineAheadSeconds) {
      return skip("DEADLINE_TOO_FAR", `deadline ${deadline} is more than ${maxDeadlineAheadSeconds} s ahead`);
    }

    const result = await this.check({
      event,
      json,
      action: requestJsonToAction(json),
      gate: json.gate,
      chainId: json.chainId,
      headTimestamp,
    });
    if (!Number.isInteger(result.score) || result.score < 0 || result.score > 100) {
      throw new Error(`check() returned score ${result.score}; it must be an integer from 0 to 100`);
    }
    const reserved = Object.keys(result.evidence ?? {}).filter((key) => RESERVED_EVIDENCE_KEYS.includes(key));
    if (reserved.length > 0) throw new Error(`check() evidence reuses reserved keys: ${reserved.join(", ")}`);

    const evidence = await this.publishEvidence({
      schema: EVIDENCE_SCHEMA_V1,
      validator: tag,
      requestHash,
      score: result.score,
      reasons: result.reasons,
      ...result.evidence,
    });
    return this.respond(requestHash, result.score, evidence);
  }

  private async respond(requestHash: Hex, score: number, evidence: { uri: string; hash: Hex }): Promise<Outcome> {
    const { chain, tag, sendAttempts, retryDelayMs } = this.options;
    for (let attempt = 1; ; attempt++) {
      // Before every send: a response may have landed since (another run, or a send that errored late).
      if (answered(await chain.status(requestHash))) {
        this.log("warn", "request ignored; no response sent", { requestHash, reason: "ALREADY_RESPONDED" });
        return { kind: "skipped", requestHash, reason: "ALREADY_RESPONDED" };
      }
      try {
        const txHash = await chain.respond({
          requestHash,
          response: score,
          responseURI: evidence.uri,
          responseHash: evidence.hash,
          tag,
        });
        this.log("info", "responded", { requestHash, score, txHash });
        return { kind: "responded", requestHash, score, txHash };
      } catch (error) {
        if (attempt >= sendAttempts) throw error;
        this.log("warn", "send failed; retrying", {
          requestHash,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(retryDelayMs);
      }
    }
  }

  private log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown>): void {
    const entry: Record<string, unknown> = { level, msg, validator: this.options.tag };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      entry[key] = typeof value === "string" && value.length > 200 ? `${value.slice(0, 200)}…` : value;
    }
    this.options.log(entry);
  }
}

/** Our responses always carry a non-zero responseHash and a non-empty tag; pending ones carry neither. */
function answered(status: ValidationStatus): boolean {
  return status.responseHash !== zeroHash || status.tag !== "";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
