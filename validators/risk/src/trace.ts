import { decodeErrorResult, getAddress, type Hex } from "viem";
import { RISK_V1 } from "./params.ts";
import type { JsonValue } from "./types.ts";

/** A JSON object, the shape every tool output and {@link flattenTrace} produce. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * One frame of a `debug_traceCall` `callTracer` answer, exactly as the node returns it (geth/Monad's
 * callTracer JSON): `type` is `CALL`, `DELEGATECALL`, `STATICCALL`, `CREATE`, `CREATE2` or
 * `SELFDESTRUCT`; `error` is set (e.g. `"execution reverted"`) when this frame itself failed; `calls`
 * is every frame it made, in call order. Never read `gasUsed` here: Monad reports the top frame's
 * `gasUsed` equal to the gas limit it was given, not what the call actually used (R6).
 */
export interface CallFrame {
  type: string;
  from: Hex;
  to?: Hex;
  value?: Hex;
  input?: Hex;
  output?: Hex;
  error?: string;
  calls?: CallFrame[];
}

/**
 * What {@link import("./reader.ts").RiskReader.trace} resolves to: the raw `callTracer` frame, or
 * `INSUFFICIENT_FUNDS` when the node answered JSON-RPC `-32003` (too little balance for `value`,
 * before any call ran). Every other RPC or transport failure throws instead (never a `TraceResult`).
 */
export type TraceResult = { ok: true; frame: CallFrame } | { ok: false; error: "INSUFFICIENT_FUNDS" };

/** The standard Solidity `Error(string)` revert, as `decodeErrorResult` needs it. */
const ERROR_STRING_ABI = [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }] as const;

/** `hex`'s value as an unsigned decimal string (`"0x0"` or `undefined` is `"0"`). */
function decimalOf(hex: Hex | undefined): string {
  return (hex === undefined ? 0n : BigInt(hex)).toString();
}

function valueOf(hex: Hex | undefined): bigint {
  return hex === undefined ? 0n : BigInt(hex);
}

/** The first 4 bytes of `input`, lower-cased, or `null` when there are fewer than 4 bytes of input. */
function selectorOf(input: Hex | undefined): Hex | null {
  if (input === undefined || input.length < 10) return null;
  return input.slice(0, 10).toLowerCase() as Hex;
}

/**
 * This frame's own outcome, read from its raw `error` text (callTracer gives no machine-readable
 * code): `null` when it has none (it succeeded), `"OUT_OF_GAS"` for an out-of-gas message, and
 * `"REVERTED"` for `"execution reverted"` or any other failure text (the only other state the evidence
 * format allows, so an error text we don't recognise is still reported as a failure, not dropped).
 */
function classifyFrameError(error: string | undefined): "REVERTED" | "OUT_OF_GAS" | null {
  if (error === undefined || error === "") return null;
  if (/out of gas/i.test(error)) return "OUT_OF_GAS";
  return "REVERTED";
}

/**
 * The standard outcome strings geth-style callTracers put in a frame's `error` (exact, case-sensitive):
 * the two {@link classifyFrameError} recognises (`"execution reverted"`, `"out of gas"`) and the EVM's
 * other fixed failure texts. They are our nodes' own words, never data a contract chose. Any other
 * `error` text in a simulation's `calls[]` (say `"execution reverted: <reason>"`, if a node ever embeds
 * the revert data there) is shown to the model verbatim, so the agent loop screens it as untrusted text
 * (final review A1); `flattenTrace` itself, and `runTool`'s `untrusted`, are unchanged by it.
 */
export const STANDARD_CALL_TRACER_ERRORS: readonly string[] = [
  "execution reverted",
  "out of gas",
  "invalid opcode",
  "stack underflow",
  "stack overflow",
  "write protection",
  "insufficient balance for transfer",
  "contract creation code storage out of gas",
  "max code size exceeded",
];

/** `Error(string)`'s decoded message from `output`, or `null` when it isn't that revert. */
function decodeRevertReason(output: Hex | undefined): string | null {
  if (output === undefined) return null;
  try {
    const decoded = decodeErrorResult({ abi: ERROR_STRING_ABI, data: output });
    return typeof decoded.args[0] === "string" ? decoded.args[0] : null;
  } catch {
    return null;
  }
}

/** callTracer frame types that actually move MON (a `DELEGATECALL`/`STATICCALL` only ever shows the caller's inherited `value`, never a real transfer). */
const VALUE_MOVING_TYPES = new Set(["CALL", "CREATE", "CREATE2", "SELFDESTRUCT"]);

/**
 * Drops a trailing lone (unpaired) UTF-16 high surrogate — the first code unit of an emoji (or any
 * codepoint above `U+FFFF`) that a plain `.slice()` cut in half. Canonical JSON still encodes a lone
 * surrogate without error, but the same text later reaches the Prompt Guard and the model as a JSON
 * request body, and a strict server-side JSON/UTF-8 validator can reject an unpaired surrogate escape
 * — which would make every guard/LLM call on that request fail, forever, and an attacker-controlled
 * revert reason (or any other text this validator truncates) could trigger that on purpose. Fix round
 * 2, finding 2. Safe to call on any string, cut or not: a string that doesn't end in a lone high
 * surrogate is returned unchanged.
 */
