/**
 * An OpenAI-compatible chat client over plain `fetch` (P5 plan: "plain `fetch` for the LLM ...
 * no new runtime dependency"), provider-neutral so a non-Groq endpoint only needs `LLM_BASE_URL`.
 * Every provider failure (429, a timeout, 5xx, 498/499, 413, 401/404, a malformed body) is
 * `ProviderError.kind === "transient"`, never a verdict (Decision 6); a 400 that names a model-output
 * problem (`tool_use_failed`, `json_validate_failed`) is `"invalid_output"` instead, carrying
 * `failedGeneration`. The key never appears in any thrown error, log field or fixture: `host` is the
 * URL's host only, and error text is our own fixed wording plus the status and the provider's
 * `error.code`/`error.type` (read defensively; never its free-text `message`, which could echo
 * untrusted input back).
 */
import { canonicalJson } from "@attest8004/sdk";
import { RatePacer } from "./pacer.ts";

export type ChatToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

/** OpenAI-shaped chat messages: the four roles risk-v1's loop and final call ever send. */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** A local function tool definition, OpenAI's `tools[]` shape (Task 9 fills in `tools.ts`'s seven). */
export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: "auto";
  response_format?: { type: "json_schema"; json_schema: { name: string; strict: true; schema: object } };
  reasoning_effort?: "low";
  include_reasoning?: false;
  max_completion_tokens: number;
  temperature?: number;
  seed?: number;
}

export interface ChatResponse {
  /** The raw parsed provider body, for evidence and for `RecordingChatClient` to write to a fixture. */
  body: unknown;
  servedModel: string;
  systemFingerprint: string | null;
  content: string | null;
  toolCalls: { id: string; name: string; arguments: string }[];
  finishReason: string;
  usage: { prompt: number; completion: number; total: number };
}

export interface ChatClient {
  /** The URL host only (e.g. `api.groq.com`) — never the full URL or the key. */
  readonly host: string;
  complete(request: ChatRequest): Promise<ChatResponse>;
}

export type ProviderErrorKind = "transient" | "invalid_output";

