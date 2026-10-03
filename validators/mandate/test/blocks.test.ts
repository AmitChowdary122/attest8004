import { describe, expect, it } from "vitest";
import { blocksWithTimestamp, firstBlockAtOrAfter, NoBlockAtOrAfterError } from "../src/blocks.ts";

const BASE_TS = 1_700_000_000;

/** A deterministic PRNG (mulberry32), so a failing case can be replayed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Synthetic block timestamps: each second holds `blocksInSecond()` blocks (Monad: 1-4 blocks share a
 * second). Offsets from BASE_TS, in a typed array so 10M blocks stay cheap.
 */
function syntheticChain(blocks: number, blocksInSecond: (second: number) => number): Uint32Array {
  const offsets = new Uint32Array(blocks);
  let second = 0;
  let left = blocksInSecond(0);
  for (let n = 0; n < blocks; n++) {
    while (left === 0) {
      second++;
      left = blocksInSecond(second);
    }
    offsets[n] = second;
    left--;
  }
  return offsets;
}

/** A counting `getTs` over a synthetic chain. */
function lookups(offsets: Uint32Array) {
  const counter = { count: 0 };
  const getTs = async (n: bigint): Promise<bigint> => {
    counter.count++;
    const offset = offsets[Number(n)];
    if (offset === undefined) throw new RangeError(`block ${n} does not exist`);
    return BigInt(BASE_TS + offset);
  };
  return { getTs, counter };
}

/** The reference answer by plain binary search over the array. */
function expected(offsets: Uint32Array, timestamp: bigint): bigint {
  const target = Number(timestamp) - BASE_TS;
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((offsets[mid] as number) >= target) hi = mid;
    else lo = mid + 1;
  }
  return BigInt(lo);
}

const TEN_MILLION = 10_000_000;

