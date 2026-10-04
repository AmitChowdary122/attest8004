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
 * - **the invariant** (Task 10 fix rounds 1-2): the initial messages, the final instruction and
 *   `response_format` always leave room for at least {@link MIN_TOOL_ANSWERS} tool turns at the
 *   output cap ({@link RESERVE_TURN}). With `calldataText`'s caps (at most `RISK_V1.calldataTextMaxRuns`
 *   (16) runs and `RISK_V1.calldataTextMaxChars` (512) characters), every calldata fits, even at the
 *   largest request summary and text that is all `<`, `>` or `&`, so hostile calldata can't buy a
 *   review with no tools. Initial messages that don't leave that room can only come from the prompt,
 *   the tool definitions or the request summary growing: they are never sent — `runAgent` rejects
 *   with {@link InitialMessagesTooLargeError} before any model call;
 * - before each tool turn, the loop stops calling tools if the tool request itself, or the *next*
 *   final call after one more tool turn at the output cap ({@link RESERVE_TURN}), would be over;
 * - inside a turn, each call runs only if the final call still fits with an answer at the cap in its
 *   place, and its real answer is sent only if the final call still fits with it — otherwise it, and
 *   every later call in the turn, is answered `TOOL_CALL_LIMIT` and the loop ends;
 * - a turn in which nothing ran and that would still not fit (a very long interim message) is left
 *   out of the conversation (its records are kept);
 * - a re-ask after invalid output carries the rejected answer only when that fits.
 * The loop also stops calling tools once the summed `usage.total` reaches `RISK_V1.maxCheckTokens`.
 *
 * **Failures.** A transient provider failure (`isTransientError`) rejects the whole run, with no
 * partial result (Decision 6). Invalid model output — a `tool_use_failed` in the loop (the same turn
 * is re-asked with {@link TOOL_SCHEMA_RETRY_MESSAGE} appended, one more copy per further failure, and
 * dropped once the turn succeeds), a `json_validate_failed` on the final call (re-asked with the
 * failed generation and {@link FINAL_SCHEMA_ERROR}), a final answer zod rejects (re-asked with our
 * fixed error text), or a final answer that calls a tool
 * ({@link FINAL_TOOL_CALLS_ERROR}: not recorded as a turn, so the record never holds a tool call
 * without its answer, though its usage still counts) — shares one budget of
 * `RISK_V1.invalidOutputRetries` retries (Decision 7); once it's spent, `findings` is `null`. Every
 * re-ask differs from the request that failed (Task 13 ruling: with a fixed `seed`, an identical retry
 * repeats the same failure), unless even our error text no longer fits the token bound.
 * Anything else (a chain read failing inside a tool, the guard failing) rethrows.
 */
import { findingsJsonSchema, parseModelOutput, SOURCE_NAMES } from "./findings.ts";
import { screen, type PromptGuard } from "./guard.ts";
import { estimateTokens, isTransientError, ProviderError, type ChatClient, type ChatMessage, type ChatRequest, type ChatResponse } from "./llm.ts";
import { RISK_V1 } from "./params.ts";
import { finalMessages, initialMessages, invalidOutputMessage, TOOL_SCHEMA_RETRY_MESSAGE, type InitialData } from "./prompt.ts";
import { isRecordableJson, NANSEN_TOOLS, runTool, TOOL_DEFINITIONS, type ToolContext } from "./tools.ts";
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

/**
 * Our fixed error text for a final answer that calls a tool: the final request offers no tools, so such
 * an answer is invalid output (it counts against the shared retry budget and is re-asked with this
 * text). It is never recorded as a turn, so the evidence never holds a tool call without its answer
 * (`verify` requires every recorded tool call to be answered exactly once).
 */
export const FINAL_TOOL_CALLS_ERROR = "the final answer called a tool, but the final answer has no tools";

/**
 * Our fixed error text for a final answer the provider refused as not matching the JSON schema
 * (`json_validate_failed`; Task 13 ruling): the final call is re-asked with the failed generation and
 * this text (as for a zod failure), so the seeded retry is not the identical request.
 */
