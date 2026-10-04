/**
 * `risk-v1`'s public evidence document (ARCHITECTURE §6; the P5 plan's Decisions 25-27): what
 * `riskEvidence` adds after the base's `schema`, `validator`, `requestHash`, `score` and `reasons`,
 * and `parseRiskEvidence`, the strict parser `verify` reads it back with.
 *
 * **This format freezes once the first live verdict exists**, as `mandate-v1`'s did: no key may be
 * added, removed or renamed, and no value's encoding may change, without a new tag. Only the prompt
 * may still change, under `promptVersion`.
 */
import { EVIDENCE_SCHEMA_V1 } from "@attest8004/sdk";
import { getAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { CODE_FINDING_CODES, MODEL_FINDING_CODES } from "./findings.ts";
import { RISK_V1 } from "./params.ts";
import type { RiskAddresses } from "./reader.ts";
import { NANSEN_TOOLS } from "./tools.ts";
import type { JsonValue, RiskParams, RiskRecord } from "./types.ts";

/** A parsed `risk-v1` evidence document: the base's five fields, then the record. */
export type RiskEvidence = {
  schema: typeof EVIDENCE_SCHEMA_V1;
  validator: "risk-v1";
  requestHash: Hex;
  score: number;
  reasons: string[];
} & RiskRecord;

/** A non-integer constant as the decimal string the evidence records (Ruling R4). */
function decimalString(value: number): string {
  return String(value);
}

/**
 * The `params` every honest `risk-v1` verdict records on a chain (see {@link RiskParams}), given the
 * contracts valid at its pinned block `P` (`riskAddressesAt(contracts, P)`: the MandateRegistry valid
 * there) and validator A.
 */
export function riskParams(addresses: RiskAddresses, mandateValidator: Address): RiskParams {
  return {
    maxToolCalls: RISK_V1.maxToolCalls,
    invalidOutputRetries: RISK_V1.invalidOutputRetries,
    reasoningEffort: RISK_V1.reasoningEffort,
    temperature: decimalString(RISK_V1.temperature),
    seed: RISK_V1.seed,
    toolTurnMaxCompletionTokens: RISK_V1.toolTurnMaxCompletionTokens,
    finalMaxCompletionTokens: RISK_V1.finalMaxCompletionTokens,
    maxRequestTokens: RISK_V1.maxRequestTokens,
    maxCheckTokens: RISK_V1.maxCheckTokens,
    guardThreshold: decimalString(RISK_V1.guardThreshold),
    guardChunkChars: RISK_V1.guardChunkChars,
    guardChunkOverlap: RISK_V1.guardChunkOverlap,
    toolOutputMaxBytes: RISK_V1.toolOutputMaxBytes,
    maxEvidenceBytes: RISK_V1.maxEvidenceBytes,
    simulationGas: RISK_V1.simulationGas,
    maxTraceCalls: RISK_V1.maxTraceCalls,
    maxRevertReasonChars: RISK_V1.maxRevertReasonChars,
    ageProbeBlocks: [...RISK_V1.ageProbeBlocks],
    reputationMaxClients: RISK_V1.reputationMaxClients,
    nansenWindowSeconds: RISK_V1.nansenWindowSeconds,
    nansenMaxLabels: RISK_V1.nansenMaxLabels,
    nansenMaxCounterparties: RISK_V1.nansenMaxCounterparties,
    maxFindings: RISK_V1.maxFindings,
    maxExplanationChars: RISK_V1.maxExplanationChars,
    maxSourcesPerFinding: RISK_V1.maxSourcesPerFinding,
    calldataTextMinChars: RISK_V1.calldataTextMinChars,
    calldataTextMaxChars: RISK_V1.calldataTextMaxChars,
    calldataTextMaxRuns: RISK_V1.calldataTextMaxRuns,
    calldataHeadBytes: RISK_V1.calldataHeadBytes,
    maxDeadlineAheadSeconds: RISK_V1.maxDeadlineAheadSeconds,
    scores: { ...RISK_V1.scores },
    contracts: {
      identityRegistry: addresses.identityRegistry,
      reputationRegistry: addresses.reputationRegistry,
      validationRegistry: addresses.validationRegistry,
      mandateRegistry: addresses.mandateRegistry,
      forwarder: addresses.forwarder,
    },
    mandateValidator,
  };
}

/**
 * The `risk-v1` keys of an evidence document (ARCHITECTURE §6), added by `buildEvidence` after the
 * base's; none reuses a base key.
 *
 * | Key | Contents |
 * |---|---|
 * | `block` | `P`: `{number, hash, timestamp}` |
 * | `request` | exactly `mandate-v1`'s request object (`requestEvidence`) |
 * | `params` | {@link RiskParams} |
 * | `prerequisite` | validator A's verdict at `P`: `{validator, requestHash, score, responseHash, tag, reasons}` |
 * | `llm` | `{host, model, servedModels, systemFingerprints, promptVersion, promptHash, usage}` |
 * | `classifier` | `{model, threshold: "0.5", results}` |
 * | `tools` | `{nansen: {available, reason}}` |
 * | `toolCalls` | `[{id, name, arguments, output, onchain}]` |
 * | `modelOutputs` | every model response, tool turns and final attempts alike |
 * | `finalOutput` | `{raw, attempts}` |
 * | `findings` | `[{code, severity, explanation, sources, origin}]`, the model's then code's |
 *
 * Built field by field, so the document's shape never depends on what else an input carries.
 * Addresses are EIP-55 and hashes lower-case, so the bytes don't depend on the input's letter case.
 * Integers stay `bigint`; `canonicalJson` writes them as decimal strings.
 */
export function riskEvidence(r: RiskRecord): Record<string, unknown> {
  const { block, request, params, prerequisite, llm, classifier, tools, toolCalls, modelOutputs, finalOutput, findings } = r;
  return {
    block: { number: block.number, hash: lower(block.hash), timestamp: block.timestamp },
    request: {
      block: request.block,
      chainId: request.chainId,
      gate: getAddress(request.gate),
      agentId: request.agentId,
      target: getAddress(request.target),
      value: request.value,
      dataHash: lower(request.dataHash),
      selector: request.selector === null ? null : lower(request.selector),
      deadline: request.deadline,
      salt: lower(request.salt),
    },
    params: {
      maxToolCalls: params.maxToolCalls,
      invalidOutputRetries: params.invalidOutputRetries,
      reasoningEffort: params.reasoningEffort,
      temperature: params.temperature,
      seed: params.seed,
      toolTurnMaxCompletionTokens: params.toolTurnMaxCompletionTokens,
      finalMaxCompletionTokens: params.finalMaxCompletionTokens,
      maxRequestTokens: params.maxRequestTokens,
      maxCheckTokens: params.maxCheckTokens,
      guardThreshold: params.guardThreshold,
      guardChunkChars: params.guardChunkChars,
      guardChunkOverlap: params.guardChunkOverlap,
      toolOutputMaxBytes: params.toolOutputMaxBytes,
      maxEvidenceBytes: params.maxEvidenceBytes,
      simulationGas: params.simulationGas,
      maxTraceCalls: params.maxTraceCalls,
      maxRevertReasonChars: params.maxRevertReasonChars,
      ageProbeBlocks: [...params.ageProbeBlocks],
      reputationMaxClients: params.reputationMaxClients,
      nansenWindowSeconds: params.nansenWindowSeconds,
      nansenMaxLabels: params.nansenMaxLabels,
      nansenMaxCounterparties: params.nansenMaxCounterparties,
      maxFindings: params.maxFindings,
      maxExplanationChars: params.maxExplanationChars,
      maxSourcesPerFinding: params.maxSourcesPerFinding,
      calldataTextMinChars: params.calldataTextMinChars,
      calldataTextMaxChars: params.calldataTextMaxChars,
      calldataTextMaxRuns: params.calldataTextMaxRuns,
      calldataHeadBytes: params.calldataHeadBytes,
      maxDeadlineAheadSeconds: params.maxDeadlineAheadSeconds,
      scores: { none: params.scores.none, low: params.scores.low, medium: params.scores.medium, high: params.scores.high },
      contracts: {
        identityRegistry: getAddress(params.contracts.identityRegistry),
        reputationRegistry: getAddress(params.contracts.reputationRegistry),
        validationRegistry: getAddress(params.contracts.validationRegistry),
        mandateRegistry: getAddress(params.contracts.mandateRegistry),
        forwarder: getAddress(params.contracts.forwarder),
      },
      mandateValidator: getAddress(params.mandateValidator),
    },
    prerequisite: {
      validator: getAddress(prerequisite.validator),
      requestHash: lower(prerequisite.requestHash),
      score: prerequisite.score,
      responseHash: lower(prerequisite.responseHash),
      tag: prerequisite.tag,
      reasons: [...prerequisite.reasons],
    },
    llm: {
      host: llm.host,
      model: llm.model,
      servedModels: [...llm.servedModels],
      systemFingerprints: [...llm.systemFingerprints],
      promptVersion: llm.promptVersion,
      promptHash: lower(llm.promptHash),
      usage: usageOf(llm.usage),
    },
    classifier: {
      model: classifier.model,
      threshold: classifier.threshold,
      results: classifier.results.map((g) => ({ source: g.source, text: g.text, score: g.score, flagged: g.flagged })),
    },
    tools: { nansen: { available: tools.nansen.available, reason: tools.nansen.reason } },
    toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments, output: c.output, onchain: c.onchain })),
    modelOutputs: modelOutputs.map((t) => ({
      content: t.content,
      toolCalls: t.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
      finishReason: t.finishReason,
      servedModel: t.servedModel,
      systemFingerprint: t.systemFingerprint,
      usage: usageOf(t.usage),
    })),
    finalOutput: { raw: finalOutput.raw, attempts: finalOutput.attempts },
    findings: findings.map((f) => ({ code: f.code, severity: f.severity, explanation: f.explanation, sources: [...f.sources], origin: f.origin })),
  };
}

