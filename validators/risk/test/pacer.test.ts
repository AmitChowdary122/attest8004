import { describe, expect, it } from "vitest";
import { RatePacer } from "../src/pacer.ts";

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
});
