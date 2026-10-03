import { describe, expect, it } from "vitest";
import { RatePacer, TokenBudgetExceededError } from "../src/pacer.ts";

/** A controllable clock: `sleep` advances `now` by the requested amount instead of really waiting. */
function fakeClock(start = 0) {
  let current = start;
  const sleepCalls: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
      current += ms;
    },
    sleepCalls,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function headersWith(remaining: string, resetTokens: string): Headers {
  return new Headers({ "x-ratelimit-remaining-tokens": remaining, "x-ratelimit-reset-tokens": resetTokens });
}

describe("RatePacer.acquire", () => {
  it("never sleeps when under both limits", async () => {
    const clock = fakeClock();
    const pacer = new RatePacer({ requestsPerMinute: 30, tokensPerMinute: 8_000, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 5; i++) {
      await pacer.acquire(100);
    }
    expect(clock.sleepCalls).toEqual([]);
  });

  it("waits for the next minute after 30 requests", async () => {
    const clock = fakeClock();
    const pacer = new RatePacer({ requestsPerMinute: 30, tokensPerMinute: 1_000_000, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 30; i++) {
      await pacer.acquire(10);
    }
    expect(clock.sleepCalls).toEqual([]);

    await pacer.acquire(10);
    expect(clock.sleepCalls).toEqual([60_000]);
  });

  it("waits until x-ratelimit-reset-tokens when remaining < estimate (parses \"7.66s\")", async () => {
    const clock = fakeClock();
    const pacer = new RatePacer({ requestsPerMinute: 1_000, tokensPerMinute: 1_000_000, now: clock.now, sleep: clock.sleep });
    pacer.observe(headersWith("5", "7.66s"));

    await pacer.acquire(100);
    expect(clock.sleepCalls).toEqual([7_660]);
  });

  it("waits until x-ratelimit-reset-tokens when remaining < estimate (parses \"2m59.56s\")", async () => {
    const clock = fakeClock();
    const pacer = new RatePacer({ requestsPerMinute: 1_000, tokensPerMinute: 1_000_000, now: clock.now, sleep: clock.sleep });
    pacer.observe(headersWith("5", "2m59.56s"));

    await pacer.acquire(100);
    expect(clock.sleepCalls).toEqual([179_560]);
  });

  it("parses a plain milliseconds reset (\"250ms\")", async () => {
    const clock = fakeClock();
    const pacer = new RatePacer({ requestsPerMinute: 1_000, tokensPerMinute: 1_000_000, now: clock.now, sleep: clock.sleep });
    pacer.observe(headersWith("5", "250ms"));

    await pacer.acquire(100);
    expect(clock.sleepCalls).toEqual([250]);
  });

  it("does not gate on a remaining-tokens override once estimate fits", async () => {
    const clock = fakeClock();
    const pacer = new RatePacer({ requestsPerMinute: 1_000, tokensPerMinute: 1_000_000, now: clock.now, sleep: clock.sleep });
    pacer.observe(headersWith("500", "7.66s"));

    await pacer.acquire(100);
    expect(clock.sleepCalls).toEqual([]);
  });

  it("ignores observe() when the rate-limit headers are absent", async () => {
    const clock = fakeClock();
    const pacer = new RatePacer({ requestsPerMinute: 1_000, tokensPerMinute: 1_000_000, now: clock.now, sleep: clock.sleep });
    pacer.observe(new Headers());

    await pacer.acquire(100);
    expect(clock.sleepCalls).toEqual([]);
  });

  // Fix round 1, finding 2: a single estimate that can never fit in the per-minute budget used to
  // loop on 60s sleeps forever (check() never settles, cursor stalls with no log).
  it("throws TokenBudgetExceededError instead of waiting forever when a single estimate exceeds tokensPerMinute", async () => {
    const clock = fakeClock();
    const pacer = new RatePacer({ requestsPerMinute: 30, tokensPerMinute: 8_000, now: clock.now, sleep: clock.sleep });

    await expect(pacer.acquire(8_001)).rejects.toBeInstanceOf(TokenBudgetExceededError);
    await expect(pacer.acquire(8_001)).rejects.toMatchObject({ kind: "transient", estimatedTokens: 8_001, tokensPerMinute: 8_000 });
    expect(clock.sleepCalls).toEqual([]);
  });

  it("allows an estimate exactly equal to tokensPerMinute", async () => {
    const clock = fakeClock();
    const pacer = new RatePacer({ requestsPerMinute: 30, tokensPerMinute: 8_000, now: clock.now, sleep: clock.sleep });
    await pacer.acquire(8_000);
    expect(clock.sleepCalls).toEqual([]);
  });

  // Fix round 1, finding 2 (missing test): the sliding token window across two acquires.
  it("the second of two acquires whose sum exceeds TPM waits until the first ages out of the 60s window", async () => {
    const clock = fakeClock();
    const pacer = new RatePacer({ requestsPerMinute: 1_000, tokensPerMinute: 1_000, now: clock.now, sleep: clock.sleep });

    await pacer.acquire(600);
    expect(clock.sleepCalls).toEqual([]);

    await pacer.acquire(600); // 600 + 600 > 1,000: must wait for the first 600 to age out
    expect(clock.sleepCalls).toEqual([60_000]);
  });

  // Fix round 1, finding 5: the remaining-tokens override is a flat cap unless reservations decrement it.
  it("decrements the remaining-tokens override on each reservation (fix round 1, finding 5)", async () => {
    const clock = fakeClock();
    const pacer = new RatePacer({ requestsPerMinute: 1_000, tokensPerMinute: 1_000_000, now: clock.now, sleep: clock.sleep });
    pacer.observe(headersWith("100", "7.66s"));

    await pacer.acquire(60); // 60 <= 100: fits, and should bring the override down to 40
    expect(clock.sleepCalls).toEqual([]);

    await pacer.acquire(60); // 60 > 40 now: must wait for the override to expire, not re-use the stale 100
    expect(clock.sleepCalls).toEqual([7_660]);
  });
});
