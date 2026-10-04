// What `attest8004 verify` prints: one renderer per verifier's report (human text or one JSON line),
// and the line for a tag neither verifier re-checks. Everything here is built from the report, which
// comes from chain data and our own fixed text, never from the RPC URL. Strings from the chain (a tag,
// a model name, a finding's explanation) can carry control characters; `main` passes every output
// through `printable` before it reaches the terminal.
import type { VerifyProblem, VerifyReport } from "@attest8004/validator-mandate";
import type { RiskVerifyProblem, RiskVerifyReport, ToolCallRef } from "@attest8004/validator-risk";
import { formatEther } from "viem";

/** What every `risk-v1` report says about the model's output: `verify` never calls the model. */
export const MODEL_OUTPUT = "recorded, not re-run";

/**
 * Escapes control characters (except newlines) and bidirectional overrides as `\uXXXX`, so strings
 * from the chain (a response's tag, the posted evidence's keys, a finding's explanation) can't drive
 * the terminal. Inside JSON strings the escape is still valid JSON for the same character.
 */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** A value as one line of JSON, every `bigint` as a decimal string. */
export function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

/** A chain string quoted and bounded for one line. */
function quoted(value: string): string {
  return JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}…` : value);
}

/** Rows of `label` padded to 19 characters, then the value. */
function rows() {
  const lines: string[] = [];
  const row = (label: string, value: string) => lines.push(`${label.padEnd(19)}${value}`);
  const more = (value: string) => row("", value);
  return { lines, row, more };
}

function pinnedRows(
  out: ReturnType<typeof rows>,
  report: { pinned: { number: bigint; hash: string; timestamp: bigint } | null; pinnedBlock: bigint | null },
  notRead: string,
): void {
  const { pinned } = report;
  if (pinned !== null) {
    out.row("pinned block", `${pinned.number}  ${pinned.hash}`);
    out.more(`${new Date(Number(pinned.timestamp) * 1000).toISOString()} (${pinned.timestamp})`);
  } else {
    out.row("pinned block", report.pinnedBlock === null ? "-" : `${report.pinnedBlock} (${notRead})`);
  }
}

// ---- mandate-v1 ----

const PROBLEM_TEXT: Record<VerifyProblem, string> = {
  NOT_MANDATE_V1: "the response isn't tagged mandate-v1, so there is no mandate-v1 run to repeat",
  RESPONSE_NOT_FOUND: "no response yet, or its ValidationResponse log wasn't found (retry later)",
  EVIDENCE_NOT_DECODED:
    "the response URI isn't inline JSON verify decodes (not a data: URI, over 128 KiB, or malformed); verify never fetches",
  EVIDENCE_HASH_MISMATCH: "the evidence at responseURI doesn't hash to the onchain responseHash",
  REQUEST_NOT_FOUND:
    "the registry has no such request, or its ValidationRequest log wasn't returned for the block state confirms (retry later)",
  REQUEST_BLOCK_WRONG: "the evidence names a request block the request wasn't made in (the registry's state shows otherwise)",
  REQUEST_INVALID:
    "the request's JSON doesn't hash to the requestHash, names another validator, agent or chain, or has a deadline more than " +
    "3,600 s after the pinned block's time; it must not be answered",
  PIN_OUT_OF_RANGE: "the evidence's pinned block isn't between the request's block and the response's block",
  SCORE_MISMATCH: "the onchain score isn't the recomputed score",
  RESPONSE_HASH_MISMATCH: "the onchain responseHash isn't the hash of the recomputed evidence",
};

function mandateVerdictLine(report: VerifyReport): string {
  switch (report.verdict) {
    case "match":
      return `match: re-running mandate-v1 at block ${report.pinnedBlock} gives the posted score and responseHash`;
    case "mismatch":
      return "MISMATCH: the posted verdict doesn't reproduce. This is public proof that the validator misbehaved.";
    case "unverifiable": {
      const [first] = report.problems;
      return `could not verify: ${first === undefined ? "unknown" : PROBLEM_TEXT[first]}. Nothing is proven either way.`;
    }
  }
}

/** A `mandate-v1` report as text: the verdict, then the re-run's inputs and outcome. */
export function mandateText(report: VerifyReport): string {
  const out = rows();
  out.lines.push(mandateVerdictLine(report), "");
  const { row, more } = out;
  const { posted, recomputed } = report;

  row("request", report.requestHash);
  row("validator", report.validator);
  row("tag", JSON.stringify(posted.tag));
  pinnedRows(out, report, "named by the evidence; not re-run");
  row("score", `posted ${posted.score}, recomputed ${recomputed?.score ?? "-"}`);
  row("responseHash", `posted     ${posted.responseHash}`);
  more(`recomputed ${recomputed?.responseHash ?? "-"}`);
  if (recomputed !== null) {
    row("reasons", recomputed.reasons.length === 0 ? "none" : recomputed.reasons.join(", "));
    row("spend", `${report.spendEntries.length} mandate-v1 approval(s) in the 25 h window`);
    for (const entry of report.spendEntries) {
      more(`${entry.requestHash}  ${entry.value} wei (${formatEther(entry.value)} MON)  ${entry.counted ? "counted" : "not counted"}`);
    }
    row("permission events", `${report.permissionEvents.length} in the window`);
  }
  if (report.problems.length === 0) {
    row("problems", "none");
  } else {
    report.problems.forEach((problem, i) => row(i === 0 ? "problems" : "", `${problem}: ${PROBLEM_TEXT[problem]}`));
  }
  if (report.differingKeys.length > 0) row("differing keys", report.differingKeys.join(", "));
  return out.lines.join("\n");
}

// ---- risk-v1 ----

const RISK_PROBLEM_TEXT: Record<RiskVerifyProblem, string> = {
  RESPONSE_NOT_FOUND: PROBLEM_TEXT.RESPONSE_NOT_FOUND,
  EVIDENCE_NOT_DECODED: PROBLEM_TEXT.EVIDENCE_NOT_DECODED,
  REQUEST_NOT_FOUND: PROBLEM_TEXT.REQUEST_NOT_FOUND,
  EVIDENCE_HASH_MISMATCH: PROBLEM_TEXT.EVIDENCE_HASH_MISMATCH,
  EVIDENCE_INVALID: "the evidence isn't a strict risk-v1 document in canonical JSON",
  PIN_OUT_OF_RANGE: PROBLEM_TEXT.PIN_OUT_OF_RANGE,
  PIN_MISMATCH: "the pinned block's hash or timestamp on the chain isn't the one the evidence records",
  REQUEST_BLOCK_WRONG: PROBLEM_TEXT.REQUEST_BLOCK_WRONG,
  REQUEST_INVALID: PROBLEM_TEXT.REQUEST_INVALID,
  REQUEST_FIELDS_MISMATCH: "the evidence's request isn't the request recomputed from the request JSON onchain",
  PARAMS_MISMATCH: "the evidence's params, guard model or guard threshold aren't risk-v1's constants",
  PREREQUISITE_MISMATCH:
    "mandate-v1's verdict at the pinned block, read as risk-v1 reads it, isn't the one the evidence records (or wasn't answered there)",
  FINDINGS_MISMATCH:
    "the findings don't follow from the record: the injection rule over the recorded classifier results, or the recorded final answer re-parsed",
  SCORE_MISMATCH: "the score doesn't follow from the recorded findings, or the reasons aren't their codes",
  TOOL_OUTPUT_MISMATCH: "an onchain tool call, re-run at the pinned block, gave another answer than the one the model was shown",
};

function riskVerdictLine(report: RiskVerifyReport): string {
  switch (report.verdict) {
    case "match":
      return (
        "match: the score follows from the recorded findings, every onchain fact shown to the model was true at " +
        `block ${report.pinnedBlock}, and the injection rule was applied`
      );
    case "mismatch":
      return "MISMATCH: the posted risk-v1 verdict doesn't follow from its evidence and the chain. This is public proof that the validator misbehaved.";
    case "unverifiable": {
      const [first] = report.problems;
      return `could not verify: ${first === undefined ? "unknown" : RISK_PROBLEM_TEXT[first]}. Nothing is proven either way.`;
    }
  }
}

function calls(refs: readonly ToolCallRef[]): string {
  return refs.map((ref) => `#${ref.index} ${ref.name}`).join(", ");
}

