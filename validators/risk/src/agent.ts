/**
 * `risk-v1`'s agent loop (P5 plan Decisions 2-4, 7, 12, 21): the model calls read-only tools at the
 * pinned block over several turns, every untrusted text a tool returns is screened by Prompt Guard
 * before the model sees it, and one last call with no tools and a strict JSON schema returns the
 * findings. Everything is injected (the chat client, the guard, the tool context), so tests never
 * touch the network.
 *
 * Two phases, because Groq doesn't support tools and structured output in one request:
 * 1. **Tool loop.** `tool_choice: "auto"` with the seven tool definitions. A turn may carry 0, 1 or
 *    several tool calls (Groq's docs contradict themselves on parallel calls for gpt-oss, so both are
 *    handled), and every `tool_call_id` is answered. At most `RISK_V1.maxToolCalls` calls run; any
 *    call past that is answered `{error: "TOOL_CALL_LIMIT"}` without running (Decision 21).
 * 2. **Final call.** The same history plus one final instruction, no tools, and `response_format`
 *    `json_schema` with `strict: true`. zod (`parseModelOutput`) re-checks what the schema can't.
 *
 * **Token budget** (Decision 4). Every request this loop sends estimates (`estimateTokens`) at most
 * `RISK_V1.maxRequestTokens`, so it never meets Groq's 413 or the pacer's per-minute refusal:
 * - before each tool turn, the loop stops calling tools if the tool request itself, or the *next*
 *   final call after one more tool turn at the output cap ({@link RESERVE_TURN}), would be over;
 * - inside a turn, each call runs only if the final call still fits with an answer at the cap in its
 *   place, and its real answer is sent only if the final call still fits with it — otherwise it, and
 *   every later call in the turn, is answered `TOOL_CALL_LIMIT` and the loop ends;
 * - a turn in which nothing ran and that would still not fit (a very long interim message) is left
 *   out of the conversation (its records are kept);
 * - a re-ask after invalid output carries the rejected answer only when that fits.
 * The one exception is initial data so large that even the first final call is over the cap; then
 * that call is still made (it is the only way to a verdict), and the pacer decides.
 * The loop also stops calling tools once the summed `usage.total` reaches `RISK_V1.maxCheckTokens`.
 *
 * **Failures.** A transient provider failure (`isTransientError`) rejects the whole run, with no
 * partial result (Decision 6). Invalid model output — a `tool_use_failed` in the loop (the same turn
 * is re-asked), a `json_validate_failed` on the final call (the same request is re-sent), or a final
 * answer zod rejects (re-asked with our fixed error text) — shares one budget of
 * `RISK_V1.invalidOutputRetries` retries (Decision 7); once it's spent, `findings` is `null`.
 * Anything else (a chain read failing inside a tool, the guard failing) rethrows.
 */
import { canonicalJson } from "@attest8004/sdk";
import { findingsJsonSchema, parseModelOutput, SOURCE_NAMES } from "./findings.ts";
import { screen, type PromptGuard } from "./guard.ts";
import { estimateTokens, isTransientError, ProviderError, type ChatClient, type ChatMessage, type ChatRequest, type ChatResponse } from "./llm.ts";
import { RISK_V1 } from "./params.ts";
import { finalMessages, initialMessages, invalidOutputMessage, type InitialData } from "./prompt.ts";
import { runTool, TOOL_DEFINITIONS, type ToolContext } from "./tools.ts";
import type { Finding, GuardResult, JsonValue, ToolCallRecord, TurnRecord } from "./types.ts";
import { safeJson } from "./untrusted.ts";

export interface AgentResult {
  /** One record per model response, tool turns and final attempts alike, in order (never reasoning text). */
  turns: TurnRecord[];
  /** One record per answered tool call, in order, including `TOOL_CALL_LIMIT` answers. */
  toolCalls: ToolCallRecord[];
  /** `initialGuard`, then every tool text screened during the loop, in order. */
  guard: GuardResult[];
  /** The last final-call answer (its content, or the provider's failed generation) and how many final requests were made; `null` if the loop gave up before any. */
  final: { raw: string; attempts: number } | null;
  /** The validated model findings, or `null` when the output was still invalid after its retries. */
  findings: Finding[] | null;
  usage: { prompt: number; completion: number; total: number };
}

/** The answer to a call that is not run (Decision 21); a fresh object each time, so no two records share one. */
function toolCallLimit(): JsonValue {
  return { error: "TOOL_CALL_LIMIT" };
}

/** The sampling parameters every request carries (Decision 2). `parallel_tool_calls` and `service_tier` are never sent. */
const SAMPLING = {
  reasoning_effort: RISK_V1.reasoningEffort,
  include_reasoning: false,
  temperature: RISK_V1.temperature,
  seed: RISK_V1.seed,
} as const;

const FINAL_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: { name: "risk_findings", strict: true, schema: findingsJsonSchema },
} as const;

/**
 * The model parameters `runAgent` sends, for `promptHash` (Decision 11: the hash covers the initial
 * messages, the tool definitions and the model parameters) — one source, so the hash can't drift from
 * what the requests actually carry.
 */
