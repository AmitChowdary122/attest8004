import { describe, expect, it } from "vitest";
import type { ChatClient, ChatRequest, ChatResponse } from "../src/llm.ts";
import { FixtureMismatchError, RecordingChatClient, ReplayChatClient, hashRequest, type LlmFixture } from "../src/replay.ts";

function request(i: number): ChatRequest {
  return { model: "m", messages: [{ role: "user", content: `turn ${i}` }], max_completion_tokens: 10 };
}

function body(i: number): Record<string, unknown> {
  return {
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: `answer ${i}` }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function fixtureWith(n: number): LlmFixture {
  return {
    host: "api.example.com",
    steps: Array.from({ length: n }, (_, i) => ({ requestHash: hashRequest(request(i)), request: request(i), response: body(i) })),
  };
}

describe("hashRequest", () => {
  it("is stable for the same request and differs for a changed one", () => {
    expect(hashRequest(request(0))).toBe(hashRequest(request(0)));
    expect(hashRequest(request(0))).not.toBe(hashRequest(request(1)));
  });

  it("normalises a non-integer number (temperature) so canonicalJson can hash it without throwing", () => {
    const withFloat: ChatRequest = { ...request(0), temperature: 0.2 };
    expect(() => hashRequest(withFloat)).not.toThrow();
    // Still sensitive to the float's value.
    const otherFloat: ChatRequest = { ...request(0), temperature: 0.3 };
    expect(hashRequest(withFloat)).not.toBe(hashRequest(otherFloat));
  });
});

describe("ReplayChatClient", () => {
  it("returns steps in order", async () => {
    const client = new ReplayChatClient(fixtureWith(2));
    const r1 = await client.complete(request(0));
    expect(r1.content).toBe("answer 0");
    const r2 = await client.complete(request(1));
    expect(r2.content).toBe("answer 1");
  });

  it("throws FixtureMismatchError on a changed request", async () => {
    const client = new ReplayChatClient(fixtureWith(1), "my-fixture");
    const changed: ChatRequest = { ...request(0), max_completion_tokens: 999 };
    await expect(client.complete(changed)).rejects.toBeInstanceOf(FixtureMismatchError);
    await expect(client.complete(changed)).rejects.toMatchObject({ fixture: "my-fixture", step: 0 });
  });

  it("throws when steps run out", async () => {
    const client = new ReplayChatClient(fixtureWith(1), "my-fixture");
    await client.complete(request(0));
    await expect(client.complete(request(1))).rejects.toBeInstanceOf(FixtureMismatchError);
    await expect(client.complete(request(1))).rejects.toMatchObject({ fixture: "my-fixture", step: 1 });
  });

  it("host is the fixture's host", () => {
    const client = new ReplayChatClient(fixtureWith(0));
    expect(client.host).toBe("api.example.com");
  });
});

describe("RecordingChatClient", () => {
  it("records a live client's calls and replays them identically", async () => {
    let i = 0;
    const live: ChatClient = {
      host: "api.example.com",
      complete: async (_req: ChatRequest): Promise<ChatResponse> => {
        const b = body(i);
        const content = (b.choices as { message: { content: string } }[])[0]?.message.content ?? null;
        i++;
        return {
          body: b,
          servedModel: "m",
          systemFingerprint: null,
          content,
          toolCalls: [],
          finishReason: "stop",
          usage: { prompt: 1, completion: 1, total: 2 },
        };
      },
    };
    const recorder = new RecordingChatClient(live);
    const r0 = await recorder.complete(request(0));
    const r1 = await recorder.complete(request(1));

    const fixture = recorder.toFixture();
    expect(fixture.host).toBe("api.example.com");
    expect(fixture.steps).toHaveLength(2);
    expect(fixture.steps[0]?.requestHash).toBe(hashRequest(request(0)));

    const replay = new ReplayChatClient(fixture, "recorded");
    expect((await replay.complete(request(0))).content).toBe(r0.content);
    expect((await replay.complete(request(1))).content).toBe(r1.content);
  });

  it("host mirrors the wrapped live client's host", () => {
    const live: ChatClient = { host: "api.groq.com", complete: async () => Promise.reject(new Error("unused")) };
    const recorder = new RecordingChatClient(live);
    expect(recorder.host).toBe("api.groq.com");
  });
});