/**
 * A `risk-v1` report as text, in this order: the verdict line; the fixed row `model output: recorded,
 * not re-run`; the request, validator and tag; the model; the pinned block; the posted and recomputed
 * scores (and reasons); the findings (`severity code — explanation`); the tool calls re-checked at
 * `P`, those left unchecked (Nansen) and those the model never saw (`TOOL_CALL_LIMIT`); the problems.
 */
export function riskText(report: RiskVerifyReport): string {
  const out = rows();
  out.lines.push(riskVerdictLine(report), `model output: ${MODEL_OUTPUT}`, "");
  const { row, more } = out;
  const { posted, recomputed } = report;
  const parsed = report.model !== null;

  row("request", report.requestHash);
  row("validator", report.validator);
  row("tag", JSON.stringify(posted.tag));
  row("model", report.model ?? "-");
  pinnedRows(out, report, "named by the evidence; not read");
  row("score", `posted ${posted.score}, recomputed ${recomputed?.score ?? "-"}`);
  if (recomputed !== null) row("reasons", recomputed.reasons.length === 0 ? "none" : recomputed.reasons.join(", "));

  if (!parsed) {
    row("findings", "-");
  } else if (report.findings.length === 0) {
    row("findings", "none");
  } else {
    report.findings.forEach((f, i) => row(i === 0 ? "findings" : "", `${f.severity} ${f.code} — ${f.explanation}`));
  }

  const reachedTools = report.verdict === "match" || report.problems.includes("TOOL_OUTPUT_MISMATCH");
  const toolLines: string[] = [];
  if (!parsed) {
    toolLines.push("-");
  } else if (reachedTools) {
    const { checkedToolCalls: checked } = report;
    toolLines.push(`${checked.length} re-run at block ${report.pinnedBlock} and compared${checked.length > 0 ? `: ${calls(checked)}` : ""}`);
  } else {
    toolLines.push("none re-run: verify stopped at an earlier problem");
  }
  if (report.mismatchedToolCalls.length > 0) {
    const byIndex = new Map(report.checkedToolCalls.map((ref) => [ref.index, ref.name]));
    const refs = report.mismatchedToolCalls.map((index) => ({ index, name: byIndex.get(index) ?? "?" }));
    toolLines.push(`${refs.length} re-run answer(s) differ from what the model was shown: ${calls(refs)}`);
  }
  if (report.uncheckedToolCalls.length > 0) {
    toolLines.push(`${report.uncheckedToolCalls.length} unchecked (Nansen: offchain and advisory, never re-run): ${calls(report.uncheckedToolCalls)}`);
  }
  if (report.notShownToolCalls.length > 0) {
    toolLines.push(`${report.notShownToolCalls.length} not shown to the model (TOOL_CALL_LIMIT), so not re-run: ${calls(report.notShownToolCalls)}`);
  }
  toolLines.forEach((line, i) => (i === 0 ? row("tool calls", line) : more(line)));

  if (report.problems.length === 0) {
    row("problems", "none");
  } else {
    report.problems.forEach((problem, i) => row(i === 0 ? "problems" : "", `${problem}: ${RISK_PROBLEM_TEXT[problem]}`));
  }
  return out.lines.join("\n");
}

/** A `risk-v1` report as one line of JSON, with `"modelOutput": "recorded, not re-run"`. */
export function riskJson(report: RiskVerifyReport): string {
  return jsonText({ ...report, modelOutput: MODEL_OUTPUT });
}

// ---- a tag neither verifier re-checks ----

/** The text for a response under a tag other than `mandate-v1` and `risk-v1`: its first line is `could not verify: UNKNOWN_TAG "<tag>"`. */
export function unknownTagText(tag: string): string {
  return [`could not verify: UNKNOWN_TAG ${quoted(tag)}`, "verify re-checks mandate-v1 and risk-v1 verdicts only, so nothing is proven either way."].join(
    "\n",
  );
}

/** The same as one line of JSON. */
export function unknownTagJson(requestHash: string, tag: string): string {
  return jsonText({ requestHash, verdict: "unverifiable", match: false, problems: ["UNKNOWN_TAG"], posted: { tag } });
}
