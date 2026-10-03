/** No block in the searched range has a timestamp at or after the one asked for. */
export class NoBlockAtOrAfterError extends Error {
  readonly timestamp: bigint;
  readonly hi: bigint;

  constructor(timestamp: bigint, hi: bigint, hiTimestamp: bigint) {
    super(`no block at or before ${hi} has a timestamp >= ${timestamp} (block ${hi} has ${hiTimestamp})`);
    this.name = "NoBlockAtOrAfterError";
    this.timestamp = timestamp;
    this.hi = hi;
  }
}

/**
 * The smallest block number `n` in `[lo, hi]` with `getTs(n) >= timestamp`, for timestamps that never
 * decrease with the block number. It reads `hi`, then `lo`, then probes strictly between them, so it
 * never reads a block outside `[lo, hi]` or the same block twice.
 *
 * Each probe interpolates where `timestamp` falls between the two ends (Monad makes a block about
 * every 0.305 s, so block numbers are close to linear in time); an interpolation probe that fails to
 * at least halve the range is followed by a plain bisection, so an uneven block rate costs at most
 * about twice a binary search.
 *
 * Returns `lo` when `lo` itself qualifies. Throws {@link NoBlockAtOrAfterError} when no block up to
 * `hi` qualifies (`getTs(hi) < timestamp`), and `RangeError` when `lo` is negative or above `hi`.
 */
export async function firstBlockAtOrAfter(
  getTs: (n: bigint) => Promise<bigint>,
  timestamp: bigint,
  hi: bigint,
  lo: bigint = 0n,
): Promise<bigint> {
  if (lo < 0n || lo > hi) throw new RangeError(`firstBlockAtOrAfter: need 0 <= lo <= hi, got lo ${lo}, hi ${hi}`);
  let tsHi = await getTs(hi);
  if (tsHi < timestamp) throw new NoBlockAtOrAfterError(timestamp, hi, tsHi);
  if (lo === hi) return hi;
  let tsLo = await getTs(lo);
  if (tsLo >= timestamp) return lo;

  // Invariant: getTs(lo) < timestamp <= getTs(hi), so the answer is in (lo, hi] and tsHi > tsLo.
  let interpolate = true;
  while (hi - lo > 1n) {
    const width = hi - lo;
    // Interpolation aims half a second early, at the boundary between the last block before
    // `timestamp` and the first at it, rather than at the middle of the blocks that share it.
    let probe = interpolate
      ? lo + ((2n * (timestamp - tsLo) - 1n) * width) / (2n * (tsHi - tsLo))
      : lo + width / 2n;
    if (probe <= lo) probe = lo + 1n;
    if (probe >= hi) probe = hi - 1n;
    const tsProbe = await getTs(probe);
    if (tsProbe >= timestamp) {
      hi = probe;
      tsHi = tsProbe;
    } else {
      lo = probe;
      tsLo = tsProbe;
    }
    interpolate = !interpolate || (hi - lo) * 2n <= width;
  }
  return hi;
}

/**
 * Monad makes about 3.3 blocks a second. `blocksWithTimestamp` starts its search as if the chain never
 * made more than this many, which puts the start near the answer; it checks that start before using
 * it, and searches from block 0 if the chain ever ran faster.
 */
const ASSUMED_MAX_BLOCKS_PER_SECOND = 10n;

/**
 * The blocks at or before `notAfter` whose timestamp is exactly `timestamp`, as an inclusive range:
 * the first block at or after `timestamp`, through the block before the first one after it (or
 * `notAfter`). Monad puts 1-4 blocks in a second, so the range is a handful of blocks. `null` when no
 * block at or before `notAfter` carries that timestamp. It never reads a block above `notAfter`, reads
 * each block at most once, and a failed lookup throws.
 */
export async function blocksWithTimestamp(
  readTs: (n: bigint) => Promise<bigint>,
  timestamp: bigint,
  notAfter: bigint,
): Promise<{ fromBlock: bigint; toBlock: bigint } | null> {
  const known = new Map<bigint, bigint>();
  const getTs = async (n: bigint): Promise<bigint> => {
    const cached = known.get(n);
    if (cached !== undefined) return cached;
    const ts = await readTs(n);
    known.set(n, ts);
    return ts;
  };

  const tsTop = await getTs(notAfter);
  if (tsTop < timestamp) return null;

  const reach = (tsTop - timestamp + 1n) * ASSUMED_MAX_BLOCKS_PER_SECOND;
  let lo = notAfter > reach ? notAfter - reach : 0n;
  if (lo > 0n && (await getTs(lo)) >= timestamp) lo = 0n;

  const fromBlock = await firstBlockAtOrAfter(getTs, timestamp, notAfter, lo);
  if ((await getTs(fromBlock)) !== timestamp) return null;
  if (fromBlock === notAfter) return { fromBlock, toBlock: notAfter };
  try {
    const next = await firstBlockAtOrAfter(getTs, timestamp + 1n, notAfter, fromBlock + 1n);
    return { fromBlock, toBlock: next - 1n };
  } catch (error) {
    if (error instanceof NoBlockAtOrAfterError) return { fromBlock, toBlock: notAfter };
    throw error;
  }
}
