/**
 * One `risk-v1` verdict at the pinned block `P` (the P5 plan's Decisions 12-13, 22-25): validator A's
 * verdict read back from A's own evidence (`readPrerequisite`), the calldata's text screened, the
 * agent loop run, code's own findings added, the score computed, and the whole trace serialised as
 * public evidence (`runRiskV1`).
 */
import { buildEvidence, canonicalJson, decodeJsonDataUri, type CheckResult } from "@attest8004/sdk";
import {
  MANDATE_REASONS,
  MANDATE_V1,
  MAX_EVIDENCE_URI_BYTES,
  parseApprovalParts,
  requestEvidence,
  selectorOf,
  statusOrUnknown,
  type MandateInputs,
  type PinnedBlock,
  type VerifyReader,
} from "@attest8004/validator-mandate";
import { getAddress, keccak256, size, slice, stringToBytes, zeroHash, type Address, type Hex } from "viem";
import { InitialMessagesTooLargeError, promptParams, runAgent, type AgentResult } from "./agent.ts";
import { riskEvidence, riskParams } from "./evidence.ts";
import { injectionFinding, parseModelOutput, scoreOf } from "./findings.ts";
import { screen, type PromptGuard } from "./guard.ts";
import type { ChatClient } from "./llm.ts";
import { NANSEN_NO_KEY_REASON, type NansenClient } from "./nansen.ts";
import { RISK_V1 } from "./params.ts";
import { initialMessages, PROMPT_VERSION, promptHash, type InitialData } from "./prompt.ts";
import type { RiskAddresses, RiskReader } from "./reader.ts";
import { initialScope, TOOL_DEFINITIONS, weiToMon } from "./tools.ts";
import type { JsonValue, Prerequisite, RecordedFinding, RiskRecord } from "./types.ts";
import { calldataText } from "./untrusted.ts";

/**
 * State at `P` shows validator A's verdict, but its `ValidationResponse` log wasn't found at the blocks
 * carrying its `lastUpdate` timestamp. That is RPC or log-index lag, not evidence about the verdict,
 * so it is never a decline: the check throws and the base retries it (`verify` exits 2).
 */
export class PrerequisiteLogNotFoundError extends Error {
  readonly requestHash: Hex;
  readonly lastUpdate: bigint;

  constructor(requestHash: Hex, lastUpdate: bigint) {
    super(`no ValidationResponse log found for mandate-v1's verdict ${requestHash} at timestamp ${lastUpdate}; retry later`);
    this.name = "PrerequisiteLogNotFoundError";
    this.requestHash = requestHash;
    this.lastUpdate = lastUpdate;
  }
}

const KNOWN_REASONS: ReadonlySet<string> = new Set<string>(MANDATE_REASONS);

/** A string from the chain, quoted and bounded for a one-line decline reason. */
function quoted(value: string): string {
  return JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}…` : value);
}

/**
 * Validator A's (`mandate-v1`) verdict on `requestHashA` as it stands at the pinned block (Decision
 * 22a). Both `RiskValidator` (to decide whether it may run) and `verify` (to re-check the evidence's
 * `prerequisite`) call it, so they read it exactly the same way.
 *
 * - `"PENDING"`: at `P` the registry has no such request yet (`UnknownRequest`), or it has no response
 *   (a zero `responseHash` and an empty tag).
 * - `{ invalid }`: deterministic chain state that `risk-v1` must not run on — the response is from
 *   another validator than `mandateValidator`, or isn't tagged `mandate-v1`; or A's own evidence isn't
 *   an inline `data:` URI, doesn't hash to its `responseHash`, isn't `mandate-v1` evidence (mandate-v1's
 *   own strict `parseApprovalParts`), or names another request. The reason is our own fixed text.
 * - Otherwise the {@link Prerequisite}: A's address, `requestHashA`, its score and `responseHash` from
 *   the status at `P`, and the reasons in A's evidence, keeping only the 12 known `mandate-v1` codes,
 *   each once, in their first-seen order there (anything else in that list never reaches the model as
 *   one of A's reasons).
 *
 * Throws on an RPC failure, and with {@link PrerequisiteLogNotFoundError} when A's response log can't
 * be found (lag), so neither ever becomes a verdict or a decline.
 */
export async function readPrerequisite(
  reader: VerifyReader,
  o: { mandateValidator: Address; requestHashA: Hex; pinned: PinnedBlock },
): Promise<Prerequisite | "PENDING" | { invalid: string }> {
  const requestHashA = o.requestHashA.toLowerCase() as Hex;
  const status = await statusOrUnknown(reader, requestHashA, o.pinned.number);
  if (status === null || (status.responseHash === zeroHash && status.tag === "")) return "PENDING";
  const validator = getAddress(status.validator);
  const expected = getAddress(o.mandateValidator);
  if (validator !== expected) return { invalid: `answered by ${validator}, not validator A (${expected})` };
  if (status.tag !== MANDATE_V1.tag) return { invalid: `tagged ${quoted(status.tag)}, not "mandate-v1"` };

  const uri = await reader.responseEvidence(requestHashA, status.lastUpdate, o.pinned.number);
  if (uri === null) throw new PrerequisiteLogNotFoundError(requestHashA, status.lastUpdate);
  const decoded = decodeJsonDataUri(uri, MAX_EVIDENCE_URI_BYTES);
  if (!decoded.ok) return { invalid: `A's evidence is not an inline data: URI (${decoded.reason})` };
  const responseHash = status.responseHash.toLowerCase() as Hex;
  if (keccak256(stringToBytes(decoded.text)) !== responseHash) return { invalid: "A's evidence doesn't hash to its responseHash" };
  const parts = parseApprovalParts(decoded.text);
  if ("error" in parts) return { invalid: `A's evidence is not mandate-v1 evidence (${parts.error})` };
  if (parts.requestHash !== requestHashA) return { invalid: "A's evidence names another request" };
  // parseApprovalParts checked that `reasons` is an array of strings.
  const { reasons } = JSON.parse(decoded.text) as { reasons: string[] };
  return {
    validator,
    requestHash: requestHashA,
    score: status.response,
    responseHash,
    tag: "mandate-v1",
    reasons: [...new Set(reasons.filter((reason) => KNOWN_REASONS.has(reason)))],
  };
}

