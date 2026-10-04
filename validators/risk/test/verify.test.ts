// `verifyRiskRequest` (Task 12): honest evidence is built by running `runRiskV1` with fakes and landed
// on the fake chain as validator B's response; every tamper is then posted with its own matching
// `responseHash`, so each test reaches the check it targets. No network anywhere.
import { buildEvidence, canonicalJson, encodeCanonicalJsonDataUri, toBase64, type CheckResult, type RequestJsonV1 } from "@attest8004/sdk";
import { mandateRequestOf, PIN_LAG_BLOCKS } from "@attest8004/validator-mandate";
import { encodeErrorResult, keccak256, stringToBytes, toHex, zeroAddress, type Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { PROMPT_INJECTION_SUSPECTED } from "../src/findings.ts";
import type { NansenClient } from "../src/nansen.ts";
import type { TraceResult } from "../src/trace.ts";
import type { JsonValue } from "../src/types.ts";
import { RISK_V1 } from "../src/params.ts";
import { PrerequisiteLogNotFoundError, readPrerequisite, runRiskV1 } from "../src/run.ts";
import { RISK_MISMATCH_PROBLEMS, verifyRiskRequest, type RiskVerifyProblem, type RiskVerifyReport } from "../src/verify.ts";
import {
  ADDRESSES,
  blockAt,
  calldataWith,
  chatResponse,
  CONTRACTS,
  contractsWith,
  FakeChain,
  fakeAction,
  fakeGuard,
  FakeRiskReader,
  findingsJson,
  GATE,
  INJECTION,
  landMandateVerdict,
  MODEL,
  NO_FINDINGS,
  P4_REGISTRY,
  PASS_THROUGH,
  passThroughTrace,
  requestPair,
  scriptedLlm,
  SINK,
  toolCall,
  tsOf,
  unavailableNansen,
  V2_REGISTRY,
  VALIDATOR_A,
  VALIDATOR_B,
  type Step,
} from "./helpers/risk-fakes.ts";

let chain: FakeChain;
let reader: FakeRiskReader;

beforeEach(() => {
  chain = new FakeChain();
  reader = new FakeRiskReader(chain);
});

/** The fake chain's registries "deployed" before every block these tests use. */
const CONTEXT = { contracts: CONTRACTS, mandateValidator: VALIDATOR_A, validationRegistryDeployBlock: 900n };
const REQUEST_BLOCK = 1_000n;
const PIN = 1_004n;
const RESPONSE_BLOCK = 1_010n;

const verify = (requestHash: Hex): Promise<RiskVerifyReport> => verifyRiskRequest({ reader, requestHash, context: CONTEXT });

/** The evidence as published: canonical JSON parsed back (bigints are decimal strings). */
type Doc = {
  score: number;
  reasons: string[];
  block: { number: string; hash: string; timestamp: string };
  request: Record<string, unknown>;
  params: Record<string, unknown>;
  prerequisite: { score: number; reasons: string[] } & Record<string, unknown>;
  classifier: { model: string; threshold: string; results: { source: string; text: string; score: string; flagged: boolean }[] };
  toolCalls: { id: string; name: string; arguments: unknown; output: Record<string, unknown>; onchain: boolean }[];
  modelOutputs: { content: string | null; toolCalls: { id: string; name: string; arguments: string }[] }[];
  finalOutput: { raw: string; attempts: number };
  findings: { code: string; severity: string; explanation: string; sources: string[]; origin: string }[];
} & Record<string, unknown>;

/** Lands `doc` as validator B's response to `rhB` in `block` (default 1,010), posting `score` (default the document's). */
function post(rhB: Hex, doc: unknown, o: { score?: number; block?: bigint; tag?: string } = {}): void {
  const { uri, hash } = encodeCanonicalJsonDataUri(doc);
  postUri(rhB, uri, hash, { score: o.score ?? (doc as Doc).score, block: o.block, tag: o.tag });
}

function postUri(rhB: Hex, uri: string, hash: Hex, o: { score?: number; block?: bigint; tag?: string } = {}): void {
  const block = o.block ?? RESPONSE_BLOCK;
  chain.land(rhB, { validator: VALIDATOR_B, response: o.score ?? 0, uri, hash, tag: o.tag ?? RISK_V1.tag, block });
  if (chain.finalized < block + PIN_LAG_BLOCKS) chain.finalized = block + PIN_LAG_BLOCKS;
}

/**
 * An honest `risk-v1` verdict: both requests in block 1,000, A's `mandate-v1` verdict in 1,001, B's run at
 * `P` = 1,004 with `steps` as the model, its evidence landed as B's response in 1,010.
 */
async function honest(o: { steps: Step[]; data?: Hex; nansen?: NansenClient; aScore?: number; aReasons?: string[] }): Promise<{
  rhA: Hex;
  rhB: Hex;
  jsonB: RequestJsonV1;
  result: CheckResult;
  doc: Doc;
}> {
  const { jsonA, jsonB, rhA, rhB } = requestPair(fakeAction({ data: o.data }));
  chain.addRequest(jsonA, REQUEST_BLOCK);
  chain.addRequest(jsonB, REQUEST_BLOCK);
  landMandateVerdict(chain, { jsonA, requestBlock: REQUEST_BLOCK, block: REQUEST_BLOCK + 1n, score: o.aScore ?? 100, reasons: o.aReasons ?? [] });
  const pinned = blockAt(PIN);
  const prerequisite = await readPrerequisite(reader, { mandateValidator: VALIDATOR_A, requestHashA: rhA, pinned });
  if (prerequisite === "PENDING" || "invalid" in prerequisite) throw new Error("test setup: A's verdict isn't readable at P");
  const result = await runRiskV1({
    reader,
    llm: scriptedLlm(o.steps).client,
    guard: fakeGuard(),
    nansen: o.nansen ?? unavailableNansen(),
    model: MODEL,
    addresses: ADDRESSES,
    mandateValidator: VALIDATOR_A,
    request: mandateRequestOf(jsonB, rhB, REQUEST_BLOCK),
    pinned,
    prerequisite,
  });
  if ("decline" in result) throw new Error(`test setup: declined ${result.decline}`);
  const doc = JSON.parse(canonicalJson(buildEvidence({ tag: RISK_V1.tag, requestHash: rhB, result }))) as Doc;
  post(rhB, doc, { score: result.score });
  return { rhA, rhB, jsonB, result, doc };
}

/** Traces the action, looks at the sink and reports the forward: score 0. */
function riskyRun(extra: Step[] = []): Step[] {
  return [
    chatResponse({ toolCalls: [toolCall("simulate_action")] }),
    chatResponse({ toolCalls: [toolCall("counterparty_onchain", { address: SINK })] }),
    ...extra,
    chatResponse({ content: "Enough." }),
    chatResponse({
      content: findingsJson([
        { code: "FUNDS_FORWARDED", severity: "high", explanation: "The target forwards all of it to the sink.", sources: ["simulate_action"] },
      ]),
    }),
  ];
}

function expectProblem(report: RiskVerifyReport, problem: RiskVerifyProblem): void {
  expect(report.problems).toEqual([problem]);
  expect(report.verdict).toBe(RISK_MISMATCH_PROBLEMS.has(problem) ? "mismatch" : "unverifiable");
}

const clone = <T>(value: T): T => structuredClone(value);

/** A trace whose top frame reverts with `Error(reason)`: the simulation's revert reason is screened text. */
function revertingTrace(reason: string): TraceResult {
  const output = encodeErrorResult({
    abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
    errorName: "Error",
    args: [reason],
  });
  return { ok: true, frame: { type: "CALL", from: GATE, to: PASS_THROUGH, value: "0x0", input: "0x", error: "execution reverted", output } };
}

/** A Nansen client with a key: each `profile` call answers the next of `profiles` (the last one repeats). */
function availableNansen(profiles: JsonValue[]): NansenClient {
  let call = 0;
  return {
    available: true,
    reason: null,
    profile: async () => profiles[Math.min(call++, profiles.length - 1)] ?? null,
    flows: async () => ({ available: true, counterparties: [{ address: SINK, labels: ["Counterparty label"] }] }),
  };
}

const steps = (...calls: ReturnType<typeof toolCall>[][]): Step[] => [
  ...calls.map((turn) => chatResponse({ toolCalls: turn })),
  chatResponse({ content: "Enough." }),
  chatResponse({ content: NO_FINDINGS }),
];

describe("verifyRiskRequest: an honest verdict", () => {
  it("honest verdict matches", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const report = await verify(rhB);

    expect(report).toMatchObject({
      requestHash: rhB,
      validator: VALIDATOR_B,
      pinnedBlock: PIN,
      verdict: "match",
      match: true,
      posted: { score: 0, tag: "risk-v1" },
      recomputed: { score: 0, reasons: ["FUNDS_FORWARDED"] },
      problems: [],
      mismatchedToolCalls: [],
      uncheckedToolCalls: [],
      model: MODEL,
    });
    expect(report.pinned).toEqual(blockAt(PIN));
    expect(report.checkedToolCalls).toEqual([
      { index: 0, name: "simulate_action" },
      { index: 1, name: "counterparty_onchain" },
    ]);
    expect(report.findings).toEqual(doc.findings);
  });

  it("a clean action with no tool calls matches at 100", async () => {
    const { rhB } = await honest({ steps: [chatResponse({ content: "Nothing to check." }), chatResponse({ content: NO_FINDINGS })] });
    const report = await verify(rhB);
    expect(report).toMatchObject({ verdict: "match", recomputed: { score: 100, reasons: [] }, checkedToolCalls: [] });
  });

  it("an injection-flagged run matches at 40: the code finding follows from the recorded classifier results", async () => {
    const { rhB } = await honest({ steps: [chatResponse({ content: "Nothing to check." }), chatResponse({ content: NO_FINDINGS })], data: calldataWith(INJECTION) });
    const report = await verify(rhB);
    expect(report).toMatchObject({ verdict: "match", recomputed: { score: 40, reasons: [PROMPT_INJECTION_SUSPECTED] } });
  });

  it("the address scope is rebuilt in call order: a call that was out of scope stays ADDRESS_OUT_OF_SCOPE, a later one runs", async () => {
    const { rhB, doc } = await honest({
      steps: [
        chatResponse({ toolCalls: [toolCall("counterparty_onchain", { address: SINK })] }),
        chatResponse({ toolCalls: [toolCall("simulate_action")] }),
        chatResponse({ toolCalls: [toolCall("counterparty_onchain", { address: SINK })] }),
        chatResponse({ content: "Enough." }),
        chatResponse({ content: NO_FINDINGS }),
      ],
    });
    expect(doc.toolCalls[0]?.output).toEqual({ error: "ADDRESS_OUT_OF_SCOPE" });
    expect(doc.toolCalls[2]?.output).toMatchObject({ address: SINK });
    const report = await verify(rhB);
    expect(report.verdict).toBe("match");
    expect(report.checkedToolCalls.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("invalid arguments and an unknown tool are re-checked deterministically", async () => {
    const { rhB, doc } = await honest({
      steps: [
        chatResponse({ toolCalls: [toolCall("counterparty_onchain", "{not json"), toolCall("erc8004_reputation", { agentId: "01" }), toolCall("get_secrets")] }),
        chatResponse({ content: "Enough." }),
        chatResponse({ content: NO_FINDINGS }),
      ],
    });
    expect(doc.toolCalls.map((c) => c.output)).toEqual([{ error: "INVALID_ARGUMENTS" }, { error: "INVALID_ARGUMENTS" }, { error: "UNKNOWN_TOOL" }]);
    const report = await verify(rhB);
    expect(report.verdict).toBe("match");
    expect(report.checkedToolCalls.map((c) => c.name)).toEqual(["counterparty_onchain", "erc8004_reputation", "get_secrets"]);
  });

  it("a TOOL_CALL_LIMIT answer is never re-run: the model never saw that tool's answer", async () => {
    const calls = Array.from({ length: RISK_V1.maxToolCalls + 2 }, () => toolCall("simulate_action"));
    const { rhB, doc } = await honest({ steps: [chatResponse({ toolCalls: calls }), chatResponse({ content: NO_FINDINGS })] });
    const limited = doc.toolCalls.flatMap((c, index) => (canonicalJson(c.output) === '{"error":"TOOL_CALL_LIMIT"}' ? [index] : []));
    expect(limited.length).toBeGreaterThanOrEqual(2);

    const before = reader.calls.filter((c) => c === "trace").length;
    const report = await verify(rhB);
    expect(report.verdict).toBe("match");
    expect(reader.calls.filter((c) => c === "trace").length - before).toBe(doc.toolCalls.length - limited.length);
    expect(report.notShownToolCalls.map((c) => c.index)).toEqual(limited);
    expect(report.checkedToolCalls).toHaveLength(doc.toolCalls.length - limited.length);
  });

  it("Nansen calls are listed unchecked and don't affect the verdict", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun([chatResponse({ toolCalls: [toolCall("nansen_flows", { address: SINK })] })]) });
    expect(doc.toolCalls[2]).toMatchObject({ name: "nansen_flows", onchain: false });
    const report = await verify(rhB);
    expect(report.verdict).toBe("match");
    expect(report.uncheckedToolCalls).toEqual([{ index: 2, name: "nansen_flows" }]);
    expect(report.checkedToolCalls.map((c) => c.index)).toEqual([0, 1]);

    // Nansen is offchain and advisory: verify can't re-check it, so an edited answer (with no labels to cover) is still no problem.
    const edited = clone(doc);
    edited.toolCalls[2]!.output = { available: true, counterparties: [] };
    post(rhB, edited);
    expect((await verify(rhB)).verdict).toBe("match");
  });

  it("a simulation's revert reason is screened before the model saw it, and its classifier result covers it", async () => {
    reader.traceResult = revertingTrace(INJECTION);
    const { rhB, doc } = await honest({ steps: steps([toolCall("simulate_action")]) });
    expect(doc.classifier.results.map((r) => [r.source, r.flagged])).toEqual([["tool:simulate_action", true]]);
    expect(doc.findings.map((f) => f.code)).toEqual([PROMPT_INJECTION_SUSPECTED]);
    expect(await verify(rhB)).toMatchObject({ verdict: "match", recomputed: { score: 40 } });
  });

  it("a nested frame's non-standard error text is screened as an extra result: flagged, the code finding follows and the run matches; benign, it still matches (final review A1)", async () => {
    const nested = (error: string): TraceResult => {
      const trace = passThroughTrace();
      if (!trace.ok) throw new Error("test setup: passThroughTrace is ok");
      return { ok: true, frame: { ...trace.frame, calls: [{ ...trace.frame.calls![0]!, error }] } };
    };
    const flagged = `execution reverted: ${INJECTION}`;
    reader.traceResult = nested(flagged);
    const { rhB, doc } = await honest({ steps: steps([toolCall("simulate_action")]) });
    expect(doc.classifier.results).toEqual([{ source: "tool:simulate_action", text: flagged, score: "0.9995530247688293", flagged: true }]);
    expect(doc.findings.map((f) => [f.code, f.origin])).toEqual([[PROMPT_INJECTION_SUSPECTED, "code"]]);
    expect(await verify(rhB)).toMatchObject({ verdict: "match", recomputed: { score: 40, reasons: [PROMPT_INJECTION_SUSPECTED] } });

    // verify derives no field from it (runTool's `untrusted` is unchanged), so the result is an extra one, which is allowed.
    chain = new FakeChain();
    reader = new FakeRiskReader(chain);
    reader.traceResult = nested("some node's own words");
    const benign = await honest({ steps: steps([toolCall("simulate_action")]) });
    expect(benign.doc.classifier.results.map((r) => [r.text, r.flagged])).toEqual([["some node's own words", false]]);
    expect(await verify(benign.rhB)).toMatchObject({ verdict: "match", recomputed: { score: 100 } });
  });

  it("calldata text longer than one guard chunk: the recorded (highest-scoring) chunk covers it", async () => {
    const text = `${"x".repeat(420)} ${INJECTION}`;
    const { rhB, doc } = await honest({ steps: riskyRun(), data: calldataWith(text) });
    const [result] = doc.classifier.results;
    expect(result).toMatchObject({ source: "calldata_text", flagged: true });
    // The second chunk (from 360) is the flagged one, not the start of the text.
    expect(text.startsWith(result!.text)).toBe(false);
    expect(text.includes(result!.text)).toBe(true);
    expect(await verify(rhB)).toMatchObject({ verdict: "match", recomputed: { reasons: ["FUNDS_FORWARDED", PROMPT_INJECTION_SUSPECTED] } });
  });

  it("an answer never shown to the model (TOOL_CALL_LIMIT) needs no classifier result", async () => {
    reader.traceResult = revertingTrace("a benign revert reason");
    const calls = Array.from({ length: RISK_V1.maxToolCalls + 2 }, () => toolCall("simulate_action"));
    const { rhB, doc } = await honest({ steps: steps(calls) });
    const shown = doc.toolCalls.filter((c) => canonicalJson(c.output) !== '{"error":"TOOL_CALL_LIMIT"}').length;
    expect(shown).toBeLessThan(doc.toolCalls.length);
    expect(doc.classifier.results).toHaveLength(shown);
    expect((await verify(rhB)).verdict).toBe("match");
  });

  it("Nansen labels are covered by their classifier results, screened as the output cap left them (removed ones aren't screened, shortened ones are screened shortened)", async () => {
    const many = {
      available: true,
      labels: Array.from({ length: 20 }, (_, i) => ({ label: `entity label ${i} ${"x".repeat(48)}`, category: "cex", kind: ["hot_wallet"] })),
      firstFunder: { address: SINK, name: "first funder name" },
    };
    const longName = "n".repeat(390);
    const shortened = { available: true, labels: [], firstFunder: { name: longName, a: "a".repeat(389), b: "b".repeat(389), c: "c".repeat(389) } };
    const { rhB, doc } = await honest({
      steps: steps([toolCall("nansen_counterparty_profile", { address: PASS_THROUGH })], [toolCall("nansen_counterparty_profile", { address: PASS_THROUGH })]),
      nansen: availableNansen([many, shortened]),
    });
    // The cap removed labels from the first answer and shortened the funder's name in the second.
    const first = doc.toolCalls[0]!.output as { labels: unknown[]; truncated?: unknown };
    expect(first.labels.length).toBeLessThan(20);
    expect(first.truncated).toBeDefined();
    const second = doc.toolCalls[1]!.output as { firstFunder: { name: string } };
    expect(second.firstFunder.name.length).toBeLessThan(longName.length);
    expect(longName.startsWith(second.firstFunder.name)).toBe(true);
    // Only what survived the cap was screened (final review A5b), exactly as it was shown.
    const firstKept = (doc.toolCalls[0]!.output as { labels: unknown[]; firstFunder: unknown }).firstFunder === undefined ? 0 : 1;
    expect(doc.classifier.results).toHaveLength(first.labels.length + firstKept + 1);
    expect(doc.classifier.results.at(-1)).toMatchObject({ source: "tool:nansen_counterparty_profile", text: second.firstFunder.name });
    expect((await verify(rhB)).verdict).toBe("match");
  });

  it("a consistent rewrite of the model's output still matches: the model output is recorded, not re-run", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const rewritten = clone(doc);
    rewritten.modelOutputs.at(-1)!.content = NO_FINDINGS;
    rewritten.finalOutput.raw = NO_FINDINGS;
    rewritten.findings = [];
    rewritten.reasons = [];
    rewritten.score = 100;
    post(rhB, rewritten);
    // This is what verify cannot prove: that the recorded output came from the model.
    expect((await verify(rhB)).verdict).toBe("match");
  });
});