describe("firstBlockAtOrAfter", () => {
  it("finds the first block at or after t in at most 25 lookups over 10M blocks with 1-4 blocks a second", async () => {
    const random = prng(42);
    const offsets = syntheticChain(TEN_MILLION, () => 1 + Math.floor(random() * 4));
    const last = offsets[TEN_MILLION - 1] as number;
    const hi = BigInt(TEN_MILLION - 1);
    const pick = prng(7);
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      const timestamp = BigInt(BASE_TS + Math.floor(pick() * (last + 1)));
      const { getTs, counter } = lookups(offsets);
      await expect(firstBlockAtOrAfter(getTs, timestamp, hi)).resolves.toBe(expected(offsets, timestamp));
      worst = Math.max(worst, counter.count);
    }
    expect(worst).toBeLessThanOrEqual(25);
  });

  it("stays within 25 lookups when the block rate changes part-way (1-2 a second, then 3-4)", async () => {
    const random = prng(1_234);
    const half = Math.floor(TEN_MILLION / 2 / 1.5); // seconds in the slow half, roughly
    const offsets = syntheticChain(TEN_MILLION, (second) =>
      second < half ? 1 + Math.floor(random() * 2) : 3 + Math.floor(random() * 2),
    );
    const last = offsets[TEN_MILLION - 1] as number;
    const hi = BigInt(TEN_MILLION - 1);
    const pick = prng(99);
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      const timestamp = BigInt(BASE_TS + Math.floor(pick() * (last + 1)));
      const { getTs, counter } = lookups(offsets);
      await expect(firstBlockAtOrAfter(getTs, timestamp, hi)).resolves.toBe(expected(offsets, timestamp));
      worst = Math.max(worst, counter.count);
    }
    expect(worst).toBeLessThanOrEqual(25);
  });

  it("returns the first of the blocks that share a second, not just any of them", async () => {
    // seconds 0..: 4 blocks, then 1, then 3, ...
    const pattern = [4, 1, 3, 2];
    const offsets = syntheticChain(1_000, (second) => pattern[second % pattern.length] as number);
    const { getTs } = lookups(offsets);
    for (let second = 0; second < 300; second++) {
      const timestamp = BigInt(BASE_TS + second);
      const block = await firstBlockAtOrAfter(getTs, timestamp, 999n);
      expect(block).toBe(expected(offsets, timestamp));
      expect(await getTs(block)).toBe(timestamp);
      if (block > 0n) expect(await getTs(block - 1n)).toBeLessThan(timestamp);
    }
  });

  it("returns block 0 (or lo) when it already qualifies", async () => {
    const offsets = syntheticChain(100, () => 2);
    const { getTs } = lookups(offsets);
    await expect(firstBlockAtOrAfter(getTs, BigInt(BASE_TS - 50), 99n)).resolves.toBe(0n);
    await expect(firstBlockAtOrAfter(getTs, BigInt(BASE_TS), 99n)).resolves.toBe(0n);
    await expect(firstBlockAtOrAfter(getTs, BigInt(BASE_TS), 99n, 40n)).resolves.toBe(40n);
  });

  it("searches only [lo, hi] when lo is given", async () => {
    const offsets = syntheticChain(1_000, () => 3);
    const { getTs } = lookups(offsets);
    const timestamp = BigInt(BASE_TS + 200);
    await expect(firstBlockAtOrAfter(getTs, timestamp, 999n, 300n)).resolves.toBe(600n);
    await expect(firstBlockAtOrAfter(getTs, timestamp, 999n, 600n)).resolves.toBe(600n);
    await expect(firstBlockAtOrAfter(getTs, timestamp, 999n, 601n)).resolves.toBe(601n);
  });

  it("returns hi when only hi qualifies", async () => {
    const offsets = syntheticChain(1_000, () => 1);
    const { getTs } = lookups(offsets);
    await expect(firstBlockAtOrAfter(getTs, BigInt(BASE_TS + 999), 999n)).resolves.toBe(999n);
    await expect(firstBlockAtOrAfter(getTs, BigInt(BASE_TS + 500), 500n)).resolves.toBe(500n);
  });

  it("throws NoBlockAtOrAfterError when no block at or before hi has a timestamp >= t", async () => {
    const offsets = syntheticChain(1_000, () => 2);
    const { getTs, counter } = lookups(offsets);
    // block 999 is in second 499
    const error = await firstBlockAtOrAfter(getTs, BigInt(BASE_TS + 500), 999n).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoBlockAtOrAfterError);
    expect((error as NoBlockAtOrAfterError).timestamp).toBe(BigInt(BASE_TS + 500));
    expect((error as NoBlockAtOrAfterError).hi).toBe(999n);
    expect(counter.count).toBe(1); // it only had to read hi
    // the block that would qualify exists, but it is above hi
    await expect(firstBlockAtOrAfter(getTs, BigInt(BASE_TS + 300), 500n)).rejects.toBeInstanceOf(NoBlockAtOrAfterError);
  });

  it("rejects a range with lo above hi, or a negative lo", async () => {
    const offsets = syntheticChain(100, () => 2);
    const { getTs } = lookups(offsets);
    await expect(firstBlockAtOrAfter(getTs, BigInt(BASE_TS), 10n, 11n)).rejects.toThrow(RangeError);
    await expect(firstBlockAtOrAfter(getTs, BigInt(BASE_TS), 10n, -1n)).rejects.toThrow(RangeError);
  });

  it("never reads a block outside [lo, hi]", async () => {
    const random = prng(5);
    const offsets = syntheticChain(100_000, () => 1 + Math.floor(random() * 4));
    const read: bigint[] = [];
    const getTs = async (n: bigint) => {
      read.push(n);
      return BigInt(BASE_TS + (offsets[Number(n)] as number));
    };
    const lo = 20_000n;
    const hi = 80_000n;
    for (const offset of [0, 7_000, 12_345, 20_000, 24_000]) {
      const timestamp = BigInt(BASE_TS + offset);
      const block = await firstBlockAtOrAfter(getTs, timestamp, hi, lo);
      const reference = expected(offsets, timestamp);
      expect(block).toBe(reference < lo ? lo : reference);
    }
    expect(read.every((n) => n >= lo && n <= hi)).toBe(true);
  });
});