export function dropTrailingLoneSurrogate(value: string): string {
  return value.replace(/[\uD800-\uDBFF]$/, "");
}

/**
 * `frame`, every descendant in call order, each paired with its depth (the top frame is depth 0) and
 * `clean`: whether *this* frame and every one of its ancestors succeeded (no `error`). A frame whose
 * own `error` is set, or that is nested inside one that failed, is never `clean` — `valueFlows` reads
 * this so a reverted branch (or one under a reverted ancestor) never reports a movement that didn't
 * really happen.
 */
function flattenFrames(frame: CallFrame, depth: number, parentClean: boolean, out: { depth: number; frame: CallFrame; clean: boolean }[]): void {
  const clean = parentClean && !frame.error;
  out.push({ depth, frame, clean });
  for (const child of frame.calls ?? []) flattenFrames(child, depth + 1, clean, out);
}

/**
 * Normalises a `TraceResult` into the evidence/tool-output shape (Task 8 brief, amended by fix round
 * 1): `ok`/`error`/`revertReason` describe the top frame's own outcome; `calls` is every frame
 * (depth-first, call order) up to `maxCalls`, each `{ depth, type, from, to, value, selector, error }`;
 * `truncatedCalls` is how many frames beyond `maxCalls` were dropped from the end of that list.
 *
 * `valueFlows` is `{ from, to, value }` for every frame **in the whole trace** (not just the first
 * `maxCalls` — a forward that happens to be the 17th call must still show up) that: is a `CALL`,
 * `CREATE`, `CREATE2` or `SELFDESTRUCT` (never `DELEGATECALL`/`STATICCALL`, which only carry the
 * caller's *inherited* `value` on a real node, not an actual transfer); has `value > 0`; and is
 * `clean` (itself and every ancestor succeeded — a revert anywhere on the path means no value
 * actually moved, whatever the frame's own `value` field says). **Sorted by `value` descending**
 * (ties keep their original frame order — a stable sort), fix round 2, finding 1: `valueFlows` can
 * itself be cut down by `capOutput` later (Decision 19's 1,536-byte cap), which always trims from the
 * *end* of an array, so a handful of dust transfers (e.g. 1 wei each) placed before the real forward
 * in call order must never be able to push that forward out of the surviving list.
 *
 * `revertReason` is capped at `RISK_V1.maxRevertReasonChars`, with `revertReasonTruncated: true` when
 * it was cut; the cut (and the full, uncut text) is passed through {@link dropTrailingLoneSurrogate}
 * so it never ends in an unpaired UTF-16 surrogate (fix round 2, finding 2) — this is the text the
 * Prompt Guard screens, so it must stay both bounded and well-formed.
 *
 * Deterministic: the same `TraceResult` always flattens to the same `JsonObject`.
 */
export function flattenTrace(result: TraceResult, maxCalls: number): JsonObject {
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      revertReason: null,
      revertReasonTruncated: false,
      calls: [],
      valueFlows: [],
      truncatedCalls: 0,
    };
  }

  const flat: { depth: number; frame: CallFrame; clean: boolean }[] = [];
  flattenFrames(result.frame, 0, true, flat);
  const included = flat.slice(0, maxCalls);
  const truncatedCalls = flat.length - included.length;

  const calls: JsonValue[] = included.map(({ depth, frame }) => ({
    depth,
    type: frame.type,
    from: getAddress(frame.from),
    to: frame.to === undefined ? null : getAddress(frame.to),
    value: decimalOf(frame.value),
    selector: selectorOf(frame.input),
    error: frame.error ?? null,
  }));

  const flows = flat.filter(({ frame, clean }) => clean && VALUE_MOVING_TYPES.has(frame.type) && valueOf(frame.value) > 0n);
  // Descending by value; `Array.prototype.sort` is a stable sort (guaranteed since ES2019), so a `0`
  // comparison result for equal values keeps their original (call-order) relative position.
  flows.sort((a, b) => {
    const av = valueOf(a.frame.value);
    const bv = valueOf(b.frame.value);
    return av > bv ? -1 : av < bv ? 1 : 0;
  });
  const valueFlows: JsonValue[] = flows.map(({ frame }) => ({
    from: getAddress(frame.from),
    to: frame.to === undefined ? null : getAddress(frame.to),
    value: decimalOf(frame.value),
  }));

  const topError = classifyFrameError(result.frame.error);
  const fullRevertReason = topError === "REVERTED" ? decodeRevertReason(result.frame.output) : null;
  const revertReasonTruncated = fullRevertReason !== null && fullRevertReason.length > RISK_V1.maxRevertReasonChars;
  const revertReason =
    fullRevertReason === null ? null : dropTrailingLoneSurrogate(fullRevertReason.slice(0, RISK_V1.maxRevertReasonChars));

  return {
    ok: topError === null,
    error: topError,
    revertReason,
    revertReasonTruncated,
    calls,
    valueFlows,
    truncatedCalls,
  };
}