describe("verifyRiskRequest: tampering is a mismatch", () => {
  it("a changed score → SCORE_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    post(rhB, doc, { score: 80 });
    const onchain = await verify(rhB);
    expectProblem(onchain, "SCORE_MISMATCH");
    expect(onchain).toMatchObject({ posted: { score: 80 }, recomputed: { score: 0 } });

    const edited = clone(doc);
    edited.score = 80;
    post(rhB, edited);
    expectProblem(await verify(rhB), "SCORE_MISMATCH");
  });

  it("edited reasons → SCORE_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const edited = clone(doc);
    edited.reasons = [];
    post(rhB, edited);
    expectProblem(await verify(rhB), "SCORE_MISMATCH");
  });

  it("an edited finding → FINDINGS_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const edited = clone(doc);
    edited.findings[0]!.severity = "low";
    edited.score = 80;
    post(rhB, edited);
    const report = await verify(rhB);
    expectProblem(report, "FINDINGS_MISMATCH");
    expect(report.recomputed).toBeNull();
  });

  it("an edited finalOutput.raw → FINDINGS_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const edited = clone(doc);
    edited.finalOutput.raw = NO_FINDINGS;
    post(rhB, edited);
    expectProblem(await verify(rhB), "FINDINGS_MISMATCH");
  });

  it("finalOutput.raw that isn't the last recorded model response → FINDINGS_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const edited = clone(doc);
    edited.modelOutputs.at(-1)!.content = NO_FINDINGS;
    post(rhB, edited);
    expectProblem(await verify(rhB), "FINDINGS_MISMATCH");
  });

  it("a model finding citing a tool that never ran → FINDINGS_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const edited = clone(doc);
    const raw = findingsJson([{ code: "FUNDS_FORWARDED", severity: "high", explanation: "The target forwards all of it to the sink.", sources: ["nansen_flows"] }]);
    edited.finalOutput.raw = raw;
    edited.modelOutputs.at(-1)!.content = raw;
    edited.findings[0]!.sources = ["nansen_flows"];
    post(rhB, edited);
    expectProblem(await verify(rhB), "FINDINGS_MISMATCH");
  });

  it("a flagged classifier result with the code finding removed → FINDINGS_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun(), data: calldataWith(INJECTION) });
    expect(doc.findings.map((f) => f.code)).toEqual(["FUNDS_FORWARDED", PROMPT_INJECTION_SUSPECTED]);
    const removed = clone(doc);
    removed.findings = removed.findings.filter((f) => f.origin === "model");
    removed.reasons = ["FUNDS_FORWARDED"];
    post(rhB, removed);
    expectProblem(await verify(rhB), "FINDINGS_MISMATCH");

    // Unflagging the result as well doesn't help: the flag is recomputed from the recorded score.
    const unflagged = clone(removed);
    unflagged.classifier.results[0]!.flagged = false;
    post(rhB, unflagged);
    expectProblem(await verify(rhB), "FINDINGS_MISMATCH");
  });

  it("a dropped calldata_text result → FINDINGS_MISMATCH", async () => {
    const benign = await honest({ steps: riskyRun(), data: calldataWith("a harmless memo here") });
    const dropped = clone(benign.doc);
    dropped.classifier.results = [];
    post(benign.rhB, dropped);
    expectProblem(await verify(benign.rhB), "FINDINGS_MISMATCH");

    // A flagged one dropped together with its code finding: the injection rule was not applied.
    const flagged = await honest({ steps: riskyRun(), data: calldataWith(INJECTION) });
    const hidden = clone(flagged.doc);
    hidden.classifier.results = [];
    hidden.findings = hidden.findings.filter((f) => f.origin === "model");
    hidden.reasons = ["FUNDS_FORWARDED"];
    post(flagged.rhB, hidden);
    expectProblem(await verify(flagged.rhB), "FINDINGS_MISMATCH");
  });

  it("the calldata's and Nansen's coverage is checked with the injection rule, before the score and the re-runs", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun(), data: calldataWith("a harmless memo here") });
    const dropped = clone(doc);
    dropped.classifier.results = [];
    post(rhB, dropped, { score: 80 });
    const report = await verify(rhB);
    expectProblem(report, "FINDINGS_MISMATCH");
    expect(report.recomputed).toBeNull();
    expect(report.checkedToolCalls).toEqual([]);
  });

  it("a dropped revert-reason result → FINDINGS_MISMATCH", async () => {
    reader.traceResult = revertingTrace(INJECTION);
    const { rhB, doc } = await honest({ steps: steps([toolCall("simulate_action")]) });
    const hidden = clone(doc);
    hidden.classifier.results = [];
    hidden.findings = [];
    hidden.reasons = [];
    hidden.score = 100;
    post(rhB, hidden);
    const report = await verify(rhB);
    expectProblem(report, "FINDINGS_MISMATCH");
    expect(report.checkedToolCalls).toEqual([{ index: 0, name: "simulate_action" }]);
  });

  it("an edited result text → FINDINGS_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun(), data: calldataWith("a harmless memo here") });
    const edited = clone(doc);
    edited.classifier.results[0]!.text = "a different memo";
    post(rhB, edited);
    expectProblem(await verify(rhB), "FINDINGS_MISMATCH");

    // An empty text would be a substring of anything: it covers nothing.
    const emptied = clone(doc);
    emptied.classifier.results[0]!.text = "";
    post(rhB, emptied);
    expectProblem(await verify(rhB), "FINDINGS_MISMATCH");

    // Another source doesn't cover it either.
    const moved = clone(doc);
    moved.classifier.results[0]!.source = "tool:simulate_action";
    post(rhB, moved);
    expectProblem(await verify(rhB), "FINDINGS_MISMATCH");
  });

  it("a result whose text is a fragment, not one of the field's guard chunks → FINDINGS_MISMATCH", async () => {
    // A harmless fragment of a flagged calldata text, recorded with a genuine low score.
    const text = `${"x".repeat(420)} ${INJECTION}`;
    const calldata = await honest({ steps: riskyRun(), data: calldataWith(text) });
    const fragment = clone(calldata.doc);
    fragment.classifier.results[0] = { source: "calldata_text", text: "x".repeat(300), score: "0.00038913910975679755", flagged: false };
    fragment.findings = fragment.findings.filter((f) => f.origin === "model");
    fragment.reasons = ["FUNDS_FORWARDED"];
    post(calldata.rhB, fragment);
    expectProblem(await verify(calldata.rhB), "FINDINGS_MISMATCH");

    // The same for a simulation's revert reason.
    reader.traceResult = revertingTrace(`harmless prefix; ${INJECTION}`);
    const revert = await honest({ steps: steps([toolCall("simulate_action")]) });
    const cut = clone(revert.doc);
    cut.classifier.results[0] = { source: "tool:simulate_action", text: "harmless prefix", score: "0.00038913910975679755", flagged: false };
    cut.findings = [];
    cut.reasons = [];
    cut.score = 100;
    post(revert.rhB, cut);
    expectProblem(await verify(revert.rhB), "FINDINGS_MISMATCH");
  });

  it("each field needs its own result: two identical revert reasons with one result dropped → FINDINGS_MISMATCH", async () => {
    reader.traceResult = revertingTrace("a benign revert reason");
    const { rhB, doc } = await honest({ steps: steps([toolCall("simulate_action")], [toolCall("simulate_action")]) });
    expect(doc.classifier.results.map((r) => r.text)).toEqual(["a benign revert reason", "a benign revert reason"]);
    expect((await verify(rhB)).verdict).toBe("match");
    const one = clone(doc);
    one.classifier.results.pop();
    post(rhB, one);
    expectProblem(await verify(rhB), "FINDINGS_MISMATCH");
  });

  it("each Nansen label needs its own result: two identical labels with one result dropped → FINDINGS_MISMATCH", async () => {
    const profile = { available: true, labels: [{ label: "Same label", category: "a", kind: [] }, { label: "Same label", category: "b", kind: [] }], firstFunder: null };
    const { rhB, doc } = await honest({ steps: steps([toolCall("nansen_counterparty_profile", { address: PASS_THROUGH })]), nansen: availableNansen([profile]) });
    expect(doc.classifier.results).toHaveLength(2);
    expect((await verify(rhB)).verdict).toBe("match");
    const one = clone(doc);
    one.classifier.results.pop();
    post(rhB, one);
    expectProblem(await verify(rhB), "FINDINGS_MISMATCH");
  });

  it("a recorded Nansen label with no result → FINDINGS_MISMATCH", async () => {
    const profile = { available: true, labels: [{ label: "Exchange hot wallet", category: "cex", kind: [] }], firstFunder: null };
    const { rhB, doc } = await honest({
      steps: steps([toolCall("nansen_counterparty_profile", { address: PASS_THROUGH }), toolCall("nansen_flows", { address: PASS_THROUGH })]),
      nansen: availableNansen([profile]),
    });
    expect((await verify(rhB)).verdict).toBe("match");

    const injected = clone(doc);
    (injected.toolCalls[0]!.output as { labels: unknown[] }).labels.push({ label: "A label nobody screened", category: "x", kind: [] });
    post(rhB, injected);
    expectProblem(await verify(rhB), "FINDINGS_MISMATCH");

    const dropped = clone(doc);
    dropped.classifier.results = dropped.classifier.results.filter((r) => r.source !== "tool:nansen_flows");
    post(rhB, dropped);
    expectProblem(await verify(rhB), "FINDINGS_MISMATCH");
  });

  it("an unparseable recorded guard score → FINDINGS_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun(), data: calldataWith("a harmless memo here") });
    const edited = clone(doc);
    edited.classifier.results[0]!.score = "benign";
    post(rhB, edited);
    expectProblem(await verify(rhB), "FINDINGS_MISMATCH");
  });

  it("an edited simulation output → TOOL_OUTPUT_MISMATCH with that index", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const edited = clone(doc);
    edited.toolCalls[0]!.output = { ...edited.toolCalls[0]!.output, valueFlows: [] };
    post(rhB, edited);
    const report = await verify(rhB);
    expectProblem(report, "TOOL_OUTPUT_MISMATCH");
    expect(report.mismatchedToolCalls).toEqual([0]);
    expect(report.recomputed).toEqual({ score: 0, reasons: ["FUNDS_FORWARDED"] });
  });

  it("a fact that wasn't true at P → TOOL_OUTPUT_MISMATCH: the chain at P traces differently", async () => {
    const { rhB } = await honest({ steps: riskyRun() });
    reader.traceResult = passThroughTrace(undefined, undefined, 2_000_000_000_000_000n);
    const report = await verify(rhB);
    expectProblem(report, "TOOL_OUTPUT_MISMATCH");
    expect(report.mismatchedToolCalls).toEqual([0]);
  });

  it("edited recorded arguments → TOOL_OUTPUT_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const args = clone(doc);
    args.toolCalls[1]!.arguments = { address: "0x0000000000000000000000000000000000000001" };
    post(rhB, args);
    expect(await verify(rhB)).toMatchObject({ problems: ["TOOL_OUTPUT_MISMATCH"], mismatchedToolCalls: [1] });
  });

  it("a dropped onchain record whose call stays in modelOutputs → EVIDENCE_INVALID", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const dropped = clone(doc);
    dropped.toolCalls.splice(1, 1);
    post(rhB, dropped);
    expectProblem(await verify(rhB), "EVIDENCE_INVALID");
  });

  it("a record no recorded model tool call backs (onchain, Nansen or TOOL_CALL_LIMIT), or of another name → EVIDENCE_INVALID", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const extra = (record: Doc["toolCalls"][number]) => {
      const edited = clone(doc);
      edited.toolCalls.push(record);
      return edited;
    };
    for (const record of [
      { id: "call_extra", name: "get_mandate", arguments: {}, output: { owner: SINK }, onchain: true },
      { id: "call_extra", name: "nansen_flows", arguments: { address: SINK }, output: { available: false, reason: "x" }, onchain: false },
      { id: "call_extra", name: "simulate_action", arguments: {}, output: { error: "TOOL_CALL_LIMIT" }, onchain: true },
    ]) {
      post(rhB, extra(record));
      expectProblem(await verify(rhB), "EVIDENCE_INVALID");
    }

    const unbacked = clone(doc);
    unbacked.toolCalls[1]!.id = "call_never_made";
    post(rhB, unbacked);
    expectProblem(await verify(rhB), "EVIDENCE_INVALID");

    const renamed = clone(doc);
    renamed.toolCalls[1]!.name = "get_mandate";
    post(rhB, renamed);
    expectProblem(await verify(rhB), "EVIDENCE_INVALID");
  });

  it("a changed prerequisite score → PREREQUISITE_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const edited = clone(doc);
    edited.prerequisite.score = 0;
    post(rhB, edited);
    expectProblem(await verify(rhB), "PREREQUISITE_MISMATCH");
  });

  it("changed prerequisite reasons → PREREQUISITE_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun(), aScore: 0, aReasons: ["TARGET_NOT_ALLOWED"] });
    expect(doc.prerequisite).toMatchObject({ score: 0, reasons: ["TARGET_NOT_ALLOWED"] });
    expect((await verify(rhB)).verdict).toBe("match");
    const edited = clone(doc);
    edited.prerequisite.reasons = [];
    post(rhB, edited);
    expectProblem(await verify(rhB), "PREREQUISITE_MISMATCH");
  });

  it("A pending at P → PREREQUISITE_MISMATCH", async () => {
    const { rhA, rhB } = await honest({ steps: riskyRun() });
    // A's verdict actually landed after P: at P it was still pending.
    const landed = chain.landed.get(rhA);
    if (landed === undefined) throw new Error("A's verdict not landed");
    landed.block = PIN + 1n;
    landed.status = { ...landed.status, lastUpdate: tsOf(PIN + 1n) };
    expectProblem(await verify(rhB), "PREREQUISITE_MISMATCH");
  });

  it("A answered by another validator at P → PREREQUISITE_MISMATCH", async () => {
    const { rhA, rhB } = await honest({ steps: riskyRun() });
    const landed = chain.landed.get(rhA);
    if (landed === undefined) throw new Error("A's verdict not landed");
    landed.status = { ...landed.status, validator: "0x00000000000000000000000000000000000000B0" };
    expectProblem(await verify(rhB), "PREREQUISITE_MISMATCH");
  });

  it("P after the response block → PIN_OUT_OF_RANGE", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    post(rhB, doc, { block: PIN - 1n });
    const report = await verify(rhB);
    expectProblem(report, "PIN_OUT_OF_RANGE");
    expect(report.pinnedBlock).toBe(PIN);
  });

  it("P before the request block, or before the MandateRegistry existed → PIN_OUT_OF_RANGE", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const early = clone(doc);
    early.block.number = (REQUEST_BLOCK - 1n).toString();
    post(rhB, early);
    expectProblem(await verify(rhB), "PIN_OUT_OF_RANGE");

    post(rhB, doc);
    expect((await verify(rhB)).verdict).toBe("match");
    const reads = reader.calls.length;
    const later = contractsWith([{ address: P4_REGISTRY, fromBlock: PIN + 1n }]);
    expectProblem(await verifyRiskRequest({ reader, requestHash: rhB, context: { ...CONTEXT, contracts: later } }), "PIN_OUT_OF_RANGE");
    expect(reader.calls.slice(reads)).not.toContain("block"); // nothing read at P
  });

  it("a wrong block hash → PIN_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const edited = clone(doc);
    edited.block.hash = keccak256(toHex("another block"));
    post(rhB, edited);
    expectProblem(await verify(rhB), "PIN_MISMATCH");

    const time = clone(doc);
    time.block.timestamp = (BigInt(doc.block.timestamp) + 1n).toString();
    post(rhB, time);
    expectProblem(await verify(rhB), "PIN_MISMATCH");
  });

  it("an edited params.maxTraceCalls → PARAMS_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const edited = clone(doc);
    edited.params.maxTraceCalls = 17;
    post(rhB, edited);
    expectProblem(await verify(rhB), "PARAMS_MISMATCH");
  });

  it("another contract, validator A, guard model or threshold → PARAMS_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const validatorA = clone(doc);
    validatorA.params.mandateValidator = "0x00000000000000000000000000000000000000B0";
    post(rhB, validatorA);
    expectProblem(await verify(rhB), "PARAMS_MISMATCH");

    const guardModel = clone(doc);
    guardModel.classifier.model = "some/other-guard";
    post(rhB, guardModel);
    expectProblem(await verify(rhB), "PARAMS_MISMATCH");

    const threshold = clone(doc);
    threshold.classifier.threshold = "0.9";
    post(rhB, threshold);
    expectProblem(await verify(rhB), "PARAMS_MISMATCH");
  });

  it("verify: a pre-switch verdict's params match with a two-entry history; params naming v2 for a pre-switch pin are PARAMS_MISMATCH", async () => {
    // Recorded while the history held P4's registry alone (CONTEXT); v2 is appended later, from the block after P.
    const { rhB, doc } = await honest({ steps: riskyRun() });
    expect(doc.params.contracts).toMatchObject({ mandateRegistry: P4_REGISTRY });
    const twoRegistries = contractsWith([
      { address: P4_REGISTRY, fromBlock: 950n },
      { address: V2_REGISTRY, fromBlock: PIN + 1n },
    ]);
    const withHistory = (requestHash: Hex) => verifyRiskRequest({ reader, requestHash, context: { ...CONTEXT, contracts: twoRegistries } });
    expect(await withHistory(rhB)).toMatchObject({ verdict: "match", problems: [] });

    const v2 = clone(doc);
    (v2.params.contracts as Record<string, unknown>).mandateRegistry = V2_REGISTRY;
    post(rhB, v2);
    expectProblem(await withHistory(rhB), "PARAMS_MISMATCH");

    // At v2's first block the same params are what an honest run records.
    const atSwitch = contractsWith([
      { address: P4_REGISTRY, fromBlock: 950n },
      { address: V2_REGISTRY, fromBlock: PIN },
    ]);
    expect(await verifyRiskRequest({ reader, requestHash: rhB, context: { ...CONTEXT, contracts: atSwitch } })).toMatchObject({ verdict: "match" });
  });

  it("an edited request.value → REQUEST_FIELDS_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const edited = clone(doc);
    edited.request.value = "2000000000000000";
    post(rhB, edited);
    expectProblem(await verify(rhB), "REQUEST_FIELDS_MISMATCH");
  });

  it("evidence naming another requestHash → REQUEST_FIELDS_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const edited = clone(doc);
    edited.requestHash = keccak256(toHex("another request"));
    post(rhB, edited);
    expectProblem(await verify(rhB), "REQUEST_FIELDS_MISMATCH");
  });

  it("a request block the request wasn't made in → REQUEST_BLOCK_WRONG (mandate-v1's requestAt)", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const edited = clone(doc);
    edited.request.block = (REQUEST_BLOCK - 1n).toString();
    post(rhB, edited);
    expectProblem(await verify(rhB), "REQUEST_BLOCK_WRONG");
  });

  it("an unknown key → EVIDENCE_INVALID", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    post(rhB, { ...doc, extra: 1 });
    const report = await verify(rhB);
    expectProblem(report, "EVIDENCE_INVALID");
    expect(report.pinnedBlock).toBeNull();
  });

  it("evidence that parses but isn't canonical JSON → EVIDENCE_INVALID", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const bytes = stringToBytes(JSON.stringify(doc, null, 1));
    postUri(rhB, `data:application/json;base64,${toBase64(bytes)}`, keccak256(bytes));
    expectProblem(await verify(rhB), "EVIDENCE_INVALID");
  });

  it("evidence that doesn't hash to the responseHash → EVIDENCE_HASH_MISMATCH", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    const { uri } = encodeCanonicalJsonDataUri(doc);
    postUri(rhB, uri, keccak256(toHex("something else")));
    expectProblem(await verify(rhB), "EVIDENCE_HASH_MISMATCH");
  });
});

