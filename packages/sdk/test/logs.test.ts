import { describe, expect, it } from "vitest";
import { MAX_LOG_BLOCK_RANGE, blockWindows } from "../src/index.ts";

describe("blockWindows", () => {
  it("splits a range into windows of at most 100 blocks (Monad testnet: toBlock - fromBlock <= 100)", () => {
    expect(MAX_LOG_BLOCK_RANGE).toBe(100n);
    expect(blockWindows(1n, 250n)).toEqual([
      { fromBlock: 1n, toBlock: 100n },
      { fromBlock: 101n, toBlock: 200n },
      { fromBlock: 201n, toBlock: 250n },
    ]);
  });

  it("covers every block exactly once, each window within the limit", () => {
    const windows = blockWindows(67_000_001n, 67_001_234n);
    let next = 67_000_001n;
    for (const w of windows) {
      expect(w.fromBlock).toBe(next);
      expect(w.toBlock - w.fromBlock).toBeLessThanOrEqual(99n);
      next = w.toBlock + 1n;
    }
    expect(next).toBe(67_001_235n);
  });

  it("handles a single block and an empty range", () => {
    expect(blockWindows(5n, 5n)).toEqual([{ fromBlock: 5n, toBlock: 5n }]);
    expect(blockWindows(6n, 5n)).toEqual([]);
  });

  it("takes a smaller window size, and refuses one below 1", () => {
    expect(blockWindows(1n, 5n, 2n)).toEqual([
      { fromBlock: 1n, toBlock: 2n },
      { fromBlock: 3n, toBlock: 4n },
      { fromBlock: 5n, toBlock: 5n },
    ]);
    expect(() => blockWindows(1n, 5n, 0n)).toThrow(RangeError);
  });
});