function usageOf(u: { prompt: number; completion: number; total: number }) {
  return { prompt: u.prompt, completion: u.completion, total: u.total };
}

function lower(hex: Hex): Hex {
  return hex.toLowerCase() as Hex;
}

// ---- the strict parser ----

const UINT256_MAX = 2n ** 256n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;
const DECIMAL = /^(0|[1-9]\d*)$/;
/** A decimal number as `String(n)` writes a non-negative one below 1e21: no leading zeros, no trailing fractional zeros. */
const DECIMAL_FRACTION = /^(0|[1-9]\d*)(\.\d*[1-9])?$/;

// zod runs a refinement even after the regex has failed, so the range check repeats the regex.
const decimal = (max: bigint) =>
  z
    .string()
    .regex(DECIMAL)
    .refine((s) => DECIMAL.test(s) && BigInt(s) <= max)
    .transform((s) => BigInt(s));
const uint64 = decimal(UINT64_MAX);
const uint256 = decimal(UINT256_MAX);
/** A safe integer: canonical JSON has no floats and no integers past 2^53. */
const safeInt = z.number().refine((n) => Number.isSafeInteger(n));
const count = safeInt.refine((n) => n >= 0);
const fraction = z.string().regex(DECIMAL_FRACTION);
/** EIP-55 exactly, as `riskEvidence` writes it, so a parsed document rebuilds the same bytes. */
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((s) => /^0x[0-9a-fA-F]{40}$/.test(s) && getAddress(s) === s)
  .transform((s) => s as Address);
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/)
  .transform((s) => s as Hex);
