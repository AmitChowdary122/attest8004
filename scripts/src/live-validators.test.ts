import type { Outcome } from "@attest8004/sdk";
import type { Hex } from "viem";
import type { ChatClient, ChatRequest } from "@attest8004/validator-risk";
import { RISK_V1 } from "@attest8004/validator-risk";
import { describe, expect, it } from "vitest";
import { counted, llmSettingsFromEnv, pollAll, type PollJob } from "./live-validators.ts";

const H1 = `0x${"11".repeat(32)}` as Hex;
const H2 = `0x${"22".repeat(32)}` as Hex;
const OTHER = `0x${"99".repeat(32)}` as Hex;
const TX = `0x${"aa".repeat(32)}` as Hex;

const responded = (requestHash: Hex, score = 100): Outcome => ({ kind: "responded", requestHash, score, txHash: TX, blockNumber: 1n });
const skipped = (requestHash: Hex): Outcome => ({ kind: "skipped", requestHash, reason: "ALREADY_RESPONDED" });

/** A validator whose pollOnce yields one scripted cycle per call, then idles (caught up, nothing new). */
function scripted(cycles: Outcome[][]): PollJob["validator"] {
  let i = 0;
  return {
    async pollOnce() {
      const outcomes = cycles[i] ?? [];
      i += 1;
      return { outcomes, caughtUp: false, retryAfterMs: 0 };
    },
  };
}

describe("pollAll", () => {
  it("returns once every wanted request has an outcome, ignoring other requests, and calls onOutcome once per wanted hash", async () => {
    const seen: string[] = [];
    const found = await pollAll(
      [
        { name: "A", validator: scripted([[responded(OTHER)], [responded(H1)]]), requestHashes: [H1] },
        { name: "B", validator: scripted([[], [responded(H2, 80)]]), requestHashes: [H2] },
      ],
      5_000,
      "the test budget",
      (job, outcome) => seen.push(`${job}:${outcome.requestHash}`),
    );
    expect([...found.keys()].sort()).toEqual([H1, H2]);
    expect(found.has(OTHER)).toBe(false);
    expect(seen.sort()).toEqual([`A:${H1}`, `B:${H2}`]);
  });

  it("keeps the responded outcome over a later ALREADY_RESPONDED for the same request", async () => {
    // H2 is still pending after H1's two outcomes, so the second (skipped) one for H1 is seen too.
    const found = await pollAll(
      [{ name: "A", validator: scripted([[responded(H1)], [skipped(H1)], [responded(H2)]]), requestHashes: [H1, H2] }],
      5_000,
      "the test budget",
    );
    expect(found.get(H1)?.kind).toBe("responded");
  });

  it("rejects on gave-up and stops the other job, naming the job and the hash", async () => {
    let otherCycles = 0;
    const idle: PollJob["validator"] = {
      async pollOnce() {
        otherCycles += 1;
        return { outcomes: [], caughtUp: false, retryAfterMs: 5 };
      },
    };
    await expect(
      pollAll(
        [
          { name: "A", validator: scripted([[{ kind: "gave-up", requestHash: H1, error: "boom" }]]), requestHashes: [H1] },
          { name: "B", validator: idle, requestHashes: [H2] },
        ],
        5_000,
        "the test budget",
      ),
    ).rejects.toThrow(new RegExp(`A gave up on ${H1}`));
    const after = otherCycles;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(otherCycles).toBe(after);
  });

  it("rejects after timeoutMs naming the budget and the count found", async () => {
    const idle: PollJob["validator"] = {
      async pollOnce() {
        return { outcomes: [], caughtUp: false, retryAfterMs: 5 };
      },
    };
    await expect(pollAll([{ name: "A", validator: idle, requestHashes: [H1, H2] }], 20, "20 ms")).rejects.toThrow("A: no outcome for every request within 20 ms (0/2)");
  });
});

describe("counted", () => {
  it("adds up usage and served models across calls", async () => {
    const answers = [
      { servedModel: "m1", usage: { prompt: 10, completion: 2, total: 12 } },
      { servedModel: "m1", usage: { prompt: 5, completion: 1, total: 6 } },
      { servedModel: "m2", usage: { prompt: 1, completion: 1, total: 2 } },
    ];
    let i = 0;
    const base = {
      host: "api.example",
      async complete(_request: ChatRequest) {
        const answer = answers[i++];
        return { ...answer, content: "", toolCalls: [], finishReason: "stop", systemFingerprint: null } as never;
      },
    } as ChatClient;
    const { client, stats } = counted(base);
    for (let n = 0; n < 3; n++) await client.complete({ model: "m", messages: [] } as never);
    expect(client.host).toBe("api.example");
    expect(stats).toEqual({ calls: 3, servedModels: ["m1", "m2"], usage: { prompt: 16, completion: 4, total: 20 } });
  });
});

describe("llmSettingsFromEnv", () => {
  const base = { LLM_BASE_URL: "https://api.example/v1", LLM_API_KEY: "k", LLM_MODEL: "m" };

  it("throws on a blank LLM_BASE_URL, naming it", () => {
    expect(() => llmSettingsFromEnv({ ...base, LLM_BASE_URL: "  " })).toThrow("LLM_BASE_URL is not set");
  });

  it("throws on a non-numeric RISK_V1_LLM_TOKENS_PER_MINUTE, without echoing it", () => {
    expect(() => llmSettingsFromEnv({ ...base, RISK_V1_LLM_TOKENS_PER_MINUTE: "abc" })).toThrow(
      /^RISK_V1_LLM_TOKENS_PER_MINUTE must be a positive decimal integer$/,
    );
  });

  it("throws when the tokens per minute are below risk-v1's largest request", () => {
    expect(() => llmSettingsFromEnv({ ...base, RISK_V1_LLM_TOKENS_PER_MINUTE: String(RISK_V1.maxRequestTokens - 1) })).toThrow(
      `RISK_V1_LLM_TOKENS_PER_MINUTE must be at least ${RISK_V1.maxRequestTokens}`,
    );
  });

  it("defaults to the free tier's 30 requests and 8,000 tokens a minute", () => {
    expect(llmSettingsFromEnv(base)).toEqual({ ...{ baseUrl: base.LLM_BASE_URL, apiKey: "k", model: "m" }, pacing: { requestsPerMinute: 30, tokensPerMinute: 8_000 } });
  });
});