export const FINAL_SCHEMA_ERROR = "it did not match the JSON schema (every key exactly as named, nothing else)";

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

/** The final call's estimate on `history`, with every source citable. */
function finalEstimate(model: string, history: readonly ChatMessage[]): number {
  return estimateTokens(finalRequest(model, finalMessages(history, ALL_SOURCES)));
}

/** Whether the final call on `history` would estimate within `RISK_V1.maxRequestTokens`. */
function finalFits(model: string, history: readonly ChatMessage[]): boolean {
  return finalEstimate(model, history) <= RISK_V1.maxRequestTokens;
}

/**
 * A tool answer at the output cap: `RISK_V1.toolOutputMaxBytes` characters (Task 10 fix round 1: the
 * ruling's size, not the earlier every-character-escaped one, which left no room for 3 answers beside
 * the largest initial messages). A real answer at the cap measures a little more once serialised — its
 * own quotes are escaped again (a capped 40-call trace: 1,440 characters, 1,610 serialised) — and text
 * heavy in `<`, `>` or `&` much more, so the check on the real answer after the tool runs is what keeps
 * the bound: a call whose real answer doesn't fit is never sent (a rare boundary case).
 */
function reserveAnswer(id: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content: "x".repeat(RISK_V1.toolOutputMaxBytes) };
}

const RESERVE_ID = "call_reserve";

/**
 * One more tool turn: an assistant message carrying one call with an address argument, and its answer
 * at the cap. Exported (with {@link MIN_TOOL_ANSWERS}) so tests pin the invariant against the exact reserve.
 */