const selector = z.union([z.string().regex(/^0x[0-9a-f]{8}$/).transform((s) => s as Hex), z.null()]);
const usage = z.strictObject({ prompt: count, completion: count, total: count });

/**
 * Where the first problem in free-form JSON is (a path relative to `value`), or `null` when there is
 * none: every number a safe integer, every object plain, and **no object with an own `__proto__` key**.
 * zod's records drop such a key silently while `canonicalJson` writes it, so without this check a
 * forged fact (even a float) could hide in a tool output and survive a canonical comparison of the
 * parsed document (fix round 1 for Task 11). Walks the raw parsed input, before zod copies anything.
 */
function freeJsonProblem(value: unknown, path: PropertyKey[]): PropertyKey[] | null {
  if (value === null || typeof value === "boolean" || typeof value === "string") return null;
  if (typeof value === "number") return Number.isSafeInteger(value) ? null : path;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const problem = freeJsonProblem(value[i], [...path, i]);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (typeof value !== "object") return path;
  const proto = Object.getPrototypeOf(value);
  if ((proto !== Object.prototype && proto !== null) || Object.prototype.hasOwnProperty.call(value, "__proto__")) return path;
  for (const [key, item] of Object.entries(value)) {
    const problem = freeJsonProblem(item, [...path, key]);
    if (problem !== null) return problem;
  }
  return null;
}

