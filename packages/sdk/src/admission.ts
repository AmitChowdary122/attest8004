import type { Hex } from "viem";

/**
 * Options for {@link Admission}. All fields but `maxGasPerReport` are required: the defaults (20
 * requests/agent/hour, a 10,000,000 gas/day budget, 400,000 gas/response) live in the validator's
 * config, not here.
 */
export interface AdmissionOptions {
  /** Requests admitted for one agent within `agentWindowSeconds` before it is `RATE_LIMITED`. */
  maxRequestsPerAgent: number;
  /** The rate-limit window, in seconds. */
  agentWindowSeconds: bigint;
  /** Total gas — reservations plus settled limits, summed across every agent — admitted within the trailing 24 h. */
  dailyGasBudget: bigint;
  /** Gas reserved by every admission against the daily budget, until `settle` replaces it. */
  maxGasPerResponse: bigint;
  /**
   * Gas also reserved by every admission for the request's operator report (P7), until `settleReport`
   * replaces it. Default 0n: a validator that posts no reports.
   */
  maxGasPerReport?: bigint;
}

interface AdmittedEntry {
  agentId: bigint;
  /** The time passed to `admit`. Unchanged by `settle`, so both windows age it the same way. */
  admittedAt: bigint;
  /** `maxGasPerResponse` until `settle` replaces it with the gas limit actually sent, or `release` with 0. */
  responseGas: bigint;
  /** `maxGasPerReport` until `settleReport` replaces it with the report's gas limit (0 when none was sent), or `release` with 0. */
  reportGas: bigint;
}

/** The daily gas budget's window, fixed at 24 h; unlike `agentWindowSeconds`, not configurable. */
const DAILY_WINDOW_SECONDS = 86_400n;

/**
 * An in-memory admission gate for a validator's `accepts()`: a per-agent rate limit, plus one
 * daily gas budget shared across every agent this validator serves.
 *
 * - `admit` counts an agent's admissions with time in `(now − agentWindowSeconds, now]`; at
 *   `maxRequestsPerAgent` the next request is declined with `RATE_LIMITED`.
 * - Every admission reserves `maxGasPerResponse + maxGasPerReport` against the daily budget (the
 *   response, then its operator report). `admit` sums every reservation and settled limit — any
 *   agent — with time in `(now − 86,400, now]`; if that sum plus the per-request reservation would
 *   exceed `dailyGasBudget`, the request is declined with
 *   `GAS_BUDGET_EXHAUSTED`. The budget is global on purpose: it protects the validator's own gas
 *   spend, while the rate limit above is what keeps one agent from crowding out the others.
 * - `admit` is idempotent per `requestHash`: admitting a hash that is already recorded returns
 *   `{ ok: true }` without counting or reserving again, so a retried request is never double
 *   counted. A hash that was declined is never recorded, so retrying it is evaluated fresh
 *   (and may now succeed, e.g. once the window has moved on).
 * - `settle` replaces a request's response reservation with the gas limit actually sent (its report
 *   reservation stays until `settleReport` replaces it, with 0 when no report was sent), keeping the
 *   request's original admission time for both windows (settling doesn't "renew" it). Settling an
 *   unknown `requestHash` is a no-op: a caller only ever settles a hash it just admitted, so an
 *   unknown one means that request was declined — there is nothing to reconcile.
 * - `release` drops a request's gas reservations (it then counts 0 gas) when no response will be sent
 *   for it: a decline from `check()`, or a request the validator gave up on. The request still counts
 *   toward its agent's rate limit for its window (it was admitted and the validator worked on it), and
 *   no other entry changes. Releasing an unknown `requestHash` is a no-op, and a released hash stays
 *   recorded, so admitting it again is still idempotent.
 * - Both windows are evaluated by filtering on time, so an aged-out entry simply stops counting;
 *   `admit` and `settle` additionally drop any entry past both windows, so the map a long-running
 *   validator holds never grows past the last 24 h of traffic.
 *
 * Everything here lives in memory and resets on restart (tracked separately). The caller supplies
 * `now` — the chain head's timestamp, a unix-seconds bigint — so admission never depends on this
 * process's wall clock.
 */
export class Admission {
  private readonly maxRequestsPerAgent: number;
  private readonly agentWindowSeconds: bigint;
  private readonly dailyGasBudget: bigint;
  private readonly maxGasPerResponse: bigint;
  private readonly maxGasPerReport: bigint;
  private readonly entries = new Map<Hex, AdmittedEntry>();

