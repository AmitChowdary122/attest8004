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

  // Fix round 1, finding 6: the message should name the expected and actual hashes for a changed
  // request, so a failing replay is debuggable without re-instrumenting.
  it("includes the expected and actual request hashes in the message on a changed request", async () => {
    const client = new ReplayChatClient(fixtureWith(1), "my-fixture");
    const changed: ChatRequest = { ...request(0), max_completion_tokens: 999 };
    const expectedHash = hashRequest(request(0));
    const actualHash = hashRequest(changed);
    expect(expectedHash).not.toBe(actualHash);

    let caught: unknown;
    try {
      await client.complete(changed);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FixtureMismatchError);
    const error = caught as FixtureMismatchError;
    expect(error.message).toContain(expectedHash);
    expect(error.message).toContain(actualHash);
  });

  it("throws when steps run out", async () => {
    const client = new ReplayChatClient(fixtureWith(1), "my-fixture");
    await client.complete(request(0));
    await expect(client.complete(request(1))).rejects.toBeInstanceOf(FixtureMismatchError);
    await expect(client.complete(request(1))).rejects.toMatchObject({ fixture: "my-fixture", step: 1 });
  });

  // Fix round 1, finding 6: the message should say the recording is exhausted (and how many steps it
  // had), not just repeat the generic mismatch wording.
  it("says the fixture is exhausted after N steps when steps run out", async () => {
    const client = new ReplayChatClient(fixtureWith(2), "my-fixture");
    await client.complete(request(0));
    await client.complete(request(1));

    let caught: unknown;
    try {
      await client.complete(request(2));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FixtureMismatchError);
    expect((caught as Error).message).toContain("exhausted after 2 step");
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

  // Fix round 1, finding 7: request/response were stored by reference, so a caller mutating a
  // shared messages array (or the live response body) after the call could rewrite history.
  it("clones the recorded request and response, so a later mutation can't rewrite history", async () => {
    const messages: ChatRequest["messages"] = [{ role: "user", content: "turn 0" }];
    const req: ChatRequest = { model: "m", messages, max_completion_tokens: 10 };
    const liveBody = {
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "answer 0" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const live: ChatClient = {
      host: "api.example.com",
      complete: async (): Promise<ChatResponse> => ({
        body: liveBody,
        servedModel: "m",
        systemFingerprint: null,
        content: "answer 0",
        toolCalls: [],
        finishReason: "stop",
        usage: { prompt: 1, completion: 1, total: 2 },
      }),
    };
    const recorder = new RecordingChatClient(live);
    await recorder.complete(req);

    // Mutate the caller's own objects after the call.
    (messages[0] as { content: string }).content = "mutated!";
    const liveChoice = liveBody.choices[0];
    if (liveChoice === undefined) throw new Error("unreachable");
    liveChoice.message.content = "mutated response";

    const fixture = recorder.toFixture();
    const recordedRequest = fixture.steps[0]?.request as ChatRequest;
    const recordedResponse = fixture.steps[0]?.response as typeof liveBody;
    expect((recordedRequest.messages[0] as { content: string }).content).toBe("turn 0");
    expect(recordedResponse.choices[0]?.message.content).toBe("answer 0");
  });
});
