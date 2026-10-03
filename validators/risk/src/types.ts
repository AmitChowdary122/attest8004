import type { Address, Hex } from "viem";

/**
 * A JSON value with every number a safe integer (so it round-trips through every JSON parser
 * unchanged; a `bigint` is written as a decimal string instead — see `canonicalJson`). Tool
 * arguments and outputs, and the model's raw messages once parsed, are held this way before
 * `canonicalJson` renders them for evidence or for the model.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * One tool call the agent loop made and its answer (ARCHITECTURE "Tools"). `onchain` is `false` only
 * for the two Nansen tools, which `verify` reports as `unchecked` rather than re-running.
 *
 * Ruling R4 (controller): `arguments` holds the *parsed* JSON of the model's raw argument string when
 * that string parsed as JSON, or the raw string itself (as a `JsonValue` string) when it didn't — the
 * tool runner still answers an unparseable call (with `{error: "INVALID_ARGUMENTS"}` in `output`), so
 * the record keeps whatever the model actually sent instead of discarding it.
 */
export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: JsonValue;
  output: JsonValue;
  onchain: boolean;
}

/**
 * One model turn in the tool loop or the final structured call: the raw assistant message, before any
 * of our own validation runs. `toolCalls[].arguments` is the model's raw argument string, exactly as
 * served, not yet parsed — {@link ToolCallRecord.arguments} is the parsed form recorded once the tool
 * runner has looked at it.
 */
export interface TurnRecord {
  content: string | null;
  toolCalls: { id: string; name: string; arguments: string }[];
  finishReason: string;
  servedModel: string;
  systemFingerprint: string | null;
  usage: { prompt: number; completion: number; total: number };
}

/**
 * Validator A's (`mandate-v1`) verdict on the same action at the same pinned block `P`, read from its
 * own evidence (Decision 22a): the `requestHash` it answered, its `score`, the evidence's hash (its
 * `responseHash` on the log) and the reasons kept from its own evidence (only the known reason codes).
 * `tag` is always `"mandate-v1"`: a verdict from another validator, or with another tag, makes B
 * decline before this type is ever built.
 */
export interface Prerequisite {
  validator: Address;
  requestHash: Hex;
  score: number;
  responseHash: Hex;
  tag: "mandate-v1";
  reasons: string[];
}

/** `low` risks the gate's floor at 80, `medium` and above refuse it ({@link import("./findings.ts").scoreOf}). */
export type Severity = "low" | "medium" | "high";

/**
 * One finding, before code decides where it came from. `code` is one of
 * {@link import("./findings.ts").MODEL_FINDING_CODES} for a model finding, or
 * {@link import("./findings.ts").PROMPT_INJECTION_SUSPECTED} for the one code adds; `sources` names 1-4
 * of {@link import("./findings.ts").SOURCE_NAMES} for a model finding, or `classifier:<source>` for
 * code's own.
 */
export interface Finding {
  code: string;
  severity: Severity;
  explanation: string;
  sources: string[];
}

/** A {@link Finding} tagged with where it came from: the model's structured answer, or code's own rules. */
export interface RecordedFinding extends Finding {
  origin: "model" | "code";
}

/**
 * One untrusted text field's Prompt Guard screening (Decision 12-13): `source` names the field (a
 * tool name, `"request"`, or `"calldata_text"`), `text` is the exact chunk screened, `score` is the
 * guard's raw answer recorded as the string it returned (Groq documents neither the format nor a
 * threshold), and `flagged` is whether that score was >= `RISK_V1.guardThreshold`.
 */
export interface GuardResult {
  source: string;
  text: string;
  score: string;
  flagged: boolean;
}

/**
 * Everything `riskEvidence` serialises for a `risk-v1` verdict (Task 11's evidence key table,
 * reproduced in the P5 plan and the Task 6 brief), typed. Block numbers, timestamps and wei amounts
 * are `bigint`; addresses and hashes are viem's `Address`/`Hex`. **Provisional**: later tasks
 * (evidence.ts, verify.ts) may refine this shape as the exact re-derivation needs become concrete;
 * this file stays the source of truth for it either way.
 */
export interface RiskRecord {
  block: { number: bigint; hash: Hex; timestamp: bigint };
  /** `mandate-v1`'s request shape: the action's committed fields, without the raw `data` (its `selector` instead). */
  request: {
    block: bigint;
    chainId: number;
    gate: Address;
    agentId: bigint;
    target: Address;
    value: bigint;
    dataHash: Hex;
    selector: Hex | null;
    deadline: bigint;
    salt: Hex;
  };
  /** The `RISK_V1` fields `verify` re-derives from, plus the contracts and validator A's address it reads. */
  params: {
    maxToolCalls: number;
    invalidOutputRetries: number;
    guardThreshold: number;
    guardChunkChars: number;
    guardChunkOverlap: number;
    toolOutputMaxBytes: number;
    maxEvidenceBytes: number;
    simulationGas: bigint;
    maxTraceCalls: number;
    ageProbeBlocks: bigint[];
    reputationMaxClients: number;
    nansenWindowSeconds: bigint;
    nansenMaxLabels: number;
    nansenMaxCounterparties: number;
    maxFindings: number;
    maxExplanationChars: number;
    maxSourcesPerFinding: number;
    calldataTextMinChars: number;
    calldataTextMaxChars: number;
    calldataHeadBytes: number;
    maxDeadlineAheadSeconds: bigint;
    contracts: {
      identityRegistry: Address;
      reputationRegistry: Address;
      validationRegistry: Address;
      mandateRegistry: Address;
      forwarder: Address;
    };
    mandateValidator: Address;
  };
  prerequisite: Prerequisite;
  /** The LLM endpoint recorded as host only (never the URL or key), per every call actually made. */
  llm: {
    host: string;
    model: string;
    servedModels: string[];
    systemFingerprints: (string | null)[];
    promptVersion: string;
    promptHash: Hex;
    usage: { prompt: number; completion: number; total: number };
  };
  classifier: {
    model: string;
    threshold: number;
    results: GuardResult[];
  };
  tools: {
    nansen: { available: boolean; reason: string | null };
  };
  toolCalls: ToolCallRecord[];
  modelOutputs: TurnRecord[];
  finalOutput: { raw: string; attempts: number };
  findings: RecordedFinding[];
}
