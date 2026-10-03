/**
 * A client-side rate limiter for the free tier (P5 plan Decision 5): a sliding 60 s window for
 * requests and one for tokens. `acquire(estimatedTokens)` waits until both a request slot and that
 * many tokens fit in the next 60 s; `observe(headers)` folds in the provider's own
 * `x-ratelimit-remaining-tokens`/`x-ratelimit-reset-tokens`, since the provider's count is more
 * authoritative than our own estimate (several turns' estimates can drift). `now`/`sleep` are
 * injectable so tests never wait on a real clock.
 */

/**
 * Thrown by `acquire()` when a single call's estimated tokens can never fit within the per-minute
 * token budget — not a transient capacity squeeze that waiting resolves, so `acquire()` throws
 * immediately instead of looping on 60 s sleeps forever (fix round 1, finding 2: previously this
 * left `check()` never settling and the cursor stalled with no log). `kind: "transient"` mirrors
 * {@link import("./llm.ts").ProviderError}'s own field, so a caller that duck-types on `.kind` (the
 * agent loop, `check()`) treats this exactly like a provider failure: no response, retried from
 * scratch in a later cycle.
 */
export class TokenBudgetExceededError extends Error {
  readonly kind: "transient" = "transient";
  readonly estimatedTokens: number;
  readonly tokensPerMinute: number;

  constructor(estimatedTokens: number, tokensPerMinute: number) {
    super(`estimated ${estimatedTokens} tokens exceeds the ${tokensPerMinute}/minute budget; this call can never be paced`);
    this.name = "TokenBudgetExceededError";
    this.estimatedTokens = estimatedTokens;
    this.tokensPerMinute = tokensPerMinute;
  }
}

export class RatePacer {
  private readonly requestsPerMinute: number;
  private readonly tokensPerMinute: number;
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private requestTimestamps: number[] = [];
  private tokenEvents: { time: number; tokens: number }[] = [];
  /** Set by `observe()`: while `now < resetAt`, this many tokens (not the sliding window) gates `acquire`. */
  private tokenOverride: { remaining: number; resetAt: number } | null = null;

  constructor(o: { requestsPerMinute: number; tokensPerMinute: number; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
    this.requestsPerMinute = o.requestsPerMinute;
    this.tokensPerMinute = o.tokensPerMinute;
    this.nowFn = o.now ?? Date.now;
    this.sleepFn = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Waits until a request slot and `estimatedTokens` both fit in the next 60 s, then reserves them.
   * Throws {@link TokenBudgetExceededError} immediately (no waiting) if `estimatedTokens` alone
   * exceeds `tokensPerMinute`, since no amount of waiting would ever make it fit.
   */
  async acquire(estimatedTokens: number): Promise<void> {
    if (estimatedTokens > this.tokensPerMinute) {
      throw new TokenBudgetExceededError(estimatedTokens, this.tokensPerMinute);
    }
    for (;;) {
      const now = this.nowFn();
      this.prune(now);

      const requestsUsed = this.requestTimestamps.length;
      const tokenCap = this.tokenCapacity(now);
      const requestsFit = requestsUsed < this.requestsPerMinute;
      const tokensFit = estimatedTokens <= tokenCap;

      if (requestsFit && tokensFit) {
        this.requestTimestamps.push(now);
        this.tokenEvents.push({ time: now, tokens: estimatedTokens });
        // Fix round 1, finding 5: decrement the override itself (not just the sliding-window
        // estimate), so a second acquire inside the same override window can't pass against the
        // same flat `remaining` the first one already spent.
        if (this.tokenOverride !== null && now < this.tokenOverride.resetAt) {
          this.tokenOverride.remaining -= estimatedTokens;
        }
        return;
      }

      const waits: number[] = [];
      if (!requestsFit) {
        const oldest = this.requestTimestamps[0] ?? now;
        waits.push(Math.max(1, oldest + 60_000 - now));
      }
      if (!tokensFit) {
        if (this.tokenOverride !== null) {
          waits.push(Math.max(1, this.tokenOverride.resetAt - now));
        } else {
          const oldest = this.tokenEvents[0]?.time ?? now;
          waits.push(Math.max(1, oldest + 60_000 - now));
        }
      }
      await this.sleepFn(Math.min(...waits));
    }
  }

  /**
   * Lowers the token allowance to `x-ratelimit-remaining-tokens` until `x-ratelimit-reset-tokens`
   * elapses (Groq's duration strings: "250ms", "7.66s", "2m59.56s"). Missing or unparseable headers
   * leave the pacer's own sliding-window estimate as the only gate.
   */
  observe(headers: Headers): void {
    const remainingRaw = headers.get("x-ratelimit-remaining-tokens");
    const resetRaw = headers.get("x-ratelimit-reset-tokens");
    if (remainingRaw === null || resetRaw === null) return;
    const remaining = Number(remainingRaw);
    const resetMs = parseGroqDuration(resetRaw);
    if (!Number.isFinite(remaining) || resetMs === null) return;
    this.tokenOverride = { remaining, resetAt: this.nowFn() + resetMs };
  }

  /** How many tokens may be used right now: the provider's override while it's live, else the sliding window's room. */
  private tokenCapacity(now: number): number {
    if (this.tokenOverride !== null) {
      if (now < this.tokenOverride.resetAt) return this.tokenOverride.remaining;
      this.tokenOverride = null;
    }
    const used = this.tokenEvents.reduce((sum, event) => sum + event.tokens, 0);
    return this.tokensPerMinute - used;
  }

  private prune(now: number): void {
    const cutoff = now - 60_000;
    this.requestTimestamps = this.requestTimestamps.filter((t) => t > cutoff);
    this.tokenEvents = this.tokenEvents.filter((e) => e.time > cutoff);
  }
}

/**
 * Parses Groq's rate-limit duration strings: plain milliseconds ("250ms") or seconds with an
 * optional minutes prefix ("7.66s", "2m59.56s"). Returns `null` for anything else, so a caller can
 * fall back instead of mis-scheduling a wait.
 */
export function parseGroqDuration(text: string): number | null {
  const trimmed = text.trim();
  const msMatch = /^(\d+(?:\.\d+)?)ms$/.exec(trimmed);
  if (msMatch?.[1] !== undefined) return Number(msMatch[1]);
  const combined = /^(?:(\d+)m)?(\d+(?:\.\d+)?)s$/.exec(trimmed);
  if (combined?.[2] !== undefined) {
    const minutes = combined[1] !== undefined ? Number(combined[1]) : 0;
    return minutes * 60_000 + Number(combined[2]) * 1000;
  }
  return null;
}
