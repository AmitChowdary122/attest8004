import { describe, expect, it } from "vitest";
import { ProviderError, estimateTokens, openAiCompatibleClient, type ChatRequest } from "../src/llm.ts";
import type { RatePacer } from "../src/pacer.ts";

function fakeFetch(responses: Response[]): { fn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const response = responses[i];
    i++;
    if (response === undefined) throw new Error("fakeFetch: ran out of canned responses");
    return response;
  }) as typeof fetch;
  return { fn, calls };
}

function fakeSleep(): { fn: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    fn: async (ms: number) => {
      calls.push(ms);
    },
    calls,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function baseRequest(): ChatRequest {
  return {
    model: "openai/gpt-oss-120b",
    messages: [{ role: "user", content: "hi" }],
    max_completion_tokens: 32,
  };
}

function successBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "chatcmpl-x",
    model: "openai/gpt-oss-120b",
    system_fingerprint: "fp_abc",
    choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

describe("openAiCompatibleClient: request shape", () => {
  it("posts to <baseUrl>/chat/completions with Bearer auth and the exact body", async () => {
    const { fn, calls } = fakeFetch([jsonResponse(200, successBody())]);
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/openai/v1", apiKey: "key-123", fetch: fn, sleep: fakeSleep().fn });
    const request = baseRequest();
    await client.complete(request);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.com/openai/v1/chat/completions");
    const init = calls[0]?.init;
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers as Record<string, string>);
    expect(headers.get("authorization")).toBe("Bearer key-123");
    expect(JSON.parse(init?.body as string)).toEqual(request);
  });

  it("the key appears in no error message, ProviderError field or log field", async () => {
    const { fn } = fakeFetch([jsonResponse(401, { error: { code: "invalid_api_key" } })]);
    const client = openAiCompatibleClient({
      baseUrl: "https://api.example.com/v1",
      apiKey: "super-secret-key",
      fetch: fn,
      sleep: fakeSleep().fn,
    });
    let caught: unknown;
    try {
      await client.complete(baseRequest());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    const error = caught as ProviderError;
    const haystack = [error.message, error.kind, String(error.status), String(error.code), String(error.failedGeneration), JSON.stringify(error)].join(
      "\n",
    );
    expect(haystack).not.toContain("super-secret-key");
  });

  it("host is the URL host only", () => {
    const client = openAiCompatibleClient({ baseUrl: "https://api.groq.com/openai/v1", apiKey: "k" });
    expect(client.host).toBe("api.groq.com");
  });
});

describe("openAiCompatibleClient: errors", () => {
  it("429 with retry-after 2 waits 2,000 ms and retries; after 4 throws transient", async () => {
    const responses = Array.from({ length: 5 }, () => jsonResponse(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "2" }));
    const { fn, calls } = fakeFetch(responses);
    const sleep = fakeSleep();
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: fn, sleep: sleep.fn });

    await expect(client.complete(baseRequest())).rejects.toMatchObject({ kind: "transient", status: 429 });
    expect(calls).toHaveLength(5);
    expect(sleep.calls).toEqual([2_000, 2_000, 2_000, 2_000]);
  });

  it("caps retry-after at 90 s", async () => {
    const responses = Array.from({ length: 5 }, () => jsonResponse(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "999" }));
    const { fn } = fakeFetch(responses);
    const sleep = fakeSleep();
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: fn, sleep: sleep.fn });

    await expect(client.complete(baseRequest())).rejects.toMatchObject({ kind: "transient", status: 429 });
    expect(sleep.calls).toEqual([90_000, 90_000, 90_000, 90_000]);
  });

  it.each([500, 502, 503, 498, 499])("%i is retried twice (2 s, 4 s) then transient", async (status) => {
    const responses = [
      jsonResponse(status, { error: { code: "server_error" } }),
      jsonResponse(status, { error: { code: "server_error" } }),
      jsonResponse(status, { error: { code: "server_error" } }),
    ];
    const { fn, calls } = fakeFetch(responses);
    const sleep = fakeSleep();
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: fn, sleep: sleep.fn });

    await expect(client.complete(baseRequest())).rejects.toMatchObject({ kind: "transient", status });
    expect(calls).toHaveLength(3);
    expect(sleep.calls).toEqual([2_000, 4_000]);
  });

  it("timeout aborts after timeoutMs -> transient", async () => {
    const neverResolves = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          reject(signal.reason instanceof Error ? signal.reason : new DOMException("timed out", "TimeoutError"));
        });
      });
    }) as typeof fetch;
    const client = openAiCompatibleClient({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      fetch: neverResolves,
      timeoutMs: 20,
      sleep: fakeSleep().fn,
    });

    await expect(client.complete(baseRequest())).rejects.toMatchObject({ kind: "transient" });
  });

  it.each([401, 404, 413])("%i -> transient, with no in-call retry", async (status) => {
    const { fn, calls } = fakeFetch([jsonResponse(status, { error: { code: "whatever" } })]);
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: fn, sleep: fakeSleep().fn });

    await expect(client.complete(baseRequest())).rejects.toMatchObject({ kind: "transient", status });
    expect(calls).toHaveLength(1);
  });

  it("another 400 (not tool_use_failed/json_validate_failed) -> transient, with no in-call retry", async () => {
    const { fn, calls } = fakeFetch([jsonResponse(400, { error: { code: "invalid_request_error" } })]);
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: fn, sleep: fakeSleep().fn });

    await expect(client.complete(baseRequest())).rejects.toMatchObject({ kind: "transient", status: 400 });
    expect(calls).toHaveLength(1);
  });

  it("400 tool_use_failed -> invalid_output with failedGeneration", async () => {
    const { fn } = fakeFetch([jsonResponse(400, { error: { code: "tool_use_failed", failed_generation: "not json" } })]);
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: fn, sleep: fakeSleep().fn });

    await expect(client.complete(baseRequest())).rejects.toMatchObject({
      kind: "invalid_output",
      status: 400,
      code: "tool_use_failed",
      failedGeneration: "not json",
    });
  });

  it("400 json_validate_failed -> invalid_output", async () => {
    const { fn } = fakeFetch([jsonResponse(400, { error: { code: "json_validate_failed" } })]);
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: fn, sleep: fakeSleep().fn });

    await expect(client.complete(baseRequest())).rejects.toMatchObject({ kind: "invalid_output", status: 400, code: "json_validate_failed" });
  });

  it("stores an object failed_generation as its canonical JSON", async () => {
    const { fn } = fakeFetch([jsonResponse(400, { error: { code: "tool_use_failed", failed_generation: { foo: "bar" } } })]);
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: fn, sleep: fakeSleep().fn });

    await expect(client.complete(baseRequest())).rejects.toMatchObject({ failedGeneration: '{"foo":"bar"}' });
  });

  it("200 with no choices -> transient", async () => {
    const { fn } = fakeFetch([jsonResponse(200, { id: "x", model: "m", choices: [] })]);
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: fn, sleep: fakeSleep().fn });

    await expect(client.complete(baseRequest())).rejects.toMatchObject({ kind: "transient" });
  });

  it("calls pacer.acquire before every attempt (retries included) and pacer.observe after every response", async () => {
    const acquireCalls: number[] = [];
    const observeCalls: Headers[] = [];
    const pacer = {
      acquire: async (tokens: number) => {
        acquireCalls.push(tokens);
      },
      observe: (headers: Headers) => {
        observeCalls.push(headers);
      },
    } as unknown as RatePacer;
    const responses = [jsonResponse(500, { error: { code: "server_error" } }), jsonResponse(500, { error: { code: "server_error" } }), jsonResponse(200, successBody())];
    const { fn } = fakeFetch(responses);
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: fn, sleep: fakeSleep().fn, pacer });

    await client.complete(baseRequest());
    expect(acquireCalls).toHaveLength(3);
    expect(observeCalls).toHaveLength(3);
  });
});

