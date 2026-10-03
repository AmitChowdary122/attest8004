import { describe, expect, it } from "vitest";
import { concurrencyLimit, mapWithConcurrency } from "../src/concurrency.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("concurrencyLimit", () => {
  it("runs at most `limit` tasks at once, first in first out, and frees a slot when a task fails", async () => {
    const limited = concurrencyLimit(2);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const task = (i: number) => async () => {
      started.push(i);
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
      if (i % 3 === 0) throw new Error(`task ${i} failed`);
      return i;
    };
    const results = await Promise.allSettled(Array.from({ length: 9 }, (_, i) => limited(task(i))));
    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(3);
    await expect(limited(async () => "still usable")).resolves.toBe("still usable");
  });

  it("rejects a limit that isn't a positive integer", () => {
    expect(() => concurrencyLimit(0)).toThrow(RangeError);
    expect(() => concurrencyLimit(1.5)).toThrow(RangeError);
  });
});

describe("mapWithConcurrency", () => {
  it("keeps input order, bounds calls in flight, and starts nothing after a failure", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, n));
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);

    const seen: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5], 1, async (n) => {
        seen.push(n);
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
    expect(seen).toEqual([1, 2]);
  });
});