  constructor(options: AdmissionOptions) {
    const { maxRequestsPerAgent, agentWindowSeconds, dailyGasBudget, maxGasPerResponse } = options;
    const maxGasPerReport = options.maxGasPerReport ?? 0n;
    if (!Number.isInteger(maxRequestsPerAgent) || maxRequestsPerAgent <= 0) {
      throw new RangeError(`maxRequestsPerAgent must be a positive integer, got ${maxRequestsPerAgent}`);
    }
    if (agentWindowSeconds < 0n) {
      throw new RangeError(`agentWindowSeconds must be non-negative, got ${agentWindowSeconds}`);
    }
    if (dailyGasBudget < 0n) {
      throw new RangeError(`dailyGasBudget must be non-negative, got ${dailyGasBudget}`);
    }
    if (maxGasPerResponse < 0n) {
      throw new RangeError(`maxGasPerResponse must be non-negative, got ${maxGasPerResponse}`);
    }
    if (maxGasPerReport < 0n) {
      throw new RangeError(`maxGasPerReport must be non-negative, got ${maxGasPerReport}`);
    }
    if (maxGasPerResponse + maxGasPerReport > dailyGasBudget) {
      throw new RangeError(
        maxGasPerReport === 0n
          ? `maxGasPerResponse (${maxGasPerResponse}) must be at most dailyGasBudget (${dailyGasBudget})`
          : `maxGasPerResponse + maxGasPerReport (${maxGasPerResponse} + ${maxGasPerReport}) must be at most dailyGasBudget (${dailyGasBudget})`,
      );
    }
    this.maxRequestsPerAgent = maxRequestsPerAgent;
    this.agentWindowSeconds = agentWindowSeconds;
    this.dailyGasBudget = dailyGasBudget;
    this.maxGasPerResponse = maxGasPerResponse;
    this.maxGasPerReport = maxGasPerReport;
  }

  /**
   * Admits or declines one request. Idempotent per `requestHash` (see class doc). On decline,
   * `detail` is one line naming the agent, the reason, the counters and the limit — the base logs
   * it as a single `warn` line.
   */
  admit(r: {
    requestHash: Hex;
    agentId: bigint;
    now: bigint;
  }): { ok: true } | { ok: false; reason: "RATE_LIMITED" | "GAS_BUDGET_EXHAUSTED"; detail: string } {
    const { requestHash, agentId, now } = r;
    this.prune(now);
    if (this.entries.has(requestHash)) return { ok: true };

    const requestCount = this.countForAgent(agentId, now);
    if (requestCount >= this.maxRequestsPerAgent) {
      return {
        ok: false,
        reason: "RATE_LIMITED",
        detail: `agent ${agentId} RATE_LIMITED (${requestCount}/${this.maxRequestsPerAgent} requests in the last ${this.agentWindowSeconds} s)`,
      };
    }

    const reserved = this.dailyGasSum(now);
    const perRequest = this.maxGasPerResponse + this.maxGasPerReport;
    if (reserved + perRequest > this.dailyGasBudget) {
      return {
        ok: false,
        reason: "GAS_BUDGET_EXHAUSTED",
        detail: `agent ${agentId} GAS_BUDGET_EXHAUSTED (${formatGas(reserved)} + ${formatGas(perRequest)} > ${formatGas(this.dailyGasBudget)} gas in the last 24 h)`,
      };
    }

    this.entries.set(requestHash, { agentId, admittedAt: now, responseGas: this.maxGasPerResponse, reportGas: this.maxGasPerReport });
    return { ok: true };
  }

  /**
   * Replaces `requestHash`'s response reservation with the gas limit actually sent; its report
   * reservation stays. A no-op for an unknown `requestHash` (see class doc).
   */
  settle(r: { requestHash: Hex; gasLimit: bigint; now: bigint }): void {
    const { requestHash, gasLimit, now } = r;
    this.prune(now);
    const entry = this.entries.get(requestHash);
    if (!entry) return;
    entry.responseGas = gasLimit;
  }

  /**
   * Replaces `requestHash`'s report reservation with the report's gas limit, or 0n when no report was
   * sent. A post that failed in an unknown state is never settled, so its reservation stays (fail
   * closed). A no-op for an unknown `requestHash`.
   */
  settleReport(r: { requestHash: Hex; gasLimit: bigint; now: bigint }): void {
    const { requestHash, gasLimit, now } = r;
    this.prune(now);
    const entry = this.entries.get(requestHash);
    if (!entry) return;
    entry.reportGas = gasLimit;
  }

  /**
   * Drops `requestHash`'s gas reservation: no response will be sent for it (see class doc). Its
   * admission time and its place in its agent's rate-limit count are unchanged, as is every other
   * entry. A no-op for an unknown `requestHash`.
   */
  release(requestHash: Hex): void {
    const entry = this.entries.get(requestHash);
    if (!entry) return;
    entry.responseGas = 0n;
    entry.reportGas = 0n;
  }

  private countForAgent(agentId: bigint, now: bigint): number {
    const since = now - this.agentWindowSeconds;
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.agentId === agentId && entry.admittedAt > since) count++;
    }
    return count;
  }

  private dailyGasSum(now: bigint): bigint {
    const since = now - DAILY_WINDOW_SECONDS;
    let sum = 0n;
    for (const entry of this.entries.values()) {
      if (entry.admittedAt > since) sum += entry.responseGas + entry.reportGas;
    }
    return sum;
  }

  /** Drops entries past both windows; never affects a count or sum (those filter by time themselves). */
  private prune(now: bigint): void {
    const widestWindow = this.agentWindowSeconds > DAILY_WINDOW_SECONDS ? this.agentWindowSeconds : DAILY_WINDOW_SECONDS;
    const since = now - widestWindow;
    for (const [hash, entry] of this.entries) {
      if (entry.admittedAt <= since) this.entries.delete(hash);
    }
  }
}

/** Formats a non-negative bigint with comma thousands separators, deterministically (not `toLocaleString`). */
function formatGas(value: bigint): string {
  const digits = value.toString();
  let result = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) result += ",";
    result += digits[i];
  }
  return result;
}