/**
 * The calldata's untrusted text exactly as validator B screens it before the first model call
 * (Decision 12): one field, `calldata_text`, every printable run (`calldataText`) joined by newlines;
 * no field when there is no run. Exported so `verify` derives the same field to check that it was
 * screened.
 */
export function calldataFields(data: Hex): { source: string; text: string }[] {
  const runs = calldataText(data);
  return runs.length === 0 ? [] : [{ source: "calldata_text", text: runs.map((run) => run.text).join("\n") }];
}

/** The data's first `RISK_V1.calldataHeadBytes` bytes, lower-case (all of it when shorter). */
function dataHeadOf(data: Hex): Hex {
  const head = size(data) <= RISK_V1.calldataHeadBytes ? data : slice(data, 0, RISK_V1.calldataHeadBytes);
  return head.toLowerCase() as Hex;
}

/** Each value once, in the order first seen. */
function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** A record whose answer the model never saw: past the call cap, or refused by the token budget. */
function isToolCallLimit(output: JsonValue): boolean {
  return canonicalJson(output) === canonicalJson({ error: "TOOL_CALL_LIMIT" });
}

/**
 * Why the model's output still failed after its retries, as our own fixed text: `tool_use_failed`
 * when the budget ran out in the tool loop (no final call was made), `json_validate_failed` when the
 * last final answer was the provider's failed generation and would itself have parsed, and otherwise
 * `parseModelOutput`'s own error for the last final answer.
 */
function lastOutputError(agent: AgentResult): string {
  if (agent.final === null) return "tool_use_failed";
  const ran = agent.toolCalls.filter((call) => !isToolCallLimit(call.output)).map((call) => call.name);
  const parsed = parseModelOutput(agent.final.raw, new Set(["request", "mandate_v1_verdict", ...ran]));
  return parsed.ok ? "json_validate_failed" : parsed.error;
}

/**
 * Runs one `risk-v1` check at `pinned` (`P`), once validator A's verdict is answered there
 * (`prerequisite`, from {@link readPrerequisite}):
 *
 * 1. Builds the first message's data: the request (value in wei and MON, selector, data length, the
 *    first `RISK_V1.calldataHeadBytes` bytes of data), the calldata's printable text, A's score and
 *    known reasons, `P`, and whether Nansen is available.
 * 2. **Screens the calldata's text with Prompt Guard before any model call** (one field,
 *    `calldata_text`: every printable run, joined by newlines; nothing when there is none).
 * 3. Runs the agent loop (`runAgent`), whose tool reads are all at `P`; it screens tool text itself.
 * 4. Findings are the model's (`origin: "model"`) then code's `PROMPT_INJECTION_SUSPECTED` over every
 *    guard result (`origin: "code"`); the score is `scoreOf(findings)` and `reasons` their codes.
 * 5. Serialises the whole trace with {@link riskEvidence}.
 *
 * Declines (no response, no retry) with `PROMPT_TOO_LARGE: <estimate> tokens` when the initial
 * messages leave no room for 3 tool answers (`runAgent`'s `InitialMessagesTooLargeError`, before any
 * model call), with `MODEL_OUTPUT_INVALID: <last error>` when the model's output still failed after
 * its retries, and with `EVIDENCE_TOO_LARGE: <bytes> bytes` when the document the
 * base would publish is over `RISK_V1.maxEvidenceBytes` of canonical JSON, so the response gas cap can
 * never fail a send after the model ran. Rejects on a transient provider failure and on any other
 * failure (a chain read, the guard), with no partial result: the base retries the request later.
 */
