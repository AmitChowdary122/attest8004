import { BaseError, zeroHash, type Address, type Hash, type Hex } from "viem";
import type { Action } from "./action.ts";
import { encodeCanonicalJsonDataUri } from "./canonical.ts";
import { MAX_LOG_BLOCK_RANGE } from "./logs.ts";
import {
  MAX_REQUEST_URI_BYTES,
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
  | "ALREADY_RESPONDED"
  /** The subclass's `accepts()` turned the request away. */
  | "DECLINED";

export type Outcome =
  | { kind: "responded"; requestHash: Hex; score: number; txHash: Hash; blockNumber: bigint }
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
  /** Wait between send attempts, and the first wait after a failed cycle (doubling each time). Default 2,000 ms. */
  retryDelayMs?: number;
  /** Failed cycles for one request before it is logged as given up and skipped. Default 5. */
  maxFailedCycles?: number;
  pollIntervalMs?: number;
  /**
   * Where log entries go. Default {@link jsonLineLog}: one JSON object per line on stdout, bigints
   * as decimal strings. Never given keys or whole request URIs. Entries carry bigints (block numbers,
   * gas limits), so a custom logger must handle them. A logger that throws never changes what the
   * validator does: the entry is dropped, with a one-line note on stderr.
   */
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * Writes `entry` as one JSON line on stdout, every `bigint` (at any depth) as a decimal string:
 * `JSON.stringify` alone throws on a bigint. The validator base's default logger.
 */
export function jsonLineLog(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)));
}

/** The `schema` of every evidence document `buildEvidence` builds (ARCHITECTURE §6). */
export const EVIDENCE_SCHEMA_V1 = "attest8004.evidence.v1";
const RESERVED_EVIDENCE_KEYS = ["schema", "validator", "requestHash", "score", "reasons"];

/**
 * The evidence JSON v1 document for a response (ARCHITECTURE §6): the base's fields, then the
 * subclass's own. The base builds it this way before publishing; `verify` (a later CLI) calls it
 * again with a recomputed `CheckResult` to rebuild the exact document and check its hash. Callers
 * that build their own `result.evidence` must avoid the base's reserved keys (`check()`'s caller
 * checks this before building; `buildEvidence` itself does not re-check).
 */
export function buildEvidence(args: { tag: string; requestHash: Hex; result: CheckResult }): Record<string, unknown> {
  const { tag, requestHash, result } = args;
  return {
    schema: EVIDENCE_SCHEMA_V1,
    validator: tag,
    requestHash,
    score: result.score,
    reasons: result.reasons,
    ...result.evidence,
  };
}

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
 * - Posts `validationResponse` with a canonical-JSON evidence document (`buildEvidence()`) and its
 *   keccak256, with a gas limit resolved through the chain port (a literal, or an evidence-sized
 *   headroom policy), retrying a failed send. A request that keeps failing is retried in later
 *   cycles, with a growing wait, then logged as given up.
 * - Lets a subclass decline a valid request without responding (`accepts()`), optionally with a
 *   reason, and notifies it once a response lands (`onResponded()`).
 */
export abstract class ValidatorBase {
  private readonly options: Required<Omit<ValidatorOptions, "startBlock">> & { startBlock: bigint | undefined };
  private readonly failedCycles = new Map<Hex, number>();
  private chainId: number | undefined;

  constructor(options: ValidatorOptions) {
    if (!options.tag) throw new Error("a validator needs a non-empty tag");
    // `??` per field: an option passed as undefined keeps its default (a spread would erase it).
    this.options = {
      chain: options.chain,
      tag: options.tag,
      cursor: options.cursor,
      startBlock: options.startBlock,
      maxRequestBytes: options.maxRequestBytes ?? MAX_REQUEST_URI_BYTES,
      maxDeadlineAheadSeconds: options.maxDeadlineAheadSeconds ?? 3_600n,
      maxBlockRange: options.maxBlockRange ?? MAX_LOG_BLOCK_RANGE,
      sendAttempts: options.sendAttempts ?? 3,
      retryDelayMs: options.retryDelayMs ?? 2_000,
      maxFailedCycles: options.maxFailedCycles ?? 5,
      pollIntervalMs: options.pollIntervalMs ?? 1_000,
      log: options.log ?? jsonLineLog,
    };
  }

  /** Decides the verdict for a request that passed every check above. */
  protected abstract check(request: VerifiedRequest): Promise<CheckResult>;

  /**
   * Whether to answer a request that passed the base checks. Return `false` to turn it away with no
   * response and no retries (logged as DECLINED with no detail), e.g. a request outside this
   * validator's scope. Return `{ decline: "<reason>" }` to do the same but carry a reason, logged
   * once at `warn` as the outcome's `detail` (e.g. a rate limit or budget exhaustion). Default:
   * accept every request.
   */
  protected async accepts(_request: VerifiedRequest): Promise<boolean | { decline: string }> {
    return true;
  }

  /**
   * Called once per response that actually landed onchain, right after `chain.respond` resolves,
   * with the block it landed in and the gas limit that was sent. Never called when the status check
   * finds the request already answered (nothing landed through this call). A subclass might use it
   * to record spend or update a rate-limit counter. If it throws, the throw is logged and swallowed:
   * the response already landed, so treating it as failed would retry and double-post. Default:
   * no-op.
   */
  protected onResponded(_response: { requestHash: Hex; score: number; txHash: Hash; blockNumber: bigint; gasLimit: bigint }): void {
    // no-op by default
  }