export function promptParams(model: string) {
  return {
    model,
    ...SAMPLING,
    tool_choice: "auto",
    toolTurnMaxCompletionTokens: RISK_V1.toolTurnMaxCompletionTokens,
    finalMaxCompletionTokens: RISK_V1.finalMaxCompletionTokens,
    response_format: FINAL_RESPONSE_FORMAT,
  } as const;
}

function toolRequest(model: string, messages: readonly ChatMessage[]): ChatRequest {
  return {
    model,
    messages: [...messages],
    tools: TOOL_DEFINITIONS,
    tool_choice: "auto",
    ...SAMPLING,
    max_completion_tokens: RISK_V1.toolTurnMaxCompletionTokens,
  };
}

function finalRequest(model: string, messages: readonly ChatMessage[]): ChatRequest {
  return {
    model,
    messages: [...messages],
    response_format: FINAL_RESPONSE_FORMAT,
    ...SAMPLING,
    max_completion_tokens: RISK_V1.finalMaxCompletionTokens,
  };
}

/** Every source citable at once: the longest final instruction there can be, so a budget check against it bounds the real one. */
const ALL_SOURCES: readonly string[] = [...SOURCE_NAMES];

/** Whether the final call on `history` would estimate within `RISK_V1.maxRequestTokens`. */
function finalFits(model: string, history: readonly ChatMessage[]): boolean {
  return estimateTokens(finalRequest(model, finalMessages(history, ALL_SOURCES))) <= RISK_V1.maxRequestTokens;
}

/**
 * A tool answer at the output cap, as `estimateTokens` counts it: `RISK_V1.toolOutputMaxBytes`
 * characters, each one that JSON escapes (a `"`, two characters once the request is serialised). A
 * capped output's own quotes and backslashes are escaped the same way, so this bounds any output at
 * the cap free of `<`, `>` and `&` (which `safeJson` writes as six-character escapes); for those, the
 * check on the real answer after the tool runs is what keeps the bound.
 */
function reserveAnswer(id: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content: '"'.repeat(RISK_V1.toolOutputMaxBytes) };
}

const RESERVE_ID = "call_reserve";

/** One more tool turn: an assistant message carrying one call with an address argument, and its answer at the cap. */
const RESERVE_TURN: readonly ChatMessage[] = [
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: RESERVE_ID,
        type: "function",
        function: { name: "nansen_counterparty_profile", arguments: JSON.stringify({ address: `0x${"0".repeat(40)}` }) },
      },
    ],
  },
  reserveAnswer(RESERVE_ID),
];

function limitAnswer(id: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content: safeJson(toolCallLimit()) };
}

function assistantMessage(response: ChatResponse): ChatMessage {
  return {
    role: "assistant",
    content: response.content,
    tool_calls: response.toolCalls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: call.arguments },
    })),
  };
}

/** The response as recorded: everything but the raw body, so no reasoning text can ever reach the evidence. */
function turnRecord(response: ChatResponse): TurnRecord {
  return {
    content: response.content,
    toolCalls: response.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
    finishReason: response.finishReason,
    servedModel: response.servedModel,
    systemFingerprint: response.systemFingerprint,
    usage: { ...response.usage },
  };
}

/**
 * A call's raw argument string as a record (Ruling R3, exactly as `runTool` records it): the parsed
 * JSON when it parses and is canonical-JSON-safe, else the raw string. Used for calls answered
 * `TOOL_CALL_LIMIT` before `runTool` ever saw them.
 */
function recordedArguments(raw: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(raw);
    canonicalJson(parsed);
    return parsed as JsonValue;
  } catch {
    return raw;
  }
}

/**
 * The extra messages for a re-ask after zod rejected `raw`: the rejected answer and our fixed error
 * text when that fits, else the error text alone, else nothing (the same request again).
 */
function reaskMessages(model: string, base: readonly ChatMessage[], raw: string, error: string, citable: readonly string[]): ChatMessage[] {
  const message: ChatMessage = { role: "user", content: invalidOutputMessage(error, citable) };
  const candidates: ChatMessage[][] = [[{ role: "assistant", content: raw }, message], [message]];
  for (const extra of candidates) {
    if (estimateTokens(finalRequest(model, [...base, ...extra])) <= RISK_V1.maxRequestTokens) return extra;
  }
  return [];
}

/**
 * Runs the tool loop and the final call (see the module doc). Resolves with every record of the run;
 * `findings: null` means the model's output was still invalid after its retries. Rejects on a
 * transient provider failure (no partial result), and on any failure that isn't invalid model output.
 */
