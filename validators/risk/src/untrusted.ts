import { canonicalJson } from "@attest8004/sdk";
import { hexToBytes, type Hex } from "viem";
import { TOOL_NAMES, type ToolName } from "./findings.ts";
import { RISK_V1 } from "./params.ts";

/**
 * `<`, `>` and `&` written as the JSON unicode escapes `<`, `>` and `&`: still exactly
 * the same string once `JSON.parse`d (a JSON string escape, not an HTML one), but the literal
 * characters never appear in the output. That is what stops untrusted data from closing its own
 * `<untrusted_data>` block (Decision 14), or from being confused for one of our own XML-ish tags.
 */
const ANGLE_AMP = /[<>&]/g;
const ANGLE_AMP_ESCAPES: Record<string, string> = { "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" };

/**
 * Canonical JSON (`@attest8004/sdk`'s `canonicalJson`: sorted keys, no floats, `bigint` as a decimal
 * string) with `<`, `>` and `&` escaped so the result can be embedded in an `<untrusted_data>` block
 * without being able to close it early. `JSON.parse(safeJson(x))` always deep-equals `x`.
 */
export function safeJson(value: unknown): string {
  return canonicalJson(value).replace(ANGLE_AMP, (char) => ANGLE_AMP_ESCAPES[char] ?? char);
}

/**
 * Where a piece of untrusted data came from, for the `source` attribute of its `<untrusted_data>`
 * block (Decision 14): the request, the calldata's extracted text, validator A's verdict, or one of
 * the seven tools (`tool:<name>`). Fixed, so a typo or a new tool name can't silently mislabel data.
 */
export type UntrustedSource = "request" | "calldata_text" | "mandate_v1_verdict" | `tool:${ToolName}`;

const UNTRUSTED_SOURCES: ReadonlySet<string> = new Set<string>([
  "request",
  "calldata_text",
  "mandate_v1_verdict",
  ...TOOL_NAMES.map((name) => `tool:${name}`),
]);

/**
 * Wraps `value` as canonical JSON (via {@link safeJson}) inside `<untrusted_data source="…">…
 * </untrusted_data>`, so the model can be told, once, that everything in such a block is data, never
 * instructions. Throws on a `source` outside {@link UntrustedSource} — a defensive, runtime check,
 * since callers may build `source` from a tool name at runtime.
 */
export function untrustedBlock(source: UntrustedSource, value: unknown): string {
  if (!UNTRUSTED_SOURCES.has(source)) {
    throw new Error(`untrustedBlock: unknown source "${source}"`);
  }
  return `<untrusted_data source="${source}">\n${safeJson(value)}\n</untrusted_data>`;
}

function isPrintable(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
}

/**
 * The printable-ASCII (0x20-0x7e) runs in `data`, each at least `RISK_V1.calldataTextMinChars` long
 * (shorter runs are dropped), with `offset` the run's byte offset into `data`. The combined `text`
 * length across every returned run never exceeds `RISK_V1.calldataTextMaxChars`: the run that would
 * cross that cap is cut to fit exactly, and every run after it is dropped (so truncation is
 * deterministic and always lands at the same point for the same input). At most
 * `RISK_V1.calldataTextMaxRuns` runs are returned, the first ones by offset (a dropped short run
 * doesn't count): each run costs its own JSON wrapper in the model's first message, so the two caps
 * together bound that message (Task 10 fix round 2).
 *
 * This is what feeds the request's calldata to Prompt Guard and, delimited, to the model — it is the
 * only place in the calldata an agent could plant free text (Decision 12).
 */
export function calldataText(data: Hex): { offset: number; text: string }[] {
  const bytes = hexToBytes(data);
  const runs: { offset: number; text: string }[] = [];
  let used = 0;
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i];
    if (byte === undefined || !isPrintable(byte)) {
      i++;
      continue;
    }
    const start = i;
    let end = i;
    while (end < bytes.length) {
      const next = bytes[end];
      if (next === undefined || !isPrintable(next)) break;
      end++;
    }
    const length = end - start;
    if (length < RISK_V1.calldataTextMinChars) {
      i = end;
      continue;
    }
    const remaining = RISK_V1.calldataTextMaxChars - used;
    if (remaining <= 0) break;
    const take = Math.min(length, remaining);
    let text = "";
    for (let k = start; k < start + take; k++) text += String.fromCharCode(bytes[k] as number);
    runs.push({ offset: start, text });
    used += text.length;
    if (take < length || runs.length >= RISK_V1.calldataTextMaxRuns) break;
    i = end;
  }
  return runs;
}