export async function runRiskV1(o: {
  reader: RiskReader;
  llm: ChatClient;
  guard: PromptGuard;
  nansen: NansenClient;
  model: string;
  addresses: RiskAddresses;
  mandateValidator: Address;
  request: MandateInputs["request"];
  pinned: PinnedBlock;
  prerequisite: Prerequisite;
}): Promise<CheckResult | { decline: string }> {
  const { reader, llm, guard, nansen, model, addresses, mandateValidator, request, pinned, prerequisite } = o;
  const [owner, mandate] = await Promise.all([reader.ownerOf(request.agentId, pinned.number), reader.mandate(request.agentId, pinned.number)]);

  const text = calldataText(request.data);
  const data: InitialData = {
    request: {
      block: request.block,
      chainId: request.chainId,
      gate: getAddress(request.gate),
      agentId: request.agentId,
      target: getAddress(request.target),
      value: request.value,
      valueMon: weiToMon(request.value),
      selector: selectorOf(request.data),
      dataLength: size(request.data),
      dataHead: dataHeadOf(request.data),
      deadline: request.deadline,
      salt: request.salt.toLowerCase() as Hex,
    },
    calldataText: text,
    mandateV1: { score: prerequisite.score, reasons: [...prerequisite.reasons] },
    pinned: { number: pinned.number.toString(), timestamp: pinned.timestamp.toString() },
    nansen: nansen.available ? null : (nansen.reason ?? NANSEN_NO_KEY_REASON),
  };

  // Screened before the model sees any of it (Decision 12).
  const fields = calldataFields(request.data);
  const initialGuard = await screen(guard, fields, RISK_V1.guardThreshold);

  let agent: AgentResult;
  try {
    agent = await runAgent({
      llm,
      guard,
      model,
      data,
      tools: { reader, pinned, request, nansen, scope: initialScope(request, owner, mandate) },
      initialGuard,
    });
  } catch (error) {
    // Deterministic for this request: a retry could never fit, so decline once instead.
    if (error instanceof InitialMessagesTooLargeError) return { decline: `PROMPT_TOO_LARGE: ${error.estimate} tokens` };
    throw error;
  }
  if (agent.findings === null || agent.final === null) return { decline: `MODEL_OUTPUT_INVALID: ${lastOutputError(agent)}` };

  const injection = injectionFinding(agent.guard);
  const findings: RecordedFinding[] = [
    ...agent.findings.map((f): RecordedFinding => ({ code: f.code, severity: f.severity, explanation: f.explanation, sources: [...f.sources], origin: "model" })),
    ...(injection === null ? [] : [injection]),
  ];
  const score = scoreOf(findings);
  const reasons = findings.map((f) => f.code);

  const record: RiskRecord = {
    block: pinned,
    request: requestEvidence(request),
    params: riskParams(addresses, mandateValidator),
    prerequisite,
    llm: {
      host: llm.host,
      model,
      servedModels: distinct(agent.turns.map((turn) => turn.servedModel)),
      systemFingerprints: distinct(agent.turns.map((turn) => turn.systemFingerprint)),
      promptVersion: PROMPT_VERSION,
      promptHash: promptHash(initialMessages(data), TOOL_DEFINITIONS, promptParams(model)),
      usage: { ...agent.usage },
    },
    classifier: { model: guard.model, threshold: String(RISK_V1.guardThreshold), results: agent.guard },
    tools: { nansen: { available: nansen.available, reason: nansen.available ? null : (nansen.reason ?? NANSEN_NO_KEY_REASON) } },
    toolCalls: agent.toolCalls,
    modelOutputs: agent.turns,
    finalOutput: { raw: agent.final.raw, attempts: agent.final.attempts },
    findings,
  };
  const evidence = riskEvidence(record);

  // Measured exactly as the base will publish it: canonical JSON of buildEvidence's document.
  const bytes = stringToBytes(canonicalJson(buildEvidence({ tag: RISK_V1.tag, requestHash: request.requestHash, result: { score, reasons, evidence } }))).length;
  if (bytes > RISK_V1.maxEvidenceBytes) return { decline: `EVIDENCE_TOO_LARGE: ${bytes} bytes` };
  return { score, reasons, evidence };
}