export async function runAgent(o: {
  llm: ChatClient;
  guard: PromptGuard;
  model: string;
  data: InitialData;
  tools: ToolContext;
  initialGuard: GuardResult[];
}): Promise<AgentResult> {
  const { llm, guard, model, tools } = o;
  let history: ChatMessage[] = initialMessages(o.data);
  const turns: TurnRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const guardResults: GuardResult[] = [...o.initialGuard];
  const usage = { prompt: 0, completion: 0, total: 0 };
  /** Names of the tools that ran (not `TOOL_CALL_LIMIT` ones): what the findings may cite. */
  const ran = new Set<string>();
  let executed = 0;
  let invalidOutputs = 0;

  const result = (final: AgentResult["final"], findings: Finding[] | null): AgentResult => ({
    turns,
    toolCalls,
    guard: guardResults,
    final,
    findings,
    usage: { ...usage },
  });

  /** Counts one invalid output against the shared budget; `true` once the budget is spent. */
  const budgetSpent = (): boolean => {
    invalidOutputs++;
    return invalidOutputs > RISK_V1.invalidOutputRetries;
  };

  /** One model call: the response (recorded), or the provider's failed generation for invalid output. */
  const ask = async (request: ChatRequest): Promise<{ response: ChatResponse } | { invalid: string }> => {
    let response: ChatResponse;
    try {
      response = await llm.complete(request);
    } catch (error) {
      if (isTransientError(error)) throw error;
      if (error instanceof ProviderError && error.kind === "invalid_output") return { invalid: error.failedGeneration ?? "" };
      throw error;
    }
    turns.push(turnRecord(response));
    usage.prompt += response.usage.prompt;
    usage.completion += response.usage.completion;
    usage.total += response.usage.total;
    return { response };
  };

  const answerLimit = (turn: ChatMessage[], call: { id: string; name: string }, args: JsonValue): void => {
    turn.push(limitAnswer(call.id));
    toolCalls.push({ id: call.id, name: call.name, arguments: args, output: toolCallLimit(), onchain: false });
  };

  // ---- phase 1: the tool loop ----
  let stop = false;
  while (!stop && executed < RISK_V1.maxToolCalls && usage.total < RISK_V1.maxCheckTokens) {
    const request = toolRequest(model, history);
    if (estimateTokens(request) > RISK_V1.maxRequestTokens) break;
    if (!finalFits(model, [...history, ...RESERVE_TURN])) break;

    const answer = await ask(request);
    if ("invalid" in answer) {
      if (budgetSpent()) return result(null, null);
      continue; // re-ask the same turn
    }
    const { response } = answer;
    // A turn with no tool call ends the loop. Its prose isn't carried into the final call: the final
    // instruction asks for everything afresh, and leaving it out keeps the final call within budget.
    if (response.toolCalls.length === 0) break;

    const turn: ChatMessage[] = [assistantMessage(response)];
    let ranThisTurn = 0;
    for (let i = 0; i < response.toolCalls.length; i++) {
      const call = response.toolCalls[i] as ChatResponse["toolCalls"][number];
      const rest = response.toolCalls.slice(i + 1).map((later) => limitAnswer(later.id));
      const pending = [...history, ...turn];
      if (stop || executed >= RISK_V1.maxToolCalls || !finalFits(model, [...pending, reserveAnswer(call.id), ...rest])) {
        stop = true;
        answerLimit(turn, call, recordedArguments(call.arguments));
        continue;
      }
      const ranTool = await runTool(call.name, call.arguments, tools);
      const toolMessage: ChatMessage = { role: "tool", tool_call_id: call.id, content: safeJson(ranTool.output) };
      if (!finalFits(model, [...pending, toolMessage, ...rest])) {
        // Over the bound only for text heavy in `<`, `>` or `&` (see reserveAnswer): never sent, so
        // never screened, and recorded as what the model saw.
        stop = true;
        answerLimit(turn, call, ranTool.arguments);
        continue;
      }
      // Screened before the model can see it (Decision 12): the next model call comes after this.
      guardResults.push(...(await screen(guard, ranTool.untrusted, RISK_V1.guardThreshold)));
      turn.push(toolMessage);
      toolCalls.push({ id: call.id, name: call.name, arguments: ranTool.arguments, output: ranTool.output, onchain: ranTool.onchain });
      ran.add(call.name);
      executed++;
      ranThisTurn++;
    }
    if (ranThisTurn === 0 && !finalFits(model, [...history, ...turn])) break; // left out: nothing ran, and it doesn't fit
    history = [...history, ...turn];
  }

  // ---- phase 2: the final, tool-free call ----
  const citable = SOURCE_NAMES.filter((name) => name === "request" || name === "mandate_v1_verdict" || ran.has(name));
  const called = new Set<string>([...ran, "request", "mandate_v1_verdict"]);
  const base = finalMessages(history, citable);
  let extra: ChatMessage[] = [];
  let attempts = 0;
  for (;;) {
    attempts++;
    const answer = await ask(finalRequest(model, [...base, ...extra]));
    if ("invalid" in answer) {
      if (budgetSpent()) return result({ raw: answer.invalid, attempts }, null);
      continue; // re-send the same request
    }
    const raw = answer.response.content ?? "";
    const parsed = parseModelOutput(raw, called);
    if (parsed.ok) return result({ raw, attempts }, parsed.findings);
    if (budgetSpent()) return result({ raw, attempts }, null);
    extra = reaskMessages(model, base, raw, parsed.error, citable);
  }
}
