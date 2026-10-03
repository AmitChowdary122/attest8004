import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chatPromptGuard, parseGuardScore, screen } from "../src/guard.ts";
import type { ChatClient, ChatRequest } from "../src/llm.ts";
import { ProviderError } from "../src/llm.ts";
import { RISK_V1 } from "../src/params.ts";

const FIXTURE_PATH = new URL("./fixtures/llm/guard.json", import.meta.url);

interface GuardFixtureStep {
  request: { messages: { content: string }[] };
  response: { choices: { message: { content: string } }[] };
}

function loadGuardFixture(): { host: string; steps: GuardFixtureStep[] } {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { host: string; steps: GuardFixtureStep[] };
}

/** A fake `ChatClient` that answers with the given contents, in call order. */
function fakeGuardClient(contents: (string | null)[]): { client: ChatClient; calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  let i = 0;
  const client: ChatClient = {
    host: "fake.guard.example",
    complete: async (request) => {
      calls.push(request);
      const content = contents[i];
      i++;
      if (content === undefined) throw new Error("fakeGuardClient: ran out of canned contents");
      return {
        body: {},
        servedModel: request.model,
        systemFingerprint: null,
        content,
        toolCalls: [],
        finishReason: "stop",
        usage: { prompt: 0, completion: 0, total: 0 },
      };
    },
  };
  return { client, calls };
}

describe("chatPromptGuard", () => {
  it("sends {model, messages: [{role: user, content: text}], max_completion_tokens: 16}", async () => {
    const { client, calls } = fakeGuardClient(["0.01"]);
    const guard = chatPromptGuard(client, RISK_V1.guardModel);
    await guard.classify("hello world");
    expect(calls).toEqual([{ model: RISK_V1.guardModel, messages: [{ role: "user", content: "hello world" }], max_completion_tokens: 16 }]);
  });

  it("parses the recorded benign and injected answers (test/fixtures/llm/guard.json)", async () => {
    const fixture = loadGuardFixture();
    expect(fixture.steps.length).toBeGreaterThan(0);
    for (const step of fixture.steps) {
      const recordedContent = step.response.choices[0]?.message.content;
      const probeText = step.request.messages[0]?.content;
      if (recordedContent === undefined || probeText === undefined) throw new Error("malformed fixture");
      const { client } = fakeGuardClient([recordedContent]);
      const guard = chatPromptGuard(client, RISK_V1.guardModel);
      const score = await guard.classify(probeText);
      expect(score).toBe(recordedContent);
      // Pinned to the live-probe format: a plain decimal string (Task 7 Step 1).
      expect(Number.isFinite(Number(score))).toBe(true);
    }
  });

  it("unparseable content -> transient", async () => {
    const { client } = fakeGuardClient(["I cannot comply with that request."]);
    const guard = chatPromptGuard(client, RISK_V1.guardModel);
    const promise = guard.classify("hello");
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
    await expect(promise).rejects.toMatchObject({ kind: "transient" });
  });

  it("empty content -> transient", async () => {
    const { client } = fakeGuardClient([""]);
    const guard = chatPromptGuard(client, RISK_V1.guardModel);
    await expect(guard.classify("hello")).rejects.toMatchObject({ kind: "transient" });
  });

  it("accepts exponent-notation content (fix round 1, finding 1): a benign score below 1e-4", async () => {
    // Python's str(float) switches to exponent form below 1e-4, e.g. a real float32 benign score.
    const { client } = fakeGuardClient(["3.890000152750872e-05"]);
    const guard = chatPromptGuard(client, RISK_V1.guardModel);
    await expect(guard.classify("hi")).resolves.toBe("3.890000152750872e-05");
  });
});

describe("parseGuardScore (fix round 1, finding 1)", () => {
  it("parses exponent notation", () => {
    expect(parseGuardScore("3.890000152750872e-05")).toBeCloseTo(3.890000152750872e-5);
    expect(parseGuardScore("1e-10")).toBeCloseTo(1e-10);
  });

  it("accepts 0 and 1 exactly", () => {
    expect(parseGuardScore("0")).toBe(0);
    expect(parseGuardScore("1")).toBe(1);
  });

  it.each(["1.5", "-0.1", "abc", ""])("rejects %j", (raw) => {
    expect(parseGuardScore(raw)).toBeNull();
  });
});

describe("screen", () => {
  it("splits 1,000 chars into 3 chunks of <= 400 with 40 overlap and keeps the max score", async () => {
    const text = "x".repeat(1_000);
    const { client, calls } = fakeGuardClient(["0.1", "0.9", "0.3"]);
    const guard = chatPromptGuard(client, "guard-model");

    const results = await screen(guard, [{ source: "calldata_text", text }], 0.5);

    expect(calls).toHaveLength(3);
    const chunkLengths = calls.map((call) => (call.messages[0] as { content: string }).content.length);
    expect(chunkLengths).toEqual([400, 400, 280]);
    expect(results).toEqual([{ source: "calldata_text", text: text.slice(360, 760), score: "0.9", flagged: true }]);
  });

  it("flagged iff score >= 0.5", async () => {
    const belowThreshold = fakeGuardClient(["0.4999"]);
    const below = await screen(chatPromptGuard(belowThreshold.client, "guard-model"), [{ source: "request", text: "short text" }], 0.5);
    expect(below[0]?.flagged).toBe(false);

    const atThreshold = fakeGuardClient(["0.5"]);
    const at = await screen(chatPromptGuard(atThreshold.client, "guard-model"), [{ source: "request", text: "short text" }], 0.5);
    expect(at[0]?.flagged).toBe(true);
  });

  it("no fields -> no requests", async () => {
    const { client, calls } = fakeGuardClient([]);
    const results = await screen(chatPromptGuard(client, "guard-model"), [], 0.5);
    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("screens several fields in order, each independently chunked", async () => {
    const { client, calls } = fakeGuardClient(["0.2", "0.8"]);
    const results = await screen(chatPromptGuard(client, "guard-model"), [{ source: "request", text: "a" }, { source: "calldata_text", text: "b" }], 0.5);
    expect(calls).toHaveLength(2);
    expect(results).toEqual([
      { source: "request", text: "a", score: "0.2", flagged: false },
      { source: "calldata_text", text: "b", score: "0.8", flagged: true },
    ]);
  });
});
