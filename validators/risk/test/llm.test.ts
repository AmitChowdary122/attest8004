import { describe, expect, it } from "vitest";
import { ProviderError, estimateTokens, isTransientError, openAiCompatibleClient, type ChatRequest } from "../src/llm.ts";
import { TokenBudgetExceededError, type RatePacer } from "../src/pacer.ts";

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

  // Fix round 1, finding 3: retry-after over the 90s cap used to retry 4 times at a capped 90s each
  // (6 real minutes of futile waiting); it now fails fast instead, since no amount of waiting within
  // our retry budget would help.
  it("fails fast as transient when retry-after exceeds the 90 s cap, instead of retrying at a capped 90 s", async () => {
    const { fn, calls } = fakeFetch([jsonResponse(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "999" })]);
    const sleep = fakeSleep();
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: fn, sleep: sleep.fn });

    await expect(client.complete(baseRequest())).rejects.toMatchObject({ kind: "transient", status: 429 });
    expect(calls).toHaveLength(1);
    expect(sleep.calls).toEqual([]);
  });

  it("fails fast on a retry-after of exactly 90 s (no, only strictly over 90 s fails fast) — 90 s itself still waits", async () => {
    const responses = Array.from({ length: 5 }, () => jsonResponse(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "90" }));
    const { fn } = fakeFetch(responses);
    const sleep = fakeSleep();
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: fn, sleep: sleep.fn });

    await expect(client.complete(baseRequest())).rejects.toMatchObject({ kind: "transient", status: 429 });
    expect(sleep.calls).toEqual([90_000, 90_000, 90_000, 90_000]);
  });

  // Fix round 1, finding 3: a missing retry-after header used to wait 0 ms (hammering the provider);
  // it now falls back to a non-zero doubling backoff.
  it("falls back to a non-zero doubling backoff when retry-after is missing", async () => {
    const responses = Array.from({ length: 5 }, () => jsonResponse(429, { error: { code: "rate_limit_exceeded" } }));
    const { fn } = fakeFetch(responses);
    const sleep = fakeSleep();
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: fn, sleep: sleep.fn });

    await expect(client.complete(baseRequest())).rejects.toMatchObject({ kind: "transient", status: 429 });
    expect(sleep.calls).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  it("falls back to a non-zero doubling backoff when retry-after is an HTTP-date (not a bare number of seconds)", async () => {
    const responses = Array.from({ length: 5 }, () =>
      jsonResponse(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
    );
    const { fn } = fakeFetch(responses);
    const sleep = fakeSleep();
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: fn, sleep: sleep.fn });

    await expect(client.complete(baseRequest())).rejects.toMatchObject({ kind: "transient", status: 429 });
    expect(sleep.calls).toEqual([2_000, 4_000, 8_000, 16_000]);
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

  // Fix round 1, finding 4: a rejected fetch (a network failure, not our own timeout abort) used to
  // become transient immediately; Decision 6 says "other errors" (which this is) get the same 2
  // in-call retries (2s, 4s) as 5xx before giving up.
  it("a rejected fetch (network failure) is retried twice (2 s, 4 s) then transient, per Decision 6", async () => {
    let calls = 0;
    const flaky = (async (): Promise<Response> => {
      calls++;
      throw new Error("ECONNREFUSED: connection refused at 10.0.0.1:443 with token abc-super-secret");
    }) as typeof fetch;
    const sleep = fakeSleep();
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: flaky, sleep: sleep.fn });

    let caught: unknown;
    try {
      await client.complete(baseRequest());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    const providerError = caught as ProviderError;
    expect(providerError.kind).toBe("transient");
    expect(providerError.message).toBe("request failed");
    expect((providerError as unknown as { cause?: unknown }).cause).toBeUndefined();
    expect(providerError.message).not.toContain("10.0.0.1");
    expect(providerError.message).not.toContain("abc-super-secret");
    expect(calls).toBe(3);
    expect(sleep.calls).toEqual([2_000, 4_000]);
  });

  it("a rejected fetch that recovers on retry succeeds normally", async () => {
    let calls = 0;
    const flakyThenOk = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls++;
      if (calls < 2) throw new Error("ECONNRESET");
      return jsonResponse(200, successBody());
    }) as typeof fetch;
    const sleep = fakeSleep();
    const client = openAiCompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: flakyThenOk, sleep: sleep.fn });

    const result = await client.complete(baseRequest());
    expect(result.content).toBe("hello");
    expect(calls).toBe(2);
    expect(sleep.calls).toEqual([2_000]);
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

// Fix round 1, finding 8: new URL(baseUrl) throws Node's ERR_INVALID_URL, whose `.input` field
// holds the full LLM_BASE_URL — that must never surface in any field we expose.
describe("openAiCompatibleClient: LLM_BASE_URL validation", () => {
  it("wraps an unparseable baseUrl in our own fixed text, with no URL in any field", () => {
    const bogus = "not a valid url with spaces and a secret-token-xyz";
    let caught: unknown;
    try {
      openAiCompatibleClient({ baseUrl: bogus, apiKey: "k" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & Record<string, unknown>;
    expect(error.message).toBe("LLM_BASE_URL must be an http(s) URL");
    const haystack = JSON.stringify(Object.assign({ message: error.message, name: error.name }, error));
    expect(haystack).not.toContain(bogus);
    expect(haystack).not.toContain("secret-token-xyz");
  });

  it("rejects a non-http(s) scheme the same way", () => {
    expect(() => openAiCompatibleClient({ baseUrl: "ftp://example.com", apiKey: "k" })).toThrow("LLM_BASE_URL must be an http(s) URL");
  });
});

describe("estimateTokens", () => {
  it("is ceil(chars(messages+tools+response_format)/3) plus max_completion_tokens", () => {
    const request: ChatRequest = { model: "m", messages: [{ role: "user", content: "hello there" }], max_completion_tokens: 100 };
    const chars = JSON.stringify({ messages: request.messages, tools: request.tools, response_format: request.response_format }).length;
    expect(estimateTokens(request)).toBe(Math.ceil(chars / 3) + 100);
  });
});

describe("isTransientError", () => {
  it("is true for a transient ProviderError and for the pacer's TokenBudgetExceededError", () => {
    expect(isTransientError(new ProviderError("x", { kind: "transient", status: 503, code: null, failedGeneration: null }))).toBe(true);
    expect(isTransientError(new TokenBudgetExceededError(9_000, 8_000))).toBe(true);
  });

  it("is false for invalid model output, any other error, and non-errors (even ones shaped like {kind: \"transient\"})", () => {
    expect(isTransientError(new ProviderError("x", { kind: "invalid_output", status: 400, code: "tool_use_failed", failedGeneration: null }))).toBe(false);
    expect(isTransientError(new Error("boom"))).toBe(false);
    expect(isTransientError({ kind: "transient" })).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});