describe("blocksWithTimestamp", () => {
  const random = prng(11);
  const offsets = syntheticChain(400_000, () => 1 + Math.floor(random() * 4));
  const top = BigInt(offsets.length - 1);

  it("is exactly the blocks that carry the timestamp, at or before notAfter", async () => {
    const pick = prng(3);
    for (let i = 0; i < 200; i++) {
      const block = BigInt(Math.floor(pick() * offsets.length));
      const timestamp = BigInt(BASE_TS + (offsets[Number(block)] as number));
      const { getTs, counter } = lookups(offsets);
      await expect(blocksWithTimestamp(getTs, timestamp, top)).resolves.toEqual({
        fromBlock: expected(offsets, timestamp),
        toBlock: expected(offsets, timestamp + 1n) - 1n,
      });
      expect(counter.count).toBeLessThanOrEqual(30);
    }
  });

  it("stops at notAfter when later blocks share the timestamp", async () => {
    const shared = syntheticChain(100, () => 4);
    const { getTs } = lookups(shared);
    // second 10 is blocks 40..43
    await expect(blocksWithTimestamp(getTs, BigInt(BASE_TS + 10), 41n)).resolves.toEqual({ fromBlock: 40n, toBlock: 41n });
    await expect(blocksWithTimestamp(getTs, BigInt(BASE_TS + 10), 40n)).resolves.toEqual({ fromBlock: 40n, toBlock: 40n });
    await expect(blocksWithTimestamp(getTs, BigInt(BASE_TS + 10), 99n)).resolves.toEqual({ fromBlock: 40n, toBlock: 43n });
  });

  it("is null when no block at or before notAfter carries the timestamp", async () => {
    const gappy = syntheticChain(1_000, (second) => (second % 2 === 0 ? 2 : 0)); // odd seconds have no block
    const { getTs } = lookups(gappy);
    await expect(blocksWithTimestamp(getTs, BigInt(BASE_TS + 101), 999n)).resolves.toBeNull();
    await expect(blocksWithTimestamp(getTs, BigInt(BASE_TS + 100), 999n)).resolves.toEqual({ fromBlock: 100n, toBlock: 101n });
    // later than every block up to notAfter
    await expect(blocksWithTimestamp(getTs, BigInt(BASE_TS + 100), 99n)).resolves.toBeNull();
  });

  it("never reads a block above notAfter, nor the same block twice", async () => {
    const read: bigint[] = [];
    const getTs = async (n: bigint) => {
      read.push(n);
      return BigInt(BASE_TS + (offsets[Number(n)] as number));
    };
    const notAfter = 300_000n;
    const timestamp = BigInt(BASE_TS + (offsets[250_000] as number));
    await blocksWithTimestamp(getTs, timestamp, notAfter);
    expect(read.length).toBeGreaterThan(0);
    expect(read.every((n) => n <= notAfter)).toBe(true);
    expect(new Set(read).size).toBe(read.length);
  });

  it("is still right when the chain once made far more blocks a second than Monad does", async () => {
    // 1 block a second, then 50 a second for seconds 1,000-1,099 (blocks 1,000-5,999), then 1 a second again.
    const burst = syntheticChain(7_000, (second) => (second >= 1_000 && second < 1_100 ? 50 : 1));
    const { getTs } = lookups(burst);
    // Second 1,050 is blocks 3,500-3,549. Block 6,100 is second 1,200, so a search that assumed at most
    // 10 blocks a second would start at block 4,590, already past second 1,050.
    await expect(blocksWithTimestamp(getTs, BigInt(BASE_TS + 1_050), 6_100n)).resolves.toEqual({ fromBlock: 3_500n, toBlock: 3_549n });
  });
});