describe("openAiCompatibleClient: successful response mapping", () => {
  it("maps a successful response to ChatResponse", async () => {
    const body = {
      id: "chatcmpl-y",
      model: "openai/gpt-oss-120b",
      system_fingerprint: "fp_xyz",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "hi there",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "get_mandate", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    };
    const { fn } = fakeFetch([jsonResponse(200, body)]);
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: fn, sleep: fakeSleep().fn });

    const result = await client.complete(baseRequest());
    expect(result).toEqual({
      body,
      servedModel: "openai/gpt-oss-120b",
      systemFingerprint: "fp_xyz",
      content: "hi there",
      toolCalls: [{ id: "call_1", name: "get_mandate", arguments: "{}" }],
      finishReason: "tool_calls",
      usage: { prompt: 3, completion: 4, total: 7 },
    });
  });
});

describe("estimateTokens", () => {
  it("is ceil(chars(messages+tools+response_format)/3) plus max_completion_tokens", () => {
    const request: ChatRequest = { model: "m", messages: [{ role: "user", content: "hello there" }], max_completion_tokens: 100 };
    const chars = JSON.stringify({ messages: request.messages, tools: request.tools, response_format: request.response_format }).length;
    expect(estimateTokens(request)).toBe(Math.ceil(chars / 3) + 100);
  });
});
