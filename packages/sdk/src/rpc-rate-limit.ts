// A fetch for viem's http transport that keeps one process (or one page) under the public Monad testnet RPC's per-IP
// rate limit. Browser-safe: it uses only fetch, Response and setTimeout.
// Measured on 5 Oct 2026: past 15 requests a second the node answers JSON-RPC error -32011, "requests limited to
// 15/sec", which viem doesn't retry. The e2e runs both validators in-process next to its own reads, all through
// common.ts's clients, so their bursts add up; every request now waits for a slot, and a refused one is retried.

/** The public Monad testnet RPC's per-IP limit, in requests a second (measured 5 Oct 2026). */
export const PUBLIC_RPC_REQUESTS_PER_SECOND = 15;

/**
 * A requests-per-second setting (e.g. from the environment): an integer from 1 to
 * {@link PUBLIC_RPC_REQUESTS_PER_SECOND}, or the problem, naming the setting.
 */
export function parseRequestsPerSecond(value: string, name: string): { ok: true; value: number } | { ok: false; problem: string } {
  if (!/^[1-9][0-9]?$/.test(value) || Number(value) > PUBLIC_RPC_REQUESTS_PER_SECOND) {
    return { ok: false, problem: `${name} must be an integer from 1 to ${PUBLIC_RPC_REQUESTS_PER_SECOND}, got "${value}"` };
  }
  return { ok: true, value: Number(value) };
}

/** JSON-RPC error code the public Monad testnet RPC returns when a client exceeds its request rate. */
export const RATE_LIMITED_CODE = -32011;

export interface RateLimitedFetchOptions {
  /** At most this many requests start in any one-second window. */
  requestsPerSecond: number;
  /** How many times a request refused for the rate limit (-32011, or HTTP 429) is sent again. */
  retries: number;
  /** The wait before the first retry; it doubles each time. */
  retryDelayMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function rateLimitedFetch(options: RateLimitedFetchOptions): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const starts: number[] = [];
  let queue: Promise<void> = Promise.resolve();

  // Requests take slots one at a time, so concurrent callers can't all see a free window at once.
  const slot = (): Promise<void> => {
    const turn = queue.then(async () => {
      for (;;) {
        const t = now();
        while (starts.length > 0 && (starts[0] as number) <= t - 1000) starts.shift();
        if (starts.length < options.requestsPerSecond) {
          starts.push(t);
          return;
        }
        await sleep((starts[0] as number) + 1000 - t);
      }
    });
    queue = turn.catch(() => undefined);
    return turn;
  };

  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      await slot();
      const response = await fetchImpl(input, init);
      if (attempt >= options.retries || !(await refusedForRateLimit(response))) return response;
      await sleep(options.retryDelayMs * 2 ** attempt);
    }
  };
}

/** Whether the node refused the request (or any entry of a batch) for the rate limit. Reads a clone, never the body. */
async function refusedForRateLimit(response: Response): Promise<boolean> {
  if (response.status === 429) return true;
  let body: unknown;
  try {
    body = JSON.parse(await response.clone().text());
  } catch {
    return false;
  }
  const entries = Array.isArray(body) ? body : [body];
  return entries.some((entry) => (entry as { error?: { code?: unknown } } | null)?.error?.code === RATE_LIMITED_CODE);
}
