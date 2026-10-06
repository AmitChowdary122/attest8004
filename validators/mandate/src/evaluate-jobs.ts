import { BaseError, type Hex } from "viem";
import type { EvaluateOutcome } from "./evaluate.ts";
import { PIN_LAG_BLOCKS } from "./validator.ts";

/**
 * What `/evaluate` answers for a (requestHash, pin) right now: the final outcome; `pending` while it is still being
 * worked out; `unavailable` when a read failed or the pin didn't finalize in time (never a verdict, and not
 * remembered: a later call starts again); or `busy` when too many evaluations are already waiting.
 */
export type JobView = EvaluateOutcome | { status: "pending" } | { status: "unavailable" } | { status: "busy" };

const PENDING: JobView = { status: "pending" };
const UNAVAILABLE: JobView = { status: "unavailable" };
const BUSY: JobView = { status: "busy" };

export interface EvaluateJobsOptions {
  /** One evaluation (`evaluateAtPin`, bound to its reader and allowlist). */
  evaluate: (requestHash: Hex, pinnedBlock: bigint) => Promise<EvaluateOutcome>;
  /** The reader's finalized head number. */
  finalized: () => Promise<bigint>;
  /** How far the finalized head must be past the pin before reading at it. Default `PIN_LAG_BLOCKS` (5), as validator A. */
  pinLagBlocks?: bigint;
  /** How long a job waits for that before it gives up as `unavailable`. Default 60,000 ms. */
  finalityTimeoutMs?: number;
  /** How often it re-reads the finalized head meanwhile. Default 500 ms. */
  pollMs?: number;
  /** Evaluations running or waiting at once; a new key beyond this is `busy`. Default 4. */
  maxQueued?: number;
  /**
   * How far above the finalized head a pin may be (default 600 blocks, about 3 minutes, well past the finality wait):
   * a higher one is unavailable at once, without a queue slot (P12, AUD-11).
   */
  maxPinAheadBlocks?: number;
  /** Final outcomes remembered, least recently used first out. Default 32. */
  maxCached?: number;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * The `/evaluate` long-poll (P11, ARCHITECTURE §5.8). A mandate-v1 evaluation takes ~13 s on the public RPC and a CRE
 * HTTP call is cut at 10 s, so a call starts (or joins) the one job for its (requestHash, pin), waits up to `holdMs`
 * for it, and otherwise answers `pending`; the workflow asks again. Jobs run one at a time, each first waiting until
 * the finalized head is `pinLagBlocks` past the pin. Final outcomes (done or declined) are remembered, so every caller,
 * and every CRE node, gets the same answer for the same key; failures are not.
 */
export class EvaluateJobs {
  private readonly evaluate: EvaluateJobsOptions["evaluate"];
  private readonly finalized: EvaluateJobsOptions["finalized"];
  private readonly pinLagBlocks: bigint;
  private readonly finalityTimeoutMs: number;
  private readonly pollMs: number;
  private readonly maxQueued: number;
  private readonly maxPinAheadBlocks: bigint;
  private readonly maxCached: number;
  private readonly log: (entry: Record<string, unknown>) => void;
  private readonly jobs = new Map<string, Promise<JobView>>();
  private readonly cache = new Map<string, EvaluateOutcome>();
  private tail: Promise<void> = Promise.resolve();

  constructor(o: EvaluateJobsOptions) {
    this.evaluate = o.evaluate;
    this.finalized = o.finalized;
    this.pinLagBlocks = o.pinLagBlocks ?? PIN_LAG_BLOCKS;
    this.finalityTimeoutMs = o.finalityTimeoutMs ?? 60_000;
    this.pollMs = o.pollMs ?? 500;
    this.maxQueued = o.maxQueued ?? 4;
    this.maxPinAheadBlocks = BigInt(o.maxPinAheadBlocks ?? 600);
    this.maxCached = o.maxCached ?? 32;
    this.log = o.log ?? (() => {});
  }

  /** The answer for (requestHash, pinnedBlock), waiting at most `holdMs` for a job in progress. */
  async view(requestHash: Hex, pinnedBlock: bigint, holdMs: number): Promise<JobView> {
    const hash = requestHash.toLowerCase() as Hex;
    const key = `${hash}:${pinnedBlock}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    let job = this.jobs.get(key);
    if (job === undefined) {
      // A pin that can't finalize within the job's wait would only hold a queue slot (P12, AUD-11): refused at once.
      if (pinnedBlock > (await this.finalized()) + this.maxPinAheadBlocks) return UNAVAILABLE;
      if (this.jobs.size >= this.maxQueued) return BUSY;
      job = this.start(key, hash, pinnedBlock);
    }
    return hold(job, holdMs);
  }

  private start(key: string, requestHash: Hex, pinnedBlock: bigint): Promise<JobView> {
    const run = async (): Promise<JobView> => {
      try {
        if (!(await this.waitForFinality(pinnedBlock))) {
          this.log({ level: "warn", msg: "pin not final in time", requestHash, pinnedBlock, timeoutMs: this.finalityTimeoutMs });
          return UNAVAILABLE;
        }
        const outcome = await this.evaluate(requestHash, pinnedBlock);
        this.remember(key, outcome);
        this.log({ level: "info", msg: "evaluated", requestHash, pinnedBlock, status: outcome.status });
        return outcome;
      } catch (error) {
        this.log({ level: "error", msg: "evaluation failed; not remembered", requestHash, pinnedBlock, error: errorMessage(error) });
        return UNAVAILABLE;
      } finally {
        this.jobs.delete(key);
      }
    };
    const job = this.tail.then(run);
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    this.jobs.set(key, job);
    return job;
  }

  private async waitForFinality(pinnedBlock: bigint): Promise<boolean> {
    const giveUpAt = Date.now() + this.finalityTimeoutMs;
    for (;;) {
      if ((await this.finalized()) >= pinnedBlock + this.pinLagBlocks) return true;
      if (Date.now() >= giveUpAt) return false;
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  private remember(key: string, outcome: EvaluateOutcome): void {
    this.cache.set(key, outcome);
    while (this.cache.size > this.maxCached) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
  }
}

/** `job`'s answer if it settles within `ms`, else `pending`; the timer never outlives the race. */
function hold(job: Promise<JobView>, ms: number): Promise<JobView> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<JobView>((resolve) => {
    timer = setTimeout(() => resolve(PENDING), ms);
  });
  return Promise.race([job, timeout]).finally(() => clearTimeout(timer));
}

/** viem's short message only: the full one can carry the RPC URL. */
function errorMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}
