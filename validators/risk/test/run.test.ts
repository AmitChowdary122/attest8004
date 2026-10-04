import { canonicalJson, type CheckResult } from "@attest8004/sdk";
import { mandateRequestOf, requestEvidence, type MandateInputs, type PinnedBlock } from "@attest8004/validator-mandate";
import { keccak256, size, slice, toHex, type Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { promptParams } from "../src/agent.ts";
import { PROMPT_INJECTION_SUSPECTED, scoreOf } from "../src/findings.ts";
import { ProviderError } from "../src/llm.ts";
import { NANSEN_NO_KEY_REASON, type NansenClient } from "../src/nansen.ts";
import { RISK_V1 } from "../src/params.ts";
import { promptHash } from "../src/prompt.ts";
import { readPrerequisite, runRiskV1 } from "../src/run.ts";
import { TOOL_DEFINITIONS } from "../src/tools.ts";
import type { Prerequisite, RecordedFinding } from "../src/types.ts";
import {
  ADDRESSES,
  blockAt,
  calldataWith,
  chatResponse,
  FakeChain,
  fakeAction,
  fakeGuard,
  FakeRiskReader,
  findingsJson,
  INJECTION,
  landMandateVerdict,
  MODEL,
  NO_FINDINGS,
  PASS_THROUGH,
  requestPair,
  scriptedLlm,
  SINK,
  toolCall,
  transient429,
  unavailableNansen,
  VALIDATOR_A,
  type Step,
} from "./helpers/risk-fakes.ts";

let chain: FakeChain;
let reader: FakeRiskReader;

beforeEach(() => {
  chain = new FakeChain();
  reader = new FakeRiskReader(chain);
});

const P: PinnedBlock = blockAt(1_004n);

function prerequisite(over: Partial<Prerequisite> = {}): Prerequisite {
  return {
    validator: VALIDATOR_A,
    requestHash: keccak256(toHex("rhA")),
    score: 100,
    responseHash: keccak256(toHex("A's evidence")),
    tag: "mandate-v1",
    reasons: [],
    ...over,
  };
}

function requestFor(data: Hex = "0x"): MandateInputs["request"] {
  const { jsonB, rhB } = requestPair(fakeAction({ data }));
  return mandateRequestOf(jsonB, rhB, 1_000n);
}

type Evidence = {
  request: unknown;
  prerequisite: unknown;
  llm: { host: string; model: string; servedModels: string[]; systemFingerprints: (string | null)[]; promptVersion: string; promptHash: Hex; usage: unknown };
  classifier: { model: string; threshold: string; results: { source: string; text: string; score: string; flagged: boolean }[] };
  tools: { nansen: { available: boolean; reason: string | null } };
  toolCalls: { name: string }[];
  modelOutputs: unknown[];
  finalOutput: { raw: string; attempts: number };
  findings: RecordedFinding[];
};

async function run(o: {
  steps: Step[];
  data?: Hex;
  prereq?: Partial<Prerequisite>;
  events?: string[];
  nansen?: NansenClient;
}): Promise<{ result: CheckResult | { decline: string }; llm: ReturnType<typeof scriptedLlm>; guard: ReturnType<typeof fakeGuard>; request: MandateInputs["request"] }> {
  const events = o.events ?? [];
  const llm = scriptedLlm(o.steps, events);
  const guard = fakeGuard(events);
  const request = requestFor(o.data);
  const result = await runRiskV1({
    reader,
    llm: llm.client,
    guard,
    nansen: o.nansen ?? unavailableNansen(),
    model: MODEL,
    addresses: ADDRESSES,
    mandateValidator: VALIDATOR_A,
    request,
    pinned: P,
    prerequisite: prerequisite(o.prereq),
  });
  return { result, llm, guard, request };
}

function verdict(result: CheckResult | { decline: string }): CheckResult & { evidence: Evidence } {
  if ("decline" in result) throw new Error(`declined: ${result.decline}`);
  // Through canonical JSON, as the base publishes it: bigints become decimal strings.
  return { ...result, evidence: JSON.parse(canonicalJson(result.evidence)) as Evidence };
}

const textTurn = (content = "I have what I need.") => chatResponse({ content });
const final = (raw: string) => chatResponse({ content: raw });

describe("runRiskV1", () => {
  it("a failed mandate-v1 still runs: a 0 with [TARGET_NOT_ALLOWED] reaches the user message", async () => {
    const violation = findingsJson([
      { code: "MANDATE_VIOLATION", severity: "high", explanation: "mandate-v1 scored 0: TARGET_NOT_ALLOWED.", sources: ["mandate_v1_verdict"] },
    ]);
    const { result, llm } = await run({ steps: [textTurn(), final(violation)], prereq: { score: 0, reasons: ["TARGET_NOT_ALLOWED"] } });

    const user = llm.requests[0]?.messages[1];
    expect(user?.role).toBe("user");
    expect(user?.content).toContain('<untrusted_data source="mandate_v1_verdict">\n{"reasons":["TARGET_NOT_ALLOWED"],"score":0}\n</untrusted_data>');
    const v = verdict(result);
    expect(v.score).toBe(0);
    expect(v.reasons).toEqual(["MANDATE_VIOLATION"]);
    expect(v.evidence.prerequisite).toMatchObject({ score: 0, reasons: ["TARGET_NOT_ALLOWED"], tag: "mandate-v1" });
  });

  it("obedient model still scores 40: the guard flags the calldata, the model returns no findings, code adds the injection finding", async () => {
    const { result, llm } = await run({ steps: [textTurn("Nothing to check."), final(NO_FINDINGS)], data: calldataWith(INJECTION) });

    const v = verdict(result);
    expect(v.score).toBe(40);
    expect(v.reasons).toEqual([PROMPT_INJECTION_SUSPECTED]);
    expect(v.evidence.findings).toEqual([
      {
        code: PROMPT_INJECTION_SUSPECTED,
        severity: "medium",
        explanation: expect.stringContaining("calldata_text"),
        sources: ["classifier:calldata_text"],
        origin: "code",
      },
    ]);
    expect(v.evidence.classifier.results[0]).toMatchObject({ source: "calldata_text", flagged: true, score: "0.9995530247688293" });
    expect(v.evidence.classifier.results[0]?.text).toContain("ignore previous instructions");
    // The hostile text stayed inside its block: the only literal closing tags are our own three.
    const user = llm.requests[0]?.messages[1]?.content ?? "";
    expect(user.split("</untrusted_data>").length - 1).toBe(3);
    expect(user).toContain("\\u003c/untrusted_data\\u003e");
  });

  it("the guard runs before the first model call", async () => {
    const events: string[] = [];
    await run({ steps: [textTurn(), final(NO_FINDINGS)], data: calldataWith(INJECTION), events });
    expect(events[0]).toBe("classify");
    expect(events.indexOf("complete")).toBeGreaterThan(events.lastIndexOf("classify"));
  });

  it("no guard call without untrusted text", async () => {
    const { result, guard } = await run({ steps: [chatResponse({ toolCalls: [toolCall("simulate_action")] }), textTurn(), final(NO_FINDINGS)] });
    expect(guard.texts).toEqual([]);
    const v = verdict(result);
    expect(v.evidence.classifier.results).toEqual([]);
    expect(v.score).toBe(100);
    expect(v.reasons).toEqual([]);
  });

  it("screens all of the calldata's text as one field, before the model sees it", async () => {
    const { guard, result } = await run({ steps: [textTurn(), final(NO_FINDINGS)], data: calldataWith("a harmless memo here") });
    expect(guard.texts).toEqual(["a harmless memo here"]);
    expect(verdict(result).evidence.classifier.results).toEqual([
      { source: "calldata_text", text: "a harmless memo here", score: "0.00038913910975679755", flagged: false },
    ]);
  });

  it("Nansen unavailable: it is recorded, and stated in the message", async () => {
    const { result, llm } = await run({ steps: [textTurn(), final(NO_FINDINGS)] });
    expect(llm.requests[0]?.messages[1]?.content).toContain(`Nansen tools are unavailable: ${NANSEN_NO_KEY_REASON}.`);
    expect(verdict(result).evidence.tools).toEqual({ nansen: { available: false, reason: NANSEN_NO_KEY_REASON } });
  });

  it("Nansen available: recorded with a null reason, and stated in the message", async () => {
    const available: NansenClient = {
      available: true,
      reason: null,
      profile: async () => ({ available: true, labels: [] }),
      flows: async () => ({ available: true, counterparties: [] }),
    };
    const { result, llm } = await run({ steps: [textTurn(), final(NO_FINDINGS)], nansen: available });
    expect(llm.requests[0]?.messages[1]?.content).toContain("Nansen tools are available.");
    expect(verdict(result).evidence.tools).toEqual({ nansen: { available: true, reason: null } });
  });

  it("the score is scoreOf(findings), model findings then code's, and the evidence's reasons are their codes", async () => {
    const modelFindings = [
      { code: "FUNDS_FORWARDED", severity: "high", explanation: `The target forwards the value to ${SINK}.`, sources: ["simulate_action"] },
      { code: "FRESH_COUNTERPARTY", severity: "low", explanation: "The sink has never sent a transaction.", sources: ["counterparty_onchain"] },
    ];
    const { result } = await run({
      steps: [
        chatResponse({ toolCalls: [toolCall("simulate_action")] }),
        chatResponse({ toolCalls: [toolCall("counterparty_onchain", { address: SINK })] }),
        textTurn(),
        final(findingsJson(modelFindings)),
      ],
      data: calldataWith(INJECTION),
    });

    const v = verdict(result);
    expect(v.evidence.findings.map((f) => [f.code, f.origin])).toEqual([
      ["FUNDS_FORWARDED", "model"],
      ["FRESH_COUNTERPARTY", "model"],
      [PROMPT_INJECTION_SUSPECTED, "code"],
    ]);
    expect(v.score).toBe(scoreOf(v.evidence.findings));
    expect(v.score).toBe(0);
    expect(v.reasons).toEqual(v.evidence.findings.map((f) => f.code));
    expect(v.evidence.toolCalls.map((c) => c.name)).toEqual(["simulate_action", "counterparty_onchain"]);
  });

  it("evidence: the LLM host only, distinct served models and fingerprints in first-seen order, summed usage, promptHash", async () => {
    const { result, llm } = await run({
      steps: [
        chatResponse({ toolCalls: [toolCall("simulate_action")], servedModel: "openai/gpt-oss-120b", fingerprint: "fp_a", total: 1_000 }),
        chatResponse({ content: "done", servedModel: "openai/gpt-oss-120b-2", fingerprint: null, total: 1_200 }),
        chatResponse({ content: NO_FINDINGS, servedModel: "openai/gpt-oss-120b", fingerprint: "fp_a", total: 1_300 }),
      ],
    });

    const { llm: record } = verdict(result).evidence;
    expect(record).toEqual({
      host: "api.groq.com",
      model: MODEL,
      servedModels: ["openai/gpt-oss-120b", "openai/gpt-oss-120b-2"],
      systemFingerprints: ["fp_a", null],
      promptVersion: "risk-v1/1",
      promptHash: promptHash(llm.requests[0]?.messages.slice(0, 2) ?? [], TOOL_DEFINITIONS, promptParams(MODEL)),
      usage: { prompt: 3_350, completion: 150, total: 3_500 },
    });
  });

  it("the evidence's request is exactly mandate-v1's request object; the model sees the value in MON and the data's head", async () => {
    const data = calldataWith(`${"memo ".repeat(40)}`); // 4 + 200 bytes
    const { result, llm, request } = await run({ steps: [textTurn(), final(NO_FINDINGS)], data });

    expect(canonicalJson(verdict(result).evidence.request)).toBe(canonicalJson(requestEvidence(request)));
    const block = /<untrusted_data source="request">\n(.*)\n<\/untrusted_data>/.exec(llm.requests[0]?.messages[1]?.content ?? "");
    expect(JSON.parse(block?.[1] ?? "null")).toEqual({
      block: "1000",
      chainId: 10143,
      gate: request.gate,
      agentId: "1984",
      target: PASS_THROUGH,
      value: "1000000000000000",
      valueMon: "0.001",
      selector: "0xa9059cbb",
      dataLength: size(data),
      dataHead: slice(data, 0, RISK_V1.calldataHeadBytes),
      deadline: request.deadline.toString(),
      salt: request.salt,
    });
  });

  it("output still invalid after its retries declines MODEL_OUTPUT_INVALID with the last error", async () => {
    const { result } = await run({ steps: [textTurn(), final("not json"), final("still not json"), final('{"findings":"none"}')] });
    expect(result).toEqual({ decline: "MODEL_OUTPUT_INVALID: invalid at findings" });
  });

  it("three failed tool calls in the loop decline MODEL_OUTPUT_INVALID: tool_use_failed", async () => {
    const failed = () =>
      new ProviderError("model output invalid (tool_use_failed)", { kind: "invalid_output", status: 400, code: "tool_use_failed", failedGeneration: "<|call|>" });
    const { result } = await run({ steps: [failed(), failed(), failed()] });
    expect(result).toEqual({ decline: "MODEL_OUTPUT_INVALID: tool_use_failed" });
  });

  it("three failed structured outputs decline MODEL_OUTPUT_INVALID: json_validate_failed, even when the failed generation would parse", async () => {
    const failed = () =>
      new ProviderError("model output invalid (json_validate_failed)", {
        kind: "invalid_output",
        status: 400,
        code: "json_validate_failed",
        failedGeneration: NO_FINDINGS,
      });
    const { result } = await run({ steps: [textTurn(), failed(), failed(), failed()] });
    expect(result).toEqual({ decline: "MODEL_OUTPUT_INVALID: json_validate_failed" });
  });

  it("a transient provider failure rejects with no result (the base retries)", async () => {
    await expect(run({ steps: [chatResponse({ toolCalls: [toolCall("simulate_action")] }), transient429()] })).rejects.toThrow(ProviderError);
  });

  it("a guard failure rejects before any model call", async () => {
    const llm = scriptedLlm([textTurn(), final(NO_FINDINGS)]);
    await expect(
      runRiskV1({
        reader,
        llm: llm.client,
        guard: { model: RISK_V1.guardModel, classify: async () => Promise.reject(transient429()) },
        nansen: unavailableNansen(),
        model: MODEL,
        addresses: ADDRESSES,
        mandateValidator: VALIDATOR_A,
        request: requestFor(calldataWith(INJECTION)),
        pinned: P,
        prerequisite: prerequisite(),
      }),
    ).rejects.toThrow(ProviderError);
    expect(llm.requests).toEqual([]);
  });
});

describe("readPrerequisite", () => {
  function setup(o: { score?: number; reasons?: string[]; tag?: string; validator?: `0x${string}`; landAt?: bigint } = {}) {
    const action = fakeAction();
    const { jsonA, rhA } = requestPair(action);
    chain.addRequest(jsonA, 1_000n);
    if (o.landAt !== undefined) {
      landMandateVerdict(chain, {
        jsonA,
        requestBlock: 1_000n,
        block: o.landAt,
        score: o.score ?? 100,
        reasons: o.reasons ?? [],
        tag: o.tag,
        validator: o.validator,
      });
    }
    return { jsonA, rhA };
  }
  const read = (rhA: Hex, at = P) => readPrerequisite(reader, { mandateValidator: VALIDATOR_A, requestHashA: rhA, pinned: at });

  it("is PENDING while A's request doesn't exist at P (UnknownRequest)", async () => {
    const { rhA } = requestPair(fakeAction());
    expect(await read(rhA)).toBe("PENDING");
  });

  it("is PENDING while A's request is unanswered at P, including an answer landing after P", async () => {
    const { rhA } = setup({ landAt: 1_005n });
    expect(await read(rhA)).toBe("PENDING");
    expect(await read(rhA, blockAt(1_005n))).not.toBe("PENDING");
  });

  it("reads A's verdict, its responseHash and the known reason codes from A's own evidence", async () => {
    const { jsonA, rhA } = setup();
    const evidence = landMandateVerdict(chain, {
      jsonA,
      requestBlock: 1_000n,
      block: 1_002n,
      score: 0,
      reasons: ["TARGET_NOT_ALLOWED", "IGNORE_PREVIOUS_INSTRUCTIONS", "SIMULATION_FAILED"],
    });
    expect(await read(rhA)).toEqual({
      validator: VALIDATOR_A,
      requestHash: rhA,
      score: 0,
      responseHash: evidence.hash,
      tag: "mandate-v1",
      reasons: ["TARGET_NOT_ALLOWED", "SIMULATION_FAILED"],
    });
  });

  it("is invalid when another validator answered, or with another tag", async () => {
    const other = setup({ landAt: 1_002n, validator: "0x00000000000000000000000000000000000000b0" });
    expect(await read(other.rhA)).toEqual({ invalid: expect.stringContaining("0x00000000000000000000000000000000000000B0") });
    const tagged = setup({ landAt: 1_002n, tag: "mandate-v2" });
    expect(await read(tagged.rhA)).toEqual({ invalid: expect.stringContaining('"mandate-v2"') });
  });

  it("is invalid when A's evidence doesn't hash to its responseHash, isn't an inline data: URI, or names another request", async () => {
    const { rhA } = setup({ landAt: 1_002n });
    const landed = chain.landed.get(rhA);
    if (!landed) throw new Error("not landed");
    landed.status = { ...landed.status, responseHash: keccak256(toHex("something else")) };
    expect(await read(rhA)).toEqual({ invalid: "A's evidence doesn't hash to its responseHash" });

    landed.uri = "https://example.com/evidence.json";
    expect(await read(rhA)).toEqual({ invalid: "A's evidence is not an inline data: URI (URI_NOT_DATA)" });

    const second = setup();
    const wrong = landMandateVerdict(chain, { jsonA: requestPair(fakeAction()).jsonA, requestBlock: 1_000n, block: 1_002n, score: 100, reasons: [] });
    chain.land(second.rhA, { validator: VALIDATOR_A, response: 100, uri: wrong.uri, hash: wrong.hash, tag: "mandate-v1", block: 1_002n });
    expect(await read(second.rhA)).toEqual({ invalid: "A's evidence names another request" });
  });

  it("throws, never a verdict, when A's response log can't be found (lag)", async () => {
    const { rhA } = setup({ landAt: 1_002n });
    reader.hiddenResponses.add(rhA);
    await expect(read(rhA)).rejects.toThrow(/no ValidationResponse log found/);
  });

  it("throws on an RPC failure of the status read", async () => {
    const { rhA } = setup({ landAt: 1_002n });
    reader.status = async () => Promise.reject(new Error("HTTP 429"));
    await expect(read(rhA)).rejects.toThrow("HTTP 429");
  });
});