/**
 * Every way the provider or the network can fail to produce a usable answer. `status`/`code` are
 * the HTTP status and the provider's own `error.code` (or `error.type`) when there was a response at
 * all; both are `null` for a timeout or a network-level failure. `failedGeneration` is set only for
 * `kind === "invalid_output"`: the provider's `error.failed_generation`, as the string it sent, or
 * (if it sent an object) that object's canonical JSON.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly failedGeneration: string | null;

  constructor(
    message: string,
    info: { kind: ProviderErrorKind; status: number | null; code: string | null; failedGeneration: string | null },
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = info.kind;
    this.status = info.status;
    this.code = info.code;
    this.failedGeneration = info.failedGeneration;
  }
}

/** `ceil(chars(JSON.stringify({messages, tools, response_format})) / 3) + max_completion_tokens`. */
export function estimateTokens(request: ChatRequest): number {
  const relevant = { messages: request.messages, tools: request.tools, response_format: request.response_format };
  const chars = JSON.stringify(relevant).length;
  return Math.ceil(chars / 3) + request.max_completion_tokens;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `body.error.code`, falling back to `body.error.type`; `null` if neither is a string. */
function readErrorCode(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const { code, type } = body.error;
  if (typeof code === "string") return code;
  if (typeof type === "string") return type;
  return null;
}

/** `body.error.failed_generation`: the string as sent, or an object's canonical JSON. */
function readFailedGeneration(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const failedGeneration = body.error.failed_generation;
  if (typeof failedGeneration === "string") return failedGeneration;
  if (failedGeneration === undefined || failedGeneration === null) return null;
  try {
    return canonicalJson(failedGeneration);
  } catch {
    return JSON.stringify(failedGeneration);
  }
}

/** `retry-after`, in seconds, capped at 90 s and converted to ms; missing or invalid reads as 0. */
function retryAfterMs(headers: Headers): number {
  const raw = headers.get("retry-after");
  const seconds = raw === null ? NaN : Number(raw);
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return Math.min(safeSeconds, 90) * 1000;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Turns a parsed provider response body into a {@link ChatResponse}. Shared by the live client (right
 * after a successful fetch) and {@link import("./replay.ts").ReplayChatClient} (over a recorded
 * body), so both paths apply the exact same rules — including "no choices is transient".
 */
export function parseChatResponse(body: unknown): ChatResponse {
  const obj = isRecord(body) ? body : {};
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const first = choices[0];
  if (!isRecord(first)) {
    throw new ProviderError("provider response had no choices", { kind: "transient", status: null, code: null, failedGeneration: null });
  }
  const message = isRecord(first.message) ? first.message : {};
  const content = typeof message.content === "string" ? message.content : null;
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls = rawToolCalls.filter(isRecord).map((call) => {
    const fn = isRecord(call.function) ? call.function : {};
    return {
      id: typeof call.id === "string" ? call.id : "",
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: typeof fn.arguments === "string" ? fn.arguments : "",
    };
  });
  const usageObj = isRecord(obj.usage) ? obj.usage : {};
  const usage = {
    prompt: typeof usageObj.prompt_tokens === "number" ? usageObj.prompt_tokens : 0,
    completion: typeof usageObj.completion_tokens === "number" ? usageObj.completion_tokens : 0,
    total: typeof usageObj.total_tokens === "number" ? usageObj.total_tokens : 0,
  };
  return {
    body,
    servedModel: typeof obj.model === "string" ? obj.model : "",
    systemFingerprint: typeof obj.system_fingerprint === "string" ? obj.system_fingerprint : null,
    content,
    toolCalls,
    finishReason: typeof first.finish_reason === "string" ? first.finish_reason : "",
    usage,
  };
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_429_RETRIES = 4;
const OTHER_RETRY_DELAYS_MS = [2_000, 4_000] as const;
const RETRYABLE_STATUSES = new Set([500, 502, 503, 498, 499]);

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * An OpenAI-compatible `/chat/completions` client (Groq today, or any other provider named by
 * `LLM_BASE_URL`): free-tier pacing via `pacer.acquire`/`observe`, a bounded retry budget for
 * transient failures, and classification of every other failure per the module doc above. `fetch`,
 * `sleep` and `pacer` are injectable so callers (including tests) never touch the real network or a
 * real clock.
 */
export function openAiCompatibleClient(o: {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  pacer?: RatePacer;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): ChatClient {
  const fetchFn = o.fetch ?? fetch;
  const sleepFn = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // No pacer given: don't gate at all (callers that care about the free tier always pass one).
  const pacer = o.pacer ?? new RatePacer({ requestsPerMinute: Number.MAX_SAFE_INTEGER, tokensPerMinute: Number.MAX_SAFE_INTEGER });
  const baseUrl = o.baseUrl.replace(/\/+$/, "");
  const host = new URL(baseUrl).host;
  const url = `${baseUrl}/chat/completions`;
  const apiKey = o.apiKey;

  return {
    host,
    async complete(request: ChatRequest): Promise<ChatResponse> {
      let retries429 = 0;
      let retriesOther = 0;
      for (;;) {
        await pacer.acquire(estimateTokens(request));

        let response: Response;
        try {
          response = await fetchFn(url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          const message = isAbortLike(error) ? "request timed out" : "request failed";
          throw new ProviderError(message, { kind: "transient", status: null, code: null, failedGeneration: null });
        }

        pacer.observe(response.headers);

        if (response.status === 200) {
          const body = await readJsonSafely(response);
          return parseChatResponse(body);
        }

        const body = await readJsonSafely(response);
        const code = readErrorCode(body);
        const status = response.status;

        if (status === 429) {
          retries429++;
          if (retries429 > MAX_429_RETRIES) {
            throw new ProviderError(`provider rate-limited after ${MAX_429_RETRIES} retries`, {
              kind: "transient",
              status,
              code,
              failedGeneration: null,
            });
          }
          await sleepFn(retryAfterMs(response.headers));
          continue;
        }

        if (RETRYABLE_STATUSES.has(status)) {
          if (retriesOther >= OTHER_RETRY_DELAYS_MS.length) {
            throw new ProviderError(`provider error (status ${status})`, { kind: "transient", status, code, failedGeneration: null });
          }
          const delay = OTHER_RETRY_DELAYS_MS[retriesOther] as number;
          retriesOther++;
          await sleepFn(delay);
          continue;
        }

        if (status === 400 && (code === "tool_use_failed" || code === "json_validate_failed")) {
          throw new ProviderError(`model output invalid (${code})`, {
            kind: "invalid_output",
            status,
            code,
            failedGeneration: readFailedGeneration(body),
          });
        }

        // 401, 404, 413, any other 400, or anything unrecognised: transient, no in-call retry.
        throw new ProviderError(`provider error (status ${status})`, { kind: "transient", status, code, failedGeneration: null });
      }
    },
  };
}