export const RESERVE_TURN: readonly ChatMessage[] = [
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

/** The invariant's floor: the initial messages always leave room for this many tool turns at the cap. */
export const MIN_TOOL_ANSWERS = 3;

const INVARIANT_RESERVE: readonly ChatMessage[] = Array.from({ length: MIN_TOOL_ANSWERS }, () => RESERVE_TURN).flat();

/**
 * The initial messages leave no room for {@link MIN_TOOL_ANSWERS} tool turns at the output cap within
 * `RISK_V1.maxRequestTokens` (see the module doc's invariant): `runAgent` rejects with this before any
 * model call. `estimate` is that final call's estimate with the reserved turns. Deterministic for the
 * same request, so a retry can never succeed: `runRiskV1` turns it into one `PROMPT_TOO_LARGE` decline.
 */
export class InitialMessagesTooLargeError extends Error {
  readonly estimate: number;

  constructor(estimate: number) {
    super(
      `runAgent: the initial messages leave no room for ${MIN_TOOL_ANSWERS} tool answers: ` +
        `the final call would estimate ${estimate} tokens, over ${RISK_V1.maxRequestTokens}; not sent`,
    );
    this.name = "InitialMessagesTooLargeError";
    this.estimate = estimate;
  }
}

/**
 * `ToolCallRecord.onchain` by the tool's name alone, exactly as `runTool` sets it: `false` only for the
 * two Nansen tools, `true` for every other name, unknown ones included (Task 10 fix round 1). A
 * `TOOL_CALL_LIMIT` output, not this flag, is what says the tool's answer was never shown to the model.
 */
function onchainByName(name: string): boolean {
  return !(NANSEN_TOOLS as readonly string[]).includes(name);
}

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
 * JSON when it parses and `isRecordableJson` (canonical-JSON-safe, no `__proto__` key), else the raw
 * string. Used for calls answered `TOOL_CALL_LIMIT` before `runTool` ever saw them.
 */
function recordedArguments(raw: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  return isRecordableJson(parsed) ? parsed : raw;
}

/**
 * The extra messages for a re-ask after zod rejected `raw`: the rejected answer and our fixed error
 * text when that fits, else the error text alone, else nothing (the same request again). Exported for
 * its tests; `runAgent` is its only caller.
 */
export function reaskMessages(model: string, base: readonly ChatMessage[], raw: string, error: string, citable: readonly string[]): ChatMessage[] {
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
 * transient provider failure (no partial result), on any failure that isn't invalid model output, and
 * — before any model call — on initial messages that break the token invariant.
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
  /** One model call: the response (its usage counted), or the provider's failed generation for invalid output. Records nothing. */
  const complete = async (request: ChatRequest): Promise<{ response: ChatResponse } | { invalid: string }> => {
    let response: ChatResponse;
    try {
      response = await llm.complete(request);
    } catch (error) {
      if (isTransientError(error)) throw error;
      if (error instanceof ProviderError && error.kind === "invalid_output") return { invalid: error.failedGeneration ?? "" };
      throw error;
    }
    usage.prompt += response.usage.prompt;
    usage.completion += response.usage.completion;
    usage.total += response.usage.total;
    return { response };
  };

  /** A tool-loop call: every response is recorded. */
  const ask = async (request: ChatRequest): Promise<{ response: ChatResponse } | { invalid: string }> => {
    const answer = await complete(request);
    if ("response" in answer) turns.push(turnRecord(answer.response));
    return answer;
  };

  /** A final call: recorded too, except an answer that calls a tool, which is invalid output ({@link FINAL_TOOL_CALLS_ERROR}). */
  const askFinal = async (request: ChatRequest): Promise<{ response: ChatResponse } | { invalid: string } | { calledTool: string }> => {
    const answer = await complete(request);
    if (!("response" in answer)) return answer;
    if (answer.response.toolCalls.length > 0) return { calledTool: answer.response.content ?? "" };
    turns.push(turnRecord(answer.response));
    return answer;
  };

  const answerLimit = (turn: ChatMessage[], call: { id: string; name: string }, args: JsonValue): void => {
    turn.push(limitAnswer(call.id));
    toolCalls.push({ id: call.id, name: call.name, arguments: args, output: toolCallLimit(), onchain: onchainByName(call.name) });
  };

  // The invariant: never send initial messages that leave no room for MIN_TOOL_ANSWERS tool turns.
  const reserved = finalEstimate(model, [...history, ...INVARIANT_RESERVE]);
  if (reserved > RISK_V1.maxRequestTokens) throw new InitialMessagesTooLargeError(reserved);

  // ---- phase 1: the tool loop ----
  let stop = false;
  /** One TOOL_SCHEMA_RETRY_MESSAGE per failed attempt at the current turn; cleared once it succeeds. */
  let corrections: ChatMessage[] = [];
  while (!stop && executed < RISK_V1.maxToolCalls && usage.total < RISK_V1.maxCheckTokens) {
    const request = toolRequest(model, [...history, ...corrections]);
    if (estimateTokens(request) > RISK_V1.maxRequestTokens) break;
    // The corrections ride only on this request, but the bound is checked with them, so a re-ask can never go over.
    if (!finalFits(model, [...history, ...corrections, ...RESERVE_TURN])) break;

    const answer = await ask(request);
    if ("invalid" in answer) {
      if (budgetSpent()) return result(null, null);
      corrections = [...corrections, { role: "user", content: TOOL_SCHEMA_RETRY_MESSAGE }];
      continue; // re-ask the same turn, with one more correction
    }
    corrections = [];
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
    const answer = await askFinal(finalRequest(model, [...base, ...extra]));
    if ("invalid" in answer) {
      if (budgetSpent()) return result({ raw: answer.invalid, attempts }, null);
      extra = reaskMessages(model, base, answer.invalid, FINAL_SCHEMA_ERROR, citable);
      continue;
    }
    if ("calledTool" in answer) {
      if (budgetSpent()) return result({ raw: answer.calledTool, attempts }, null);
      extra = reaskMessages(model, base, answer.calledTool, FINAL_TOOL_CALLS_ERROR, citable);
      continue;
    }
    const raw = answer.response.content ?? "";
    const parsed = parseModelOutput(raw, called);
    if (parsed.ok) return result({ raw, attempts }, parsed.findings);
    if (budgetSpent()) return result({ raw, attempts }, null);
    extra = reaskMessages(model, base, raw, parsed.error, citable);
  }
}