describe("verifyRiskRequest: could not verify", () => {
  it("no such request → REQUEST_NOT_FOUND", async () => {
    const report = await verify(keccak256(toHex("never requested")));
    expectProblem(report, "REQUEST_NOT_FOUND");
    expect(report).toMatchObject({ validator: zeroAddress, pinnedBlock: null, recomputed: null, model: null, findings: [] });
  });

  it("no response yet → RESPONSE_NOT_FOUND", async () => {
    const { jsonB, rhB } = requestPair(fakeAction());
    chain.addRequest(jsonB, REQUEST_BLOCK);
    expectProblem(await verify(rhB), "RESPONSE_NOT_FOUND");
  });

  it("missing response log → unverifiable", async () => {
    const { rhB } = await honest({ steps: riskyRun() });
    reader.hiddenResponses.add(rhB);
    expectProblem(await verify(rhB), "RESPONSE_NOT_FOUND");
  });

  it("A's missing response log rejects (lag), never a mismatch", async () => {
    const { rhA, rhB } = await honest({ steps: riskyRun() });
    reader.hiddenResponses.add(rhA);
    await expect(verify(rhB)).rejects.toThrow(PrerequisiteLogNotFoundError);
  });

  it("evidence that isn't an inline data: URI → EVIDENCE_NOT_DECODED", async () => {
    const { rhB } = await honest({ steps: riskyRun() });
    postUri(rhB, "https://example.com/evidence.json", keccak256(toHex("x")));
    expectProblem(await verify(rhB), "EVIDENCE_NOT_DECODED");
  });

  it("tool re-run RPC error rejects, never mismatch", async () => {
    const { rhB } = await honest({ steps: riskyRun() });
    reader.trace = async () => Promise.reject(new Error("HTTP request failed: 429"));
    await expect(verify(rhB)).rejects.toThrow("HTTP request failed: 429");
  });

  it("an RPC error on any read rejects, never a verdict", async () => {
    const { rhB } = await honest({ steps: riskyRun() });
    reader.block = async () => Promise.reject(new Error("-32602 Block requested not found"));
    await expect(verify(rhB)).rejects.toThrow("-32602");
  });

  it("a response under another tag rejects: there is no risk-v1 verdict to re-check", async () => {
    const { rhB, doc } = await honest({ steps: riskyRun() });
    post(rhB, doc, { tag: "mandate-v1" });
    await expect(verify(rhB)).rejects.toThrow(/tagged "mandate-v1", not risk-v1/);
  });

  it("RISK_MISMATCH_PROBLEMS is every problem except the three that leave nothing compared", () => {
    expect([...RISK_MISMATCH_PROBLEMS].sort()).toEqual(
      [
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
      ].sort(),
    );
  });
});