  /**
   * Where the evidence goes. Default: canonical JSON (sorted keys, no whitespace) as a data: URI;
   * responseHash = keccak256 of those exact bytes, so `verify` can rebuild them byte for byte from a
   * recomputed `CheckResult` via {@link buildEvidence} and get the same hash.
   */
  protected async publishEvidence(evidence: Record<string, unknown>): Promise<{ uri: string; hash: Hex }> {
    return encodeCanonicalJsonDataUri(evidence);
  }

  /**
   * One polling cycle: the next window of blocks after the cursor, up to the head. After a request
   * failed, `retryAfterMs` says how long to wait before the next cycle (`run()` does).
   */
  async pollOnce(): Promise<{ outcomes: Outcome[]; caughtUp: boolean; retryAfterMs?: number }> {
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
        const message = errorMessage(error);
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
        return { outcomes, caughtUp: false, retryAfterMs: this.options.retryDelayMs * 2 ** (failures - 1) };
      }
    }
    await cursor.save(to);
    return { outcomes, caughtUp: to >= head.number };
  }

  /**
   * Polls until `signal` aborts. Sleeps `pollIntervalMs` when caught up or after a failed poll, and
   * the growing `retryAfterMs` after a failed request; otherwise polls the next window at once.
   */
  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      let wait = 0;
      try {
        const { caughtUp, retryAfterMs } = await this.pollOnce();
        wait = retryAfterMs ?? (caughtUp ? this.options.pollIntervalMs : 0);
      } catch (error) {
        this.log("error", "poll failed", { error: errorMessage(error) });
        wait = this.options.pollIntervalMs;
      }
      if (wait > 0 && !signal?.aborted) await sleep(wait, signal);
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

    const verified: VerifiedRequest = {
      event,
      json,
      action: requestJsonToAction(json),
      gate: json.gate,
      chainId: json.chainId,
      headTimestamp,
    };
    const accepted = await this.accepts(verified);
    if (accepted !== true) return skip("DECLINED", typeof accepted === "object" ? accepted.decline : undefined);
    const result = await this.check(verified);
    if (!Number.isInteger(result.score) || result.score < 0 || result.score > 100) {
      throw new Error(`check() returned score ${result.score}; it must be an integer from 0 to 100`);
    }
    const reserved = Object.keys(result.evidence ?? {}).filter((key) => RESERVED_EVIDENCE_KEYS.includes(key));
    if (reserved.length > 0) throw new Error(`check() evidence reuses reserved keys: ${reserved.join(", ")}`);

    const evidence = await this.publishEvidence(buildEvidence({ tag, requestHash, result }));
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
      // Only the send itself is retried: once it resolves, the response has landed, whatever happens next.
      let sent: { txHash: Hash; blockNumber: bigint; gasLimit: bigint };
      try {
        sent = await chain.respond({
          requestHash,
          response: score,
          responseURI: evidence.uri,
          responseHash: evidence.hash,
          tag,
        });
      } catch (error) {
        if (attempt >= sendAttempts) throw error;
        this.log("warn", "send failed; retrying", { requestHash, attempt, error: errorMessage(error) });
        await sleep(retryDelayMs);
        continue;
      }
      const { txHash, blockNumber, gasLimit } = sent;
      this.log("info", "responded", { requestHash, score, txHash, blockNumber, gasLimit });
      this.notifyResponded({ requestHash, score, txHash, blockNumber, gasLimit });
      return { kind: "responded", requestHash, score, txHash, blockNumber };
    }
  }

  /** Calls the subclass's `onResponded`, swallowing a throw: the response already landed. */
  private notifyResponded(response: { requestHash: Hex; score: number; txHash: Hash; blockNumber: bigint; gasLimit: bigint }): void {
    try {
      this.onResponded(response);
    } catch (error) {
      this.log("error", "onResponded threw; the response already landed and was not retried", {
        requestHash: response.requestHash,
        error: errorMessage(error),
      });
    }
  }

  /**
   * Logs one entry through the configured logger. Never throws: a logger that fails must not turn a
   * landed response into a retry, or a skip into a failed cycle. The entry is dropped, with a
   * minimal note on stderr (our own fixed message and the request hash, nothing else from it).
   */
  private log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown>): void {
    const entry: Record<string, unknown> = { level, msg, validator: this.options.tag };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      entry[key] = typeof value === "string" && value.length > 200 ? `${value.slice(0, 200)}…` : value;
    }
    try {
      this.options.log(entry);
    } catch (error) {
      try {
        const request = typeof fields.requestHash === "string" ? ` (request ${fields.requestHash})` : "";
        console.error(`${this.options.tag}: the logger threw (${errorMessage(error)}); dropped a ${level} line "${msg}"${request}`);
      } catch {
        // Nothing left to report to; the validator carries on regardless.
      }
    }
  }
}

/**
 * An error for logs and outcomes. viem's full message includes request details such as the RPC
 * URL, which can carry an API key; its shortMessage doesn't.
 */
function errorMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
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
