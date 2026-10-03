/**
 * Maps `items` through `fn` with at most `limit` calls in flight, resolving to the results in
 * `items` order (never completion order), so the output is deterministic. Rejects with the first
 * failure, and starts no new call after it.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`concurrency must be a positive integer, got ${limit}`);
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** What {@link concurrencyLimit} returns: wraps one task, run through that limiter's budget. */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * A limiter: wraps tasks so at most `limit` run at once, starting the waiting ones first-in,
 * first-out. A task's slot is freed when it settles, whether it resolves or rejects. Wrap single
 * requests, never a task that itself waits on the same limiter, or it can deadlock.
 */
export function concurrencyLimit(limit: number): Limiter {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`concurrency must be a positive integer, got ${limit}`);
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next(); // the slot passes straight to the next task
    else active--;
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}
