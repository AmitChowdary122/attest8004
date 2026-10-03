import { decodeErrorResult, getAddress, type Hex } from "viem";
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

/** `frame`, every descendant in call order, each paired with its depth (the top frame is depth 0). */
function flattenFrames(frame: CallFrame, depth: number, out: { depth: number; frame: CallFrame }[]): void {
  out.push({ depth, frame });
  for (const child of frame.calls ?? []) flattenFrames(child, depth + 1, out);
}

/**
 * Normalises a `TraceResult` into the evidence/tool-output shape (Task 8 brief): `ok`/`error`/
 * `revertReason` describe the top frame's own outcome; `calls` is every frame (depth-first, call
 * order) up to `maxCalls`, each `{ depth, type, from, to, value, selector, error }`; `valueFlows` is
 * `{ from, to, value }` for every included call that actually moves value; `truncatedCalls` is how
 * many frames beyond `maxCalls` were dropped from the end of that list. Deterministic: the same
 * `TraceResult` always flattens to the same `JsonObject`.
 */
export function flattenTrace(result: TraceResult, maxCalls: number): JsonObject {
  if (!result.ok) {
    return { ok: false, error: result.error, revertReason: null, calls: [], valueFlows: [], truncatedCalls: 0 };
  }

  const flat: { depth: number; frame: CallFrame }[] = [];
  flattenFrames(result.frame, 0, flat);
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

  const valueFlows: JsonValue[] = included
    .filter(({ frame }) => valueOf(frame.value) > 0n)
    .map(({ frame }) => ({
      from: getAddress(frame.from),
      to: frame.to === undefined ? null : getAddress(frame.to),
      value: decimalOf(frame.value),
    }));

  const topError = classifyFrameError(result.frame.error);
  const revertReason = topError === "REVERTED" ? decodeRevertReason(result.frame.output) : null;

  return {
    ok: topError === null,
    error: topError,
    revertReason,
    calls,
    valueFlows,
    truncatedCalls,
  };
}
