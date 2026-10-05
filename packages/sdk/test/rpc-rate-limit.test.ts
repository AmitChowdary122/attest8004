import { describe, expect, it } from "vitest";
import { rateLimitedFetch } from "../src/rpc-rate-limit.ts";

/** A fake clock: `sleep` advances it, so the limiter's waits are observable and instant. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), at: () => t };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const limited = { jsonrpc: "2.0", id: 1, error: { code: -32011, message: "requests limited to 15/sec" } };
const ok = { jsonrpc: "2.0", id: 1, result: "0x1" };

describe("rateLimitedFetch", () => {
  it("never starts more than requestsPerSecond requests in any one-second window", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const fetchImpl = async () => {
      starts.push(clock.at());
      return json(ok);
    };
    const f = rateLimitedFetch({ requestsPerSecond: 10, retries: 0, retryDelayMs: 1000, fetchImpl, now: clock.now, sleep: clock.sleep });
    await Promise.all(Array.from({ length: 35 }, () => f("https://rpc.example", { method: "POST" })));
    expect(starts).toHaveLength(35);
    for (const start of starts) expect(starts.filter((s) => s >= start && s < start + 1000).length).toBeLessThanOrEqual(10);
    // 35 requests at 10 a second need at least 3 full seconds.
    expect(Math.max(...starts)).toBeGreaterThanOrEqual(3000);
  });

  it("retries a request the node refused with -32011 (or HTTP 429) after a growing wait, then returns the success", async () => {
    const clock = fakeClock();
    const answers = [json(limited), json({}, 429), json(ok)];
    const f = rateLimitedFetch({
      requestsPerSecond: 10,
      retries: 5,
      retryDelayMs: 500,
      fetchImpl: async () => answers.shift() as Response,
      now: clock.now,
      sleep: clock.sleep,
    });
    const response = await f("https://rpc.example", { method: "POST" });
    expect(await response.json()).toEqual(ok);
    expect(answers).toHaveLength(0);
    expect(clock.at()).toBeGreaterThanOrEqual(500 + 1000);
  });

  it("retries a JSON-RPC batch when any entry was refused for the rate limit", async () => {
    const clock = fakeClock();
    const answers = [json([ok, limited]), json([ok, ok])];
    const f = rateLimitedFetch({ requestsPerSecond: 10, retries: 2, retryDelayMs: 100, fetchImpl: async () => answers.shift() as Response, now: clock.now, sleep: clock.sleep });
    expect(await (await f("https://rpc.example", { method: "POST" })).json()).toEqual([ok, ok]);
  });

  it("gives up after `retries` and returns the last refusal, so viem reports the error", async () => {
    const clock = fakeClock();
    let calls = 0;
    const f = rateLimitedFetch({
      requestsPerSecond: 10,
      retries: 2,
      retryDelayMs: 100,
      fetchImpl: async () => {
        calls++;
        return json(limited);
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(await (await f("https://rpc.example", { method: "POST" })).json()).toEqual(limited);
    expect(calls).toBe(3);
  });

  it("passes every other answer through untouched, including a revert (code 3), without retrying", async () => {
    const clock = fakeClock();
    const revert = { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: "0x08c379a0" } };
    let calls = 0;
    const f = rateLimitedFetch({
      requestsPerSecond: 10,
      retries: 5,
      retryDelayMs: 100,
      fetchImpl: async () => {
        calls++;
        return json(revert);
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(await (await f("https://rpc.example", { method: "POST" })).json()).toEqual(revert);
    expect(calls).toBe(1);
    expect(clock.at()).toBe(0);
  });
});
