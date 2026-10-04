/**
 * `verify` for `risk-v1` (SPEC §4.6, ARCHITECTURE §5.5; the P5 plan's Decision 27): re-checks a posted
 * verdict from its public evidence and the chain. It **never re-runs the model** (nor Prompt Guard):
 * it re-derives the score from the recorded findings, checks that every untrusted text shown to the
 * model has a classifier result and re-applies the injection rule to the recorded results (the guard's
 * scores themselves are recorded, not re-run), re-parses the recorded final answer, re-runs every
 * onchain tool call the model saw at the pinned block `P`, and re-checks the `mandate-v1` verdict it
 * required and the request.
 *
 * What a match proves: the score follows from the recorded findings; every onchain fact shown to the
 * model was true at `P`; the injection rule was applied. What it doesn't: that the recorded output
 * came from the model. Trusting `risk-v1` means trusting validator B's operator, which is why the gate
 * also requires `mandate-v1`, which anyone can fully reproduce.
 */
import { buildEvidence, canonicalJson, computeRequestHash, decodeJsonDataUri } from "@attest8004/sdk";
import {
  MAX_EVIDENCE_URI_BYTES,
  mandateRequestOf,
  requestAt,
  requestEvidence,
  statusOrUnknown,
  type PinnedBlock,
  type VerifyContext,
  type VerifyProblem,
} from "@attest8004/validator-mandate";
import { keccak256, stringToBytes, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { parseRiskEvidence, riskEvidence, riskParams, type RiskEvidence } from "./evidence.ts";
import { injectionFinding, parseModelOutput, scoreOf } from "./findings.ts";
import { parseGuardScore } from "./guard.ts";
import type { NansenClient } from "./nansen.ts";
import { RISK_V1 } from "./params.ts";
import type { RiskAddresses, RiskReader } from "./reader.ts";
import { calldataFields, readPrerequisite } from "./run.ts";
import { collectAddresses, initialScope, runTool, untrustedFromFlows, untrustedFromProfile, type UntrustedField } from "./tools.ts";
import type { GuardResult, JsonValue, RecordedFinding } from "./types.ts";

/**
 * Why `verify` didn't find a match. The first three leave nothing compared (unverifiable); every
 * other one is public proof that the validator misbehaved ({@link RISK_MISMATCH_PROBLEMS}).
 *
 * - `RESPONSE_NOT_FOUND`: no response yet, or its `ValidationResponse` log wasn't found (lag).
 * - `EVIDENCE_NOT_DECODED`: the response URI isn't inline JSON `verify` decodes (not a `data:` URI,
 *   over 128 KiB, or malformed); `verify` never fetches.
 * - `REQUEST_NOT_FOUND`: the registry has no such request, or state confirms the request's block but
 *   its `ValidationRequest` log wasn't returned (lag).
 * - `EVIDENCE_HASH_MISMATCH`: the decoded evidence doesn't hash to the onchain `responseHash`.
 * - `EVIDENCE_INVALID`: the evidence isn't a strict `risk-v1` document (`parseRiskEvidence`), isn't the
 *   canonical JSON of what it parses to (no honest run writes other bytes), or its tool-call records
 *   don't pair one to one with the tool calls in its recorded model responses (by id, in order, same
 *   name; Nansen and `TOOL_CALL_LIMIT` records included): the agent answers every call it is sent.
 * - `PIN_OUT_OF_RANGE`: `P` is before the request's block or the MandateRegistry's deployment, or
 *   after the block the response landed in.
 * - `PIN_MISMATCH`: block `P`'s hash or timestamp on the chain isn't the evidence's `block`.
 * - `REQUEST_BLOCK_WRONG`, `REQUEST_INVALID`: as `mandate-v1`'s (`requestAt`): the request wasn't made
 *   in the block the evidence names, or its JSON must not be answered.
 * - `REQUEST_FIELDS_MISMATCH`: the evidence's `request` (or `requestHash`) isn't the request recomputed
 *   from the request JSON on the chain.
 * - `PARAMS_MISMATCH`: `params`, `classifier.model` or `classifier.threshold` isn't the constants'.
 * - `PREREQUISITE_MISMATCH`: validator A's verdict at `P`, read as validator B reads it
 *   (`readPrerequisite`), isn't the evidence's `prerequisite`, or wasn't answered (or valid) at `P`.
 * - `FINDINGS_MISMATCH`: the findings don't follow from the record: an untrusted text the model was
 *   shown (the calldata's text, a re-run simulation's revert reason, a recorded Nansen label) has no
 *   classifier result of its own ({@link coversAll}), a classifier result's `flagged` isn't its
 *   recorded score against the threshold, code's findings aren't the injection rule applied to the
 *   classifier results, `finalOutput.raw` isn't the last recorded model response, or the model's
 *   findings aren't that answer re-parsed (with the tools that ran as citable sources).
 * - `SCORE_MISMATCH`: `scoreOf(findings)` isn't the posted score or the evidence's `score`, or
 *   `reasons` aren't the findings' codes in order.
 * - `TOOL_OUTPUT_MISMATCH`: an onchain tool call, re-run at `P` with the model's raw arguments and the
 *   address scope rebuilt from the recorded outputs, gave another answer (`mismatchedToolCalls`).
 */
export type RiskVerifyProblem =
  | "RESPONSE_NOT_FOUND"
  | "EVIDENCE_NOT_DECODED"
  | "REQUEST_NOT_FOUND"
  | "EVIDENCE_HASH_MISMATCH"
  | "EVIDENCE_INVALID"
  | "PIN_OUT_OF_RANGE"
  | "PIN_MISMATCH"
  | "REQUEST_BLOCK_WRONG"
  | "REQUEST_INVALID"
  | "REQUEST_FIELDS_MISMATCH"
  | "PARAMS_MISMATCH"
  | "PREREQUISITE_MISMATCH"
  | "FINDINGS_MISMATCH"
  | "SCORE_MISMATCH"
  | "TOOL_OUTPUT_MISMATCH";

/** The problems that prove the validator misbehaved: every problem except the three that leave nothing compared. */
export const RISK_MISMATCH_PROBLEMS: ReadonlySet<RiskVerifyProblem> = new Set<RiskVerifyProblem>([
  "EVIDENCE_HASH_MISMATCH",
  "EVIDENCE_INVALID",
  "PIN_OUT_OF_RANGE",
  "PIN_MISMATCH",
  "REQUEST_BLOCK_WRONG",
  "REQUEST_INVALID",
  "REQUEST_FIELDS_MISMATCH",
  "PARAMS_MISMATCH",
  "PREREQUISITE_MISMATCH",
  "FINDINGS_MISMATCH",
  "SCORE_MISMATCH",
  "TOOL_OUTPUT_MISMATCH",
]);

/** One tool call by its index in the evidence's `toolCalls`. */
export interface ToolCallRef {
  index: number;
  name: string;
}

/** What `verifyRiskRequest` found. Integers stay `bigint`. */
export interface RiskVerifyReport {
  /** Lower-case. */
  requestHash: Hex;
  /** The validator the registry records for the request (the zero address when it has no such request). */
  validator: Address;
  /** The pinned block `P` the posted evidence names; `null` when no evidence was parsed. */
  pinnedBlock: bigint | null;
  /** Block `P` as read from the chain; `null` when it wasn't read. */
  pinned: PinnedBlock | null;
  /** `verdict === "match"`. */
  match: boolean;
  /** `match`: every check passed. `mismatch`: public proof that the validator misbehaved. `unverifiable`: nothing is proven either way. */
  verdict: "match" | "mismatch" | "unverifiable";
  /** What the registry records: the onchain score, `responseHash` and tag. */
  posted: { score: number; responseHash: Hex; tag: string };
  /** `scoreOf` the recorded findings and their codes; `null` when `verify` stopped before the score step. */
  recomputed: { score: number; reasons: string[] } | null;
  /** Empty exactly when the verdict is `match`; at most one (`verify` stops at the first problem). */
  problems: RiskVerifyProblem[];
  /** The indices of the onchain tool calls whose re-run at `P` didn't give the recorded answer. */
  mismatchedToolCalls: number[];
  /** The onchain tool calls re-run at `P` and compared (empty unless `verify` reached the tool step). */
  checkedToolCalls: ToolCallRef[];
  /** The Nansen calls: offchain and advisory, so never re-run, and never a problem. */
  uncheckedToolCalls: ToolCallRef[];
  /** The calls answered `TOOL_CALL_LIMIT`: the model never saw the tool's answer, so nothing is re-run. */
  notShownToolCalls: ToolCallRef[];
  /** The model the evidence says was requested; `null` when no evidence was parsed. */
  model: string | null;
  /** The evidence's findings, model's then code's; empty when no evidence was parsed. */
  findings: RecordedFinding[];
}

/** What `verifyRiskRequest` checks against besides the chain: `mandate-v1`'s context, the contracts `risk-v1` reads, and validator A. */
export type RiskVerifyContext = VerifyContext & { addresses: RiskAddresses; mandateValidator: Address };

/**
 * The response to the request isn't tagged `risk-v1`, so there is no `risk-v1` verdict to re-check. The
 * CLI dispatches by tag and never calls `verifyRiskRequest` then; a direct caller gets this (exit 2).
 */
export class NotRiskV1Error extends Error {
  constructor(requestHash: Hex, tag: string) {
    const shown = JSON.stringify(tag.length > 64 ? `${tag.slice(0, 64)}…` : tag);
    super(`the response to ${requestHash} is tagged ${shown}, not risk-v1: there is no risk-v1 verdict to re-check`);
    this.name = "NotRiskV1Error";
  }
}

/** The Nansen client a re-run gets: never called, since Nansen calls are never re-run. */
const NO_NANSEN: NansenClient = {
  available: false,
  reason: "verify never calls Nansen",
  profile: async () => Promise.reject(new Error("verify never calls Nansen")),
  flows: async () => Promise.reject(new Error("verify never calls Nansen")),
};

const TOOL_CALL_LIMIT = canonicalJson({ error: "TOOL_CALL_LIMIT" });

/**
 * Re-checks the `risk-v1` verdict on `requestHash` against its public evidence and the chain (SPEC
 * §4.6, ARCHITECTURE §5.5). In order, stopping at the first problem:
 *
 * 1. The status at the finalized head (no request → `REQUEST_NOT_FOUND`; no response →
 *    `RESPONSE_NOT_FOUND`; another tag → rejects with {@link NotRiskV1Error}); the response log found
 *    through its `lastUpdate` (→ `RESPONSE_NOT_FOUND`); the inline evidence decoded
 *    (→ `EVIDENCE_NOT_DECODED`), hashing to `responseHash` (→ `EVIDENCE_HASH_MISMATCH`), parsed strictly
 *    and canonical, its tool-call records paired one to one with the recorded model tool calls
 *    (→ `EVIDENCE_INVALID`).
 * 2. `P` between the request's block (and the MandateRegistry's deployment) and the response's block
 *    (→ `PIN_OUT_OF_RANGE`, nothing read at `P`); the request log and JSON, as `mandate-v1`'s
 *    `requestAt` reads them (→ `REQUEST_BLOCK_WRONG`, `REQUEST_INVALID`, `REQUEST_NOT_FOUND`); block
 *    `P`'s hash and timestamp (→ `PIN_MISMATCH`).
 * 3. The evidence's `request` and `requestHash`, against the request recomputed from its JSON
 *    (→ `REQUEST_FIELDS_MISMATCH`).
 * 4. `params` (with `context`'s contracts and validator A), `classifier.model` and
 *    `classifier.threshold`, against the constants (→ `PARAMS_MISMATCH`).
 * 5. Validator A's verdict on the same action at `P`, read with `readPrerequisite`
 *    (→ `PREREQUISITE_MISMATCH`).
 * 6. Screening coverage for the calldata's text and every recorded Nansen label, and the classifier →
 *    code-findings rule; 7. `finalOutput.raw` re-parsed into the model's findings (→ `FINDINGS_MISMATCH`
 *    for either).
 * 8. `scoreOf(findings)` against the posted score and the evidence's, and `reasons` against the codes
 *    (→ `SCORE_MISMATCH`).
 * 9. Every onchain tool call the model saw, re-run in order at `P` with `runTool`, from the model's raw
 *    argument string (matched by tool-call id) and the address scope rebuilt from `initialScope` at `P`
 *    and the recorded outputs, compared as canonical JSON (→ `TOOL_OUTPUT_MISMATCH`, listing every
 *    index that differs); then screening coverage again, with each re-run's own untrusted text (a
 *    revert reason) added (→ `FINDINGS_MISMATCH`). Nansen calls are listed unchecked;
 *    `TOOL_CALL_LIMIT` answers aren't re-run, and nothing is derived from them (never screened).
 *
 * Rejects, rather than report, when a read fails: an RPC error during any read or tool re-run
 * (including history the node no longer serves), and validator A's response log not found
 * (`PrerequisiteLogNotFoundError`: lag, not evidence). A failed read is never a verdict, let alone a
 * mismatch; retry later or use another RPC.
 */
export async function verifyRiskRequest(o: { reader: RiskReader; requestHash: Hex; context: RiskVerifyContext }): Promise<RiskVerifyReport> {
  const { reader } = o;
  const { addresses, mandateValidator, validationRegistryDeployBlock, mandateRegistryDeployBlock } = o.context;
  const requestHash = o.requestHash.toLowerCase() as Hex;
  const head = await reader.finalized();

  // 1. Status, the response log, the keccak check and a strict parse.
  const status = await statusOrUnknown(reader, requestHash, head.number);
  if (status === null) {
    return report({ requestHash, validator: zeroAddress, posted: { score: 0, responseHash: zeroHash, tag: "" } }, ["REQUEST_NOT_FOUND"]);
  }
  const base = {
    requestHash,
    validator: status.validator,
    posted: { score: status.response, responseHash: status.responseHash.toLowerCase() as Hex, tag: status.tag },
  };
  if (base.posted.responseHash === zeroHash && status.tag === "") return report(base, ["RESPONSE_NOT_FOUND"]);
  if (status.tag !== RISK_V1.tag) throw new NotRiskV1Error(requestHash, status.tag);

  const response = await reader.responseLog(requestHash, status.lastUpdate, head.number);
  if (response === null) return report(base, ["RESPONSE_NOT_FOUND"]);
  const decoded = decodeJsonDataUri(response.uri, MAX_EVIDENCE_URI_BYTES);
  if (!decoded.ok) return report(base, ["EVIDENCE_NOT_DECODED"]);
  if (keccak256(stringToBytes(decoded.text)) !== base.posted.responseHash) return report(base, ["EVIDENCE_HASH_MISMATCH"]);
  const parsed = parseRiskEvidence(decoded.text);
  if (!parsed.ok || !isCanonical(parsed.doc, decoded.text)) return report(base, ["EVIDENCE_INVALID"]);
  const doc = parsed.doc;
  const pairing = pairToolCalls(doc);
  if (pairing === null) return report(base, ["EVIDENCE_INVALID"]);
  const written = riskEvidence(doc);
  const classified = classifyToolCalls(doc);
  const evidenceFields = {
    ...base,
    pinnedBlock: doc.block.number,
    model: doc.llm.model,
    findings: doc.findings,
    uncheckedToolCalls: classified.unchecked,
    notShownToolCalls: classified.notShown,
  };

  // 2. The pin range, the request log and JSON, and block P itself.
  const pinnedBlock = doc.block.number;
  const requestBlock = doc.request.block;
  if (pinnedBlock < requestBlock || pinnedBlock > response.block || pinnedBlock < mandateRegistryDeployBlock) {
    return report(evidenceFields, ["PIN_OUT_OF_RANGE"]);
  }
  const pinned = await reader.block(pinnedBlock);
  const fields = { ...evidenceFields, pinned };
  const request = await requestAt(reader, requestHash, requestBlock, validationRegistryDeployBlock, status, pinned);
  if ("problem" in request) return report(fields, [requestProblem(request.problem)]);
  if (pinned.hash.toLowerCase() !== doc.block.hash || pinned.timestamp !== doc.block.timestamp) return report(fields, ["PIN_MISMATCH"]);

  // 3. The evidence's request is the request.
  const mandateRequest = mandateRequestOf(request.json, requestHash, requestBlock);
  const rebuiltRequest = riskEvidence(withRecord(doc, { request: requestEvidence(mandateRequest) })).request;
  if (doc.requestHash !== requestHash || !sameJson(written.request, rebuiltRequest)) return report(fields, ["REQUEST_FIELDS_MISMATCH"]);

  // 4. The params are the constants.
  const rebuiltParams = riskEvidence(withRecord(doc, { params: riskParams(addresses, mandateValidator) })).params;
  if (!sameJson(written.params, rebuiltParams) || doc.classifier.model !== RISK_V1.guardModel || doc.classifier.threshold !== String(RISK_V1.guardThreshold)) {
    return report(fields, ["PARAMS_MISMATCH"]);
  }

  // 5. Validator A's verdict at P, read as validator B reads it.
  const requestHashA = computeRequestHash({
    chainId: mandateRequest.chainId,
    gate: mandateRequest.gate,
    validator: mandateValidator,
    action: {
      agentId: mandateRequest.agentId,
      target: mandateRequest.target,
      value: mandateRequest.value,
      data: mandateRequest.data,
      deadline: mandateRequest.deadline,
      salt: mandateRequest.salt,
    },
  });
  const prerequisite = await readPrerequisite(reader, { mandateValidator, requestHashA, pinned });
  if (prerequisite === "PENDING" || "invalid" in prerequisite || !sameJson(written.prerequisite, riskEvidence(withRecord(doc, { prerequisite })).prerequisite)) {
    return report(fields, ["PREREQUISITE_MISMATCH"]);
  }

  // 6. Every untrusted text shown to the model was screened (the calldata's, and every recorded Nansen
  // label; a re-run tool's own text is added at step 9), and the classifier → code-findings rule holds
  // for the recorded results (the guard isn't re-run).
  const recordedFields = [...calldataFields(mandateRequest.data), ...nansenFields(doc)];
  if (!coversAll(recordedFields, doc.classifier.results)) return report(fields, ["FINDINGS_MISMATCH"]);
  for (const result of doc.classifier.results) {
    const score = parseGuardScore(result.score);
    if (score === null || (score >= RISK_V1.guardThreshold) !== result.flagged) return report(fields, ["FINDINGS_MISMATCH"]);
  }
  const injection = injectionFinding(doc.classifier.results);
  const codeFindings = injection === null ? [] : [injection];
  if (!sameJson(doc.findings.filter((f) => f.origin === "code"), codeFindings)) return report(fields, ["FINDINGS_MISMATCH"]);

  // 7. The model's findings are its recorded final answer, re-parsed (the model isn't re-run).
  const lastTurn = doc.modelOutputs.at(-1);
  if (lastTurn === undefined || (lastTurn.content ?? "") !== doc.finalOutput.raw) return report(fields, ["FINDINGS_MISMATCH"]);
  const called = new Set<string>(["request", "mandate_v1_verdict", ...doc.toolCalls.filter((c) => !isToolCallLimit(c.output)).map((c) => c.name)]);
  const modelOutput = parseModelOutput(doc.finalOutput.raw, called);
  if (!modelOutput.ok) return report(fields, ["FINDINGS_MISMATCH"]);
  const expected: RecordedFinding[] = [...modelOutput.findings.map((f): RecordedFinding => ({ ...f, origin: "model" })), ...codeFindings];
  if (!sameJson(doc.findings, expected)) return report(fields, ["FINDINGS_MISMATCH"]);

  // 8. The score follows from the findings, and the reasons are their codes.
  const recomputed = { score: scoreOf(doc.findings), reasons: doc.findings.map((f) => f.code) };
  const scored = { ...fields, recomputed };
  if (recomputed.score !== base.posted.score || recomputed.score !== doc.score || !sameJson(recomputed.reasons, doc.reasons)) {
    return report(scored, ["SCORE_MISMATCH"]);
  }

  // 9. Every onchain fact the model saw, re-read at P; then the screening of each re-run's own text.
  const { checked, mismatched, untrusted } = await rerunToolCalls(reader, doc, pairing, mandateRequest, pinned);
  const rerun = { ...scored, checkedToolCalls: checked, mismatchedToolCalls: mismatched };
  if (mismatched.length > 0) return report(rerun, ["TOOL_OUTPUT_MISMATCH"]);
  if (!coversAll([...recordedFields, ...untrusted], doc.classifier.results)) return report(rerun, ["FINDINGS_MISMATCH"]);
  return report(rerun, []);
}

/**
 * Re-runs every onchain tool call the model saw, in order, as `runTool` ran it: with the model's raw
 * argument string (the recorded model tool call `pairing` gives each record) and the address scope the
 * run had at that point, rebuilt from `initialScope` at `P` and every earlier recorded output (Nansen's
 * included), exactly as `runTool` adds them. Each re-run gets a copy of that scope, so the scope only
 * ever grows from the recorded outputs. Also returns the untrusted text each re-run found (what validator
 * B screened for that call). Rejects on any read failure.
 */
async function rerunToolCalls(
  reader: RiskReader,
  doc: RiskEvidence,
  pairing: readonly number[],
  request: ReturnType<typeof mandateRequestOf>,
  pinned: PinnedBlock,
): Promise<{ checked: ToolCallRef[]; mismatched: number[]; untrusted: UntrustedField[] }> {
  const [owner, mandate] = await Promise.all([reader.ownerOf(request.agentId, pinned.number), reader.mandate(request.agentId, pinned.number)]);
  const scope = initialScope(request, owner, mandate);
  const modelCalls = doc.modelOutputs.flatMap((turn) => turn.toolCalls);
  const checked: ToolCallRef[] = [];
  const mismatched: number[] = [];
  const untrusted: UntrustedField[] = [];

  for (const [index, record] of doc.toolCalls.entries()) {
    // The model never saw this answer, nothing was screened for it, and nothing ran after it.
    if (isToolCallLimit(record.output)) continue;
    if (record.onchain) {
      checked.push({ index, name: record.name });
      const call = modelCalls[pairing[index] as number] as { arguments: string };
      const rerun = await runTool(record.name, call.arguments, { reader, pinned, request, nansen: NO_NANSEN, scope: new Set(scope) });
      if (!sameJson(rerun.output, record.output) || !sameJson(rerun.arguments, record.arguments) || rerun.onchain !== record.onchain) {
        mismatched.push(index);
      }
      untrusted.push(...rerun.untrusted);
    }
    collectAddresses(record.output, scope);
  }
  return { checked, mismatched, untrusted };
}

/**
 * For each tool-call record, the index of the recorded model tool call it answers: the first not yet
 * paired with the same id, which must have the same name. `null` unless every record has one and every
 * model tool call is paired, i.e. one to one (Nansen and `TOOL_CALL_LIMIT` records included): the agent
 * records exactly one answer for every tool call in every turn it receives.
 */
function pairToolCalls(doc: RiskEvidence): number[] | null {
  const calls = doc.modelOutputs.flatMap((turn) => turn.toolCalls);
  const used = new Set<number>();
  const pairs: number[] = [];
  for (const record of doc.toolCalls) {
    const i = calls.findIndex((call, j) => !used.has(j) && call.id === record.id);
    if (i < 0 || calls[i]?.name !== record.name) return null;
    used.add(i);
    pairs.push(i);
  }
  return used.size === calls.length ? pairs : null;
}

/**
 * The untrusted text validator B screened for the Nansen answers the model saw, derived from the
 * recorded (capped) answers with the same functions `runTool` uses. A label the output cap shortened is
 * a prefix of what was screened; one it removed is simply absent (its classifier result is an extra).
 */
function nansenFields(doc: RiskEvidence): UntrustedField[] {
  return doc.toolCalls.flatMap((record) => {
    if (isToolCallLimit(record.output)) return [];
    if (record.name === "nansen_counterparty_profile") return untrustedFromProfile(record.output);
    if (record.name === "nansen_flows") return untrustedFromFlows(record.output);
    return [];
  });
}

/**
 * Whether `result` can stand for `field`'s screening: the same source, a non-empty text, and that text
 * a substring of the field's (the guard records the highest-scoring chunk), or the field's text a prefix
 * of it (a string the output cap shortened after screening).
 */
function coversField(result: GuardResult, field: UntrustedField): boolean {
  return result.source === field.source && result.text.length > 0 && (field.text.includes(result.text) || result.text.startsWith(field.text));
}

/**
 * Whether every field can be given a distinct classifier result that covers it ({@link coversField}).
 * Extra results are allowed (labels the output cap removed were screened but aren't in the record), and
 * no order is required. A maximum bipartite matching (augmenting paths), so the answer never depends on
 * the order fields or results are tried in.
 */
function coversAll(fields: readonly UntrustedField[], results: readonly GuardResult[]): boolean {
  const owner: Array<number | undefined> = new Array(results.length);
  const assign = (f: number, seen: Set<number>): boolean => {
    const field = fields[f] as UntrustedField;
    for (let r = 0; r < results.length; r++) {
      if (seen.has(r) || !coversField(results[r] as GuardResult, field)) continue;
      seen.add(r);
      const current = owner[r];
      if (current === undefined || assign(current, seen)) {
        owner[r] = f;
        return true;
      }
    }
    return false;
  };
  return fields.every((_, f) => assign(f, new Set()));
}

/** The Nansen calls and the `TOOL_CALL_LIMIT` answers, by index, from the evidence alone. */
function classifyToolCalls(doc: RiskEvidence): { unchecked: ToolCallRef[]; notShown: ToolCallRef[] } {
  const unchecked: ToolCallRef[] = [];
  const notShown: ToolCallRef[] = [];
  doc.toolCalls.forEach((record, index) => {
    if (isToolCallLimit(record.output)) notShown.push({ index, name: record.name });
    else if (!record.onchain) unchecked.push({ index, name: record.name });
  });
  return { unchecked, notShown };
}

/** Whether `text` is exactly the canonical JSON the base would publish for `doc` (it rejects duplicate keys, whitespace, reordering). */
function isCanonical(doc: RiskEvidence, text: string): boolean {
  try {
    const rebuilt = buildEvidence({ tag: RISK_V1.tag, requestHash: doc.requestHash, result: { score: doc.score, reasons: doc.reasons, evidence: riskEvidence(doc) } });
    return canonicalJson(rebuilt) === text;
  } catch {
    return false;
  }
}

/** `doc`'s record with some parts replaced, for rebuilding one part exactly as `riskEvidence` writes it. */
function withRecord(doc: RiskEvidence, parts: Partial<Parameters<typeof riskEvidence>[0]>): Parameters<typeof riskEvidence>[0] {
  return { ...doc, ...parts };
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function isToolCallLimit(output: JsonValue): boolean {
  return canonicalJson(output) === TOOL_CALL_LIMIT;
}

/** `requestAt`'s problem as a `risk-v1` problem: it only ever reports these three. */
function requestProblem(problem: VerifyProblem): RiskVerifyProblem {
  switch (problem) {
    case "REQUEST_BLOCK_WRONG":
    case "REQUEST_INVALID":
    case "REQUEST_NOT_FOUND":
      return problem;
    default:
      throw new Error(`requestAt reported ${problem}, which it never reports`);
  }
}

function report(
  fields: Pick<RiskVerifyReport, "requestHash" | "validator" | "posted"> & Partial<RiskVerifyReport>,
  problems: RiskVerifyProblem[],
): RiskVerifyReport {
  const verdict: RiskVerifyReport["verdict"] =
    problems.length === 0 ? "match" : problems.some((problem) => RISK_MISMATCH_PROBLEMS.has(problem)) ? "mismatch" : "unverifiable";
  return {
    requestHash: fields.requestHash,
    validator: fields.validator,
    pinnedBlock: fields.pinnedBlock ?? null,
    pinned: fields.pinned ?? null,
    match: verdict === "match",
    verdict,
    posted: fields.posted,
    recomputed: fields.recomputed ?? null,
    problems,
    mismatchedToolCalls: fields.mismatchedToolCalls ?? [],
    checkedToolCalls: fields.checkedToolCalls ?? [],
    uncheckedToolCalls: fields.uncheckedToolCalls ?? [],
    notShownToolCalls: fields.notShownToolCalls ?? [],
    model: fields.model ?? null,
    findings: fields.findings ?? [],
  };
}
