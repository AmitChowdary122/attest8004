import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { EvaluateOutcome } from "../src/evaluate.ts";
import { EvaluateJobs } from "../src/evaluate-jobs.ts";

const H1 = `0x${"11".repeat(32)}` as Hex;
const H2 = `0x${"22".repeat(32)}` as Hex;
const H3 = `0x${"33".repeat(32)}` as Hex;
const P = 1_000n;

const DONE: EvaluateOutcome = { status: "done", score: 100, reasons: [], evidence: '{"a":1}', evidenceHash: `0x${"ab".repeat(32)}` };
const DECLINED: EvaluateOutcome = { status: "declined", code: "GATE_NOT_SERVED", detail: "GATE_NOT_SERVED: nope" };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Jobs over a chain that is already final, with fast timings; `evaluate` and `finalized` can be swapped per test. */
function jobs(o: Partial<ConstructorParameters<typeof EvaluateJobs>[0]> = {}) {
  return new EvaluateJobs({
    evaluate: async () => DONE,
    finalized: async () => P + 5n,
    pollMs: 1,
    finalityTimeoutMs: 1_000,
    ...o,
  });
}

describe("EvaluateJobs: a long-poll over one memoized job per (requestHash, pin)", () => {
  it("jobs_pendingThenDone: pending while the hold expires first, then the same answer every time", async () => {
    let calls = 0;
    const j = jobs({
      evaluate: async () => {
        calls++;
        await sleep(60);
        return DONE;
      },
    });
    expect(await j.view(H1, P, 5)).toEqual({ status: "pending" });
    expect(await j.view(H1, P, 500)).toEqual(DONE);
    expect(await j.view(H1, P, 0)).toEqual(DONE);
    expect(calls).toBe(1);
  });

  it("jobs_waitsForFinality: evaluates only once finalized ≥ P + 5", async () => {
    let head = P + 3n;
    const seenAt: bigint[] = [];
    const j = jobs({
      finalized: async () => head,
      evaluate: async () => {
        seenAt.push(head);
        return DONE;
      },
    });
    expect(await j.view(H1, P, 20)).toEqual({ status: "pending" });
    expect(seenAt).toEqual([]);
    head = P + 5n;
    expect(await j.view(H1, P, 500)).toEqual(DONE);
    expect(seenAt).toEqual([P + 5n]);
  });

  it("jobs_finalityTimeoutIsUnavailable: a pin that never finalizes is unavailable, and a later view starts again", async () => {
    let finalizedCalls = 0;
    const j = jobs({
      finalityTimeoutMs: 20,
      finalized: async () => {
        finalizedCalls++;
        return P;
      },
    });
    expect(await j.view(H1, P, 500)).toEqual({ status: "unavailable" });
    const before = finalizedCalls;
    expect(await j.view(H1, P, 500)).toEqual({ status: "unavailable" });
    expect(finalizedCalls).toBeGreaterThan(before);
  });

  it("jobs_readFailureIsUnavailableAndRetries: a failed evaluation isn't cached", async () => {
    let calls = 0;
    const j = jobs({
      evaluate: async () => {
        calls++;
        if (calls === 1) throw new Error("rpc down");
        return DONE;
      },
    });
    expect(await j.view(H1, P, 500)).toEqual({ status: "unavailable" });
    expect(await j.view(H1, P, 500)).toEqual(DONE);
    expect(calls).toBe(2);
  });

  it("jobs_runsOneAtATime: two requests never evaluate concurrently", async () => {
    let running = 0;
    let most = 0;
    const j = jobs({
      evaluate: async () => {
        running++;
        most = Math.max(most, running);
        await sleep(20);
        running--;
        return DONE;
      },
    });
    const [a, b] = await Promise.all([j.view(H1, P, 500), j.view(H2, P, 500)]);
    expect(a).toEqual(DONE);
    expect(b).toEqual(DONE);
    expect(most).toBe(1);
  });

  it("P12 AUD-11: a pin too far above the finalized head is unavailable at once and takes no queue slot", async () => {
    let evaluated = 0;
    const j = jobs({ maxQueued: 1, evaluate: async () => (evaluated++, DONE) });
    expect(await j.view(H1, P + 1_000_000n, 50)).toEqual({ status: "unavailable" });
    expect(await j.view(H2, 2n ** 64n - 1n, 50)).toEqual({ status: "unavailable" });
    expect(await j.view(H3, P, 500)).toEqual(DONE);
    expect(evaluated).toBe(1);
  });

  it("jobs_busyWhenQueueFull: a third distinct request waits for room", async () => {
    const j = jobs({ maxQueued: 2, evaluate: () => new Promise<EvaluateOutcome>(() => {}) });
    expect(await j.view(H1, P, 0)).toEqual({ status: "pending" });
    expect(await j.view(H2, P, 0)).toEqual({ status: "pending" });
    expect(await j.view(H3, P, 0)).toEqual({ status: "busy" });
    expect(await j.view(H1, P, 0)).toEqual({ status: "pending" });
  });

  it("jobs_cachesDoneAndDeclined: a final answer is evaluated once per (requestHash, pin), case-insensitively", async () => {
    let calls = 0;
    const j = jobs({
      evaluate: async (h) => {
        calls++;
        return h === H2 ? DECLINED : DONE;
      },
    });
    await j.view(H1, P, 500);
    await j.view(H1.toUpperCase().replace("0X", "0x") as Hex, P, 500);
    expect(await j.view(H2, P, 500)).toEqual(DECLINED);
    expect(await j.view(H2, P, 500)).toEqual(DECLINED);
    expect(calls).toBe(2);
  });

  it("jobs_keysIncludeThePin: another pin for the same hash is another job", async () => {
    const pins: bigint[] = [];
    const j = jobs({
      finalized: async () => 10_000n,
      evaluate: async (_h, pinned) => {
        pins.push(pinned);
        return DONE;
      },
    });
    await j.view(H1, P, 500);
    await j.view(H1, P + 1n, 500);
    expect(pins).toEqual([P, P + 1n]);
  });

  it("jobs_evictsOldest: beyond maxCached, the oldest answer is evaluated again", async () => {
    const seen: Hex[] = [];
    const j = jobs({
      maxCached: 2,
      evaluate: async (h) => {
        seen.push(h);
        return DONE;
      },
    });
    for (const h of [H1, H2, H3, H1]) await j.view(h, P, 500);
    expect(seen).toEqual([H1, H2, H3, H1]);
  });
});