/** Free-form JSON: tool arguments and outputs (see {@link freeJsonProblem}). */
const jsonValue = z
  .unknown()
  .superRefine((value, ctx) => {
    const problem = freeJsonProblem(value, []);
    if (problem !== null) ctx.addIssue({ code: "custom", message: "invalid", path: problem });
  })
  .transform((value) => value as JsonValue);

const NANSEN: ReadonlySet<string> = new Set<string>(NANSEN_TOOLS);

const toolCallSchema = z
  .strictObject({ id: z.string(), name: z.string(), arguments: jsonValue, output: jsonValue, onchain: z.boolean() })
  // A tool call is onchain exactly when it isn't one of the two Nansen tools (whatever its outcome),
  // so `verify` can never be told to skip re-running an onchain one.
  .refine((c) => c.onchain === !NANSEN.has(c.name), { path: ["onchain"] });

const riskEvidenceSchema = z.strictObject({
  schema: z.literal(EVIDENCE_SCHEMA_V1),
  validator: z.literal(RISK_V1.tag),
  requestHash: bytes32,
  score: safeInt.refine((n) => n >= 0 && n <= 100),
  reasons: z.array(z.string()),
  block: z.strictObject({ number: uint64, hash: bytes32, timestamp: uint64 }),
  request: z.strictObject({
    block: uint64,
    chainId: safeInt.refine((n) => n > 0),
    gate: address,
    agentId: uint256,
    target: address,
    value: uint256,
    dataHash: bytes32,
    selector,
    deadline: uint64,
    salt: bytes32,
  }),
  params: z.strictObject({
    maxToolCalls: count,
    invalidOutputRetries: count,
    reasoningEffort: z.string(),
    temperature: fraction,
    seed: count,
    toolTurnMaxCompletionTokens: count,
    finalMaxCompletionTokens: count,
    maxRequestTokens: count,
    maxCheckTokens: count,
    guardThreshold: fraction,
    guardChunkChars: count,
    guardChunkOverlap: count,
    toolOutputMaxBytes: count,
    maxEvidenceBytes: count,
    simulationGas: uint64,
    maxTraceCalls: count,
    maxRevertReasonChars: count,
    ageProbeBlocks: z.array(uint64),
    reputationMaxClients: count,
    nansenWindowSeconds: uint64,
    nansenMaxLabels: count,
    nansenMaxCounterparties: count,
    maxFindings: count,
    maxExplanationChars: count,
    maxSourcesPerFinding: count,
    calldataTextMinChars: count,
    calldataTextMaxChars: count,
    calldataTextMaxRuns: count,
    calldataHeadBytes: count,
    maxDeadlineAheadSeconds: uint64,
    scores: z.strictObject({ none: count, low: count, medium: count, high: count }),
    contracts: z.strictObject({
      identityRegistry: address,
      reputationRegistry: address,
      validationRegistry: address,
      mandateRegistry: address,
      forwarder: address,
    }),
    mandateValidator: address,
  }),
  prerequisite: z.strictObject({
    validator: address,
    requestHash: bytes32,
    score: safeInt.refine((n) => n >= 0 && n <= 100),
    responseHash: bytes32,
    tag: z.literal("mandate-v1"),
    reasons: z.array(z.string()),
  }),
  llm: z.strictObject({
    host: z.string(),
    model: z.string(),
    servedModels: z.array(z.string()),
    systemFingerprints: z.array(z.union([z.string(), z.null()])),
    promptVersion: z.string(),
    promptHash: bytes32,
    usage,
  }),
  classifier: z.strictObject({
    model: z.string(),
    threshold: fraction,
    results: z.array(z.strictObject({ source: z.string(), text: z.string(), score: z.string(), flagged: z.boolean() })),
  }),
  tools: z.strictObject({ nansen: z.strictObject({ available: z.boolean(), reason: z.union([z.string(), z.null()]) }) }),
  toolCalls: z.array(toolCallSchema),
  modelOutputs: z.array(
    z.strictObject({
      content: z.union([z.string(), z.null()]),
      toolCalls: z.array(z.strictObject({ id: z.string(), name: z.string(), arguments: z.string() })),
      finishReason: z.string(),
      servedModel: z.string(),
      systemFingerprint: z.union([z.string(), z.null()]),
      usage,
    }),
  ),
  finalOutput: z.strictObject({ raw: z.string(), attempts: count.refine((n) => n >= 1) }),
  findings: z.array(
    z.strictObject({
      code: z.enum([...MODEL_FINDING_CODES, ...CODE_FINDING_CODES]),
      severity: z.enum(["low", "medium", "high"]),
      explanation: z.string(),
      sources: z.array(z.string()),
      origin: z.enum(["model", "code"]),
    }),
  ),
});

/** `toolCalls[2].output`-style path, from a zod issue's `path` (numbers are array indices). */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    if (typeof key === "number") out += `[${key}]`;
    else out += i === 0 ? String(key) : `.${String(key)}`;
  }
  return out === "" ? "root" : out;
}

/**
 * Parses a `risk-v1` evidence document (its JSON text) strictly: every key in the table of
 * {@link riskEvidence} (and the base's five) is required, an unknown key anywhere outside the
 * free-form tool `arguments`/`output` is invalid, and every value must have exactly the encoding
 * `riskEvidence` writes — decimal strings without leading zeros for `bigint`s, `"0.2"`-style decimal
 * strings for the two fractional constants, EIP-55 addresses, lower-case hashes, safe integers only
 * (a float or an integer past 2^53 anywhere, tool outputs included, is invalid). An object with an
 * own `__proto__` key is invalid anywhere: an unknown key in the strict objects, and `invalid at
 * <path of that object>` inside a tool's free-form `arguments` or `output`. A tool call must be
 * `onchain` exactly when it isn't a Nansen tool. So a parsed document, passed back through
 * `riskEvidence` and `buildEvidence`, gives the same canonical bytes. Never throws.
 *
 * Semantic checks (does the score follow from the findings, do the params match the constants, ...)
 * are `verify`'s, not this parser's. The error is one of a fixed set of our own strings, never a
 * library's message: `not JSON`, `not a JSON object`, `unknown key at <path>` (the object holding
 * it, or `root`), or `invalid at <path>` for the first failing field.
 */
export function parseRiskEvidence(text: string): { ok: true; doc: RiskEvidence } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, error: "not a JSON object" };
  let result: ReturnType<typeof riskEvidenceSchema.safeParse>;
  try {
    result = riskEvidenceSchema.safeParse(parsed);
  } catch {
    // Defence in depth: a refinement that throws on hostile input is still invalid.
    return { ok: false, error: "invalid at root" };
  }
  if (!result.success) {
    const issue = result.error.issues[0];
    if (issue === undefined) return { ok: false, error: "invalid at root" };
    const where = formatPath(issue.path);
    return { ok: false, error: issue.code === "unrecognized_keys" ? `unknown key at ${where}` : `invalid at ${where}` };
  }
  const doc: RiskEvidence = result.data;
  return { ok: true, doc };
}
