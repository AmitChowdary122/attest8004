import { buildEvidence, canonicalJson, EVIDENCE_SCHEMA_V1 } from "@attest8004/sdk";
import { mandateRequestOf } from "@attest8004/validator-mandate";
import { keccak256, stringToBytes, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { parseRiskEvidence, riskEvidence, riskParams, type RiskEvidenceRecord } from "../src/evidence.ts";
import { RISK_V1 } from "../src/params.ts";
import { runRiskV1 } from "../src/run.ts";
import type { JsonValue } from "../src/types.ts";
import {
  ADDRESSES,
  blockAt,
  chatResponse,
  FakeChain,
  fakeAction,
  fakeGuard,
  FakeRiskReader,
  findingsJson,
  MODEL,
  PASS_THROUGH,
  requestPair,
  scriptedLlm,
  SINK,
  toolCall,
  unavailableNansen,
  VALIDATOR_A,
} from "./helpers/risk-fakes.ts";

const TOP_LEVEL_KEYS = ["block", "request", "params", "prerequisite", "llm", "classifier", "tools", "toolCalls", "modelOutputs", "finalOutput", "findings"];

/** A realistic record: the pass-through traced, the sink looked up, one high finding. */
function sampleRecord(over: Partial<RiskEvidenceRecord> = {}): RiskEvidenceRecord {
  const { jsonB, rhB, rhA } = requestPair(fakeAction());
  const request = mandateRequestOf(jsonB, rhB, 1_000n);
  const raw = findingsJson([
    { code: "FUNDS_FORWARDED", severity: "high", explanation: `The target forwards all of it to ${SINK}.`, sources: ["simulate_action"] },
  ]);
  const usage = { prompt: 1_000, completion: 50, total: 1_050 };
  return {
    block: blockAt(1_004n),
    request: {
      block: request.block,
      chainId: request.chainId,
      gate: request.gate,
      agentId: request.agentId,
      target: request.target,
      value: request.value,
      dataHash: keccak256(request.data),
      selector: "0x00000000",
      deadline: request.deadline,
      salt: request.salt,
    },
    params: riskParams(ADDRESSES, VALIDATOR_A),
    prerequisite: { validator: VALIDATOR_A, requestHash: rhA, score: 100, responseHash: keccak256(toHex("A")), tag: "mandate-v1", reasons: [] },
    llm: {
      host: "api.groq.com",
      model: MODEL,
      servedModels: [MODEL],
      systemFingerprints: ["fp_1", null],
      promptVersion: "risk-v1/1",
      promptHash: keccak256(toHex("prompt")),
      usage: { prompt: 2_000, completion: 100, total: 2_100 },
    },
    classifier: { model: RISK_V1.guardModel, threshold: "0.5", results: [{ source: "calldata_text", text: "memo text", score: "3.89e-05", flagged: false }] },
    tools: { nansen: { available: false, reason: "NANSEN_API_KEY is not set" } },
    toolCalls: [
      {
        id: "call_1",
        name: "simulate_action",
        arguments: {},
        output: { ok: true, calls: [{ depth: 0, to: PASS_THROUGH, value: "1000000000000000" }], valueFlows: [], truncatedCalls: 0 },
        onchain: true,
      },
      { id: "call_2", name: "nansen_flows", arguments: { address: SINK }, output: { available: false, reason: "NANSEN_API_KEY is not set" }, onchain: false },
    ],
    modelOutputs: [
      {
        content: null,
        toolCalls: [{ id: "call_1", name: "simulate_action", arguments: "{}" }],
        finishReason: "tool_calls",
        servedModel: MODEL,
        systemFingerprint: "fp_1",
        usage,
      },
      { content: raw, toolCalls: [], finishReason: "stop", servedModel: MODEL, systemFingerprint: null, usage },
    ],
    finalOutput: { raw, attempts: 1 },
    findings: [
      { code: "FUNDS_FORWARDED", severity: "high", explanation: `The target forwards all of it to ${SINK}.`, sources: ["simulate_action"], origin: "model" },
    ],
    ...over,
  };
}

/** The full document as the base publishes it, its canonical text and its size in bytes. */
function publish(record: RiskEvidenceRecord, score = 0, reasons = ["FUNDS_FORWARDED"]): { doc: Record<string, unknown>; text: string; bytes: number } {
  const doc = buildEvidence({ tag: RISK_V1.tag, requestHash: keccak256(toHex("rhB")), result: { score, reasons, evidence: riskEvidence(record) } });
  const text = canonicalJson(doc);
  return { doc, text, bytes: stringToBytes(text).length };
}

/** `text`'s JSON with `edit` applied, as plain (non-canonical) JSON text, so floats can be written. */
function edited(text: string, edit: (doc: Record<string, any>) => void): string {
  const doc = JSON.parse(text) as Record<string, any>;
  edit(doc);
  return JSON.stringify(doc);
}

describe("riskEvidence", () => {
  it("adds exactly the documented keys after the base's, none of them reserved", () => {
    const evidence = riskEvidence(sampleRecord());
    expect(Object.keys(evidence).sort()).toEqual([...TOP_LEVEL_KEYS].sort());
    for (const reserved of ["schema", "validator", "requestHash", "score", "reasons"]) expect(evidence).not.toHaveProperty(reserved);
  });

  it("params: every RISK_V1 constant except tag, promptVersion and guardModel, with the contracts and validator A; floats as decimal strings", () => {
    const params = JSON.parse(canonicalJson(riskEvidence(sampleRecord()))).params as Record<string, unknown>;
    const expected = Object.keys(RISK_V1).filter((key) => !["tag", "promptVersion", "guardModel"].includes(key));
    expect(Object.keys(params).sort()).toEqual([...expected, "contracts", "mandateValidator"].sort());
    expect(params.temperature).toBe("0.2");
    expect(params.guardThreshold).toBe("0.5");
    expect(params.simulationGas).toBe("1000000");
    expect(params.ageProbeBlocks).toEqual(["1000", "10000", "100000", "1000000", "2000000"]);
    expect(params.calldataTextMaxChars).toBe(RISK_V1.calldataTextMaxChars);
    expect(params.scores).toEqual({ none: 100, low: 80, medium: 40, high: 0 });
    expect(params.contracts).toEqual({
      identityRegistry: ADDRESSES.identityRegistry,
      reputationRegistry: ADDRESSES.reputationRegistry,
      validationRegistry: ADDRESSES.validationRegistry,
      mandateRegistry: ADDRESSES.mandateRegistry,
      forwarder: ADDRESSES.forwarder,
    });
    expect(params.mandateValidator).toBe(VALIDATOR_A);
  });

  it("is the same document whatever the letter case of the input addresses and hashes", () => {
    const record = sampleRecord();
    const lower = sampleRecord({
      block: { ...record.block, hash: record.block.hash.toUpperCase().replace("0X", "0x") as Hex },
      request: { ...record.request, gate: record.request.gate.toLowerCase() as Hex, target: record.request.target.toLowerCase() as Hex },
      prerequisite: { ...record.prerequisite, validator: record.prerequisite.validator.toLowerCase() as Hex },
    });
    expect(canonicalJson(riskEvidence(lower))).toBe(canonicalJson(riskEvidence(record)));
  });
});

describe("parseRiskEvidence", () => {
  it("round trip: buildEvidence → canonicalJson → parseRiskEvidence gives the same document, which rebuilds the same bytes", () => {
    const record = sampleRecord();
    const { text } = publish(record);
    const parsed = parseRiskEvidence(text);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.doc).toEqual({
      schema: EVIDENCE_SCHEMA_V1,
      validator: "risk-v1",
      requestHash: keccak256(toHex("rhB")),
      score: 0,
      reasons: ["FUNDS_FORWARDED"],
      ...record,
    });
    const { schema: _schema, validator: _validator, requestHash, score, reasons, ...rest } = parsed.doc;
    expect(canonicalJson(buildEvidence({ tag: RISK_V1.tag, requestHash, result: { score, reasons, evidence: riskEvidence(rest) } }))).toBe(text);
  });

  it("round trip of a real run's evidence", async () => {
    const chain = new FakeChain();
    const { jsonB, rhB, rhA } = requestPair(fakeAction());
    const llm = scriptedLlm([
      chatResponse({ toolCalls: [toolCall("simulate_action")] }),
      chatResponse({ toolCalls: [toolCall("counterparty_onchain", { address: SINK }), toolCall("nansen_counterparty_profile", { address: SINK })] }),
      chatResponse({ content: "done" }),
      chatResponse({
        content: findingsJson([
          { code: "FUNDS_FORWARDED", severity: "high", explanation: "Forwarded to the sink.", sources: ["simulate_action", "counterparty_onchain"] },
        ]),
      }),
    ]);
    const result = await runRiskV1({
      reader: new FakeRiskReader(chain),
      llm: llm.client,
      guard: fakeGuard(),
      nansen: unavailableNansen(),
      model: MODEL,
      addresses: ADDRESSES,
      mandateValidator: VALIDATOR_A,
      request: mandateRequestOf(jsonB, rhB, 1_000n),
      pinned: blockAt(1_004n),
      prerequisite: { validator: VALIDATOR_A, requestHash: rhA, score: 100, responseHash: keccak256(toHex("A")), tag: "mandate-v1", reasons: [] },
    });
    if ("decline" in result) throw new Error(result.decline);
    const text = canonicalJson(buildEvidence({ tag: RISK_V1.tag, requestHash: rhB, result }));
    const parsed = parseRiskEvidence(text);
    if (!parsed.ok) throw new Error(parsed.error);
    const { schema: _schema, validator: _validator, requestHash, score, reasons, ...rest } = parsed.doc;
    expect(canonicalJson(buildEvidence({ tag: RISK_V1.tag, requestHash, result: { score, reasons, evidence: riskEvidence(rest) } }))).toBe(text);
    expect(parsed.doc.toolCalls.map((c) => [c.name, c.onchain])).toEqual([
      ["simulate_action", true],
      ["counterparty_onchain", true],
      ["nansen_counterparty_profile", false],
    ]);
  });

  it("not JSON, or not an object, has fixed error text", () => {
    expect(parseRiskEvidence("{")).toEqual({ ok: false, error: "not JSON" });
    expect(parseRiskEvidence("[]")).toEqual({ ok: false, error: "not a JSON object" });
    expect(parseRiskEvidence("null")).toEqual({ ok: false, error: "not a JSON object" });
  });

  it("every key is required, at the top level and inside each object", () => {
    const { text } = publish(sampleRecord());
    const doc = JSON.parse(text) as Record<string, any>;
    const paths: string[][] = [
      ...["schema", "validator", "requestHash", "score", "reasons", ...TOP_LEVEL_KEYS].map((key) => [key]),
      ...Object.keys(doc.block).map((key) => ["block", key]),
      ...Object.keys(doc.request).map((key) => ["request", key]),
      ...Object.keys(doc.params).map((key) => ["params", key]),
      ...Object.keys(doc.params.contracts).map((key) => ["params", "contracts", key]),
      ...Object.keys(doc.params.scores).map((key) => ["params", "scores", key]),
      ...Object.keys(doc.prerequisite).map((key) => ["prerequisite", key]),
      ...Object.keys(doc.llm).map((key) => ["llm", key]),
      ...Object.keys(doc.llm.usage).map((key) => ["llm", "usage", key]),
      ...Object.keys(doc.classifier).map((key) => ["classifier", key]),
      ...Object.keys(doc.classifier.results[0]).map((key) => ["classifier", "results", "0", key]),
      ["tools", "nansen"],
      ...Object.keys(doc.tools.nansen).map((key) => ["tools", "nansen", key]),
      ...Object.keys(doc.toolCalls[0]).map((key) => ["toolCalls", "0", key]),
      ...Object.keys(doc.modelOutputs[0]).map((key) => ["modelOutputs", "0", key]),
      ...Object.keys(doc.modelOutputs[0].toolCalls[0]).map((key) => ["modelOutputs", "0", "toolCalls", "0", key]),
      ...Object.keys(doc.finalOutput).map((key) => ["finalOutput", key]),
      ...Object.keys(doc.findings[0]).map((key) => ["findings", "0", key]),
    ];
    expect(paths.length).toBeGreaterThan(80);
    for (const path of paths) {
      const without = edited(text, (d) => {
        let target = d;
        for (const key of path.slice(0, -1)) target = target[key];
        delete target[path.at(-1) as string];
      });
      const shown = path.map((key, i) => (/^\d+$/.test(key) ? `[${key}]` : i === 0 ? key : `.${key}`)).join("");
      expect(parseRiskEvidence(without), shown).toEqual({ ok: false, error: `invalid at ${shown}` });
    }
  });

  it("an unknown key is invalid, at any level", () => {
    const { text } = publish(sampleRecord());
    expect(parseRiskEvidence(edited(text, (d) => (d.extra = 1)))).toEqual({ ok: false, error: "unknown key at root" });
    expect(parseRiskEvidence(edited(text, (d) => (d.params.extra = 1)))).toEqual({ ok: false, error: "unknown key at params" });
    expect(parseRiskEvidence(edited(text, (d) => (d.llm.usage.extra = 1)))).toEqual({ ok: false, error: "unknown key at llm.usage" });
    expect(parseRiskEvidence(edited(text, (d) => (d.findings[0].extra = 1)))).toEqual({ ok: false, error: "unknown key at findings[0]" });
    expect(parseRiskEvidence(edited(text, (d) => (d.toolCalls[0].extra = 1)))).toEqual({ ok: false, error: "unknown key at toolCalls[0]" });
    // Tool arguments and outputs are free-form JSON: any key is fine there.
    expect(parseRiskEvidence(edited(text, (d) => (d.toolCalls[0].output.extra = 1))).ok).toBe(true);
  });

  it("floats are rejected, anywhere", () => {
    const { text } = publish(sampleRecord());
    const cases: Array<[string, (d: Record<string, any>) => void]> = [
      ["score", (d) => (d.score = 40.5)],
      ["prerequisite.score", (d) => (d.prerequisite.score = 99.5)],
      ["llm.usage.total", (d) => (d.llm.usage.total = 1.5)],
      ["modelOutputs[0].usage.prompt", (d) => (d.modelOutputs[0].usage.prompt = 0.1)],
      ["finalOutput.attempts", (d) => (d.finalOutput.attempts = 1.5)],
      ["params.maxToolCalls", (d) => (d.params.maxToolCalls = 8.5)],
      ["params.guardThreshold", (d) => (d.params.guardThreshold = 0.5)],
      ["classifier.threshold", (d) => (d.classifier.threshold = 0.5)],
      ["toolCalls[0].output", (d) => (d.toolCalls[0].output.calls[0].value = 0.001)],
      ["toolCalls[0].arguments", (d) => (d.toolCalls[0].arguments = { agentId: 1.5 })],
    ];
    for (const [path, edit] of cases) {
      const result = parseRiskEvidence(edited(text, edit));
      expect(result.ok, path).toBe(false);
      if (!result.ok) expect(result.error.startsWith(`invalid at ${path}`), `${path}: ${result.error}`).toBe(true);
    }
    // An integer above 2^53 can't round-trip either.
    expect(parseRiskEvidence(edited(text, (d) => (d.llm.usage.total = 2 ** 60))).ok).toBe(false);
  });

  it("encodings are exact: EIP-55 addresses, lower-case hashes, decimal strings without leading zeros", () => {
    const { text } = publish(sampleRecord());
    const cases: Array<[string, (d: Record<string, any>) => void]> = [
      ["request.gate", (d) => (d.request.gate = d.request.gate.toLowerCase())],
      ["request.salt", (d) => (d.request.salt = d.request.salt.toUpperCase().replace("0X", "0x"))],
      ["block.number", (d) => (d.block.number = "01004")],
      ["request.value", (d) => (d.request.value = 1_000)],
      ["params.simulationGas", (d) => (d.params.simulationGas = "1e6")],
      ["params.temperature", (d) => (d.params.temperature = "0.20")],
      ["prerequisite.tag", (d) => (d.prerequisite.tag = "mandate-v2")],
      ["validator", (d) => (d.validator = "mandate-v1")],
      ["findings[0].origin", (d) => (d.findings[0].origin = "operator")],
      ["findings[0].severity", (d) => (d.findings[0].severity = "critical")],
    ];
    for (const [path, edit] of cases) {
      expect(parseRiskEvidence(edited(text, edit)), path).toEqual({ ok: false, error: `invalid at ${path}` });
    }
  });

  it("a tool call is onchain exactly when it isn't a Nansen tool, so verify can't be told to skip an onchain one", () => {
    const { text } = publish(sampleRecord());
    expect(parseRiskEvidence(edited(text, (d) => (d.toolCalls[0].onchain = false)))).toEqual({ ok: false, error: "invalid at toolCalls[0].onchain" });
    expect(parseRiskEvidence(edited(text, (d) => (d.toolCalls[1].onchain = true)))).toEqual({ ok: false, error: "invalid at toolCalls[1].onchain" });
  });
});

describe("evidence size", () => {
  /** A canonical-JSON tool output of exactly `bytes` bytes. */
  function outputOf(bytes: number): JsonValue {
    const empty = canonicalJson({ data: "" }).length;
    return { data: "a".repeat(bytes - empty) };
  }

  it("the maximal record measures over 24,576 bytes; a typical record measures under it", () => {
    const explanation = "e".repeat(RISK_V1.maxExplanationChars);
    const findings = Array.from({ length: RISK_V1.maxFindings }, () => ({
      code: "OTHER",
      severity: "low" as const,
      explanation,
      sources: ["request", "mandate_v1_verdict", "simulate_action", "get_mandate"],
    }));
    const raw = JSON.stringify({ findings });
    const usage = { prompt: 6_000, completion: 1_000, total: 7_000 };
    const maximal = sampleRecord({
      toolCalls: Array.from({ length: RISK_V1.maxToolCalls }, (_, i) => ({
        id: `call_${i}`,
        name: "simulate_action",
        arguments: {},
        output: outputOf(RISK_V1.toolOutputMaxBytes),
        onchain: true,
      })),
      modelOutputs: Array.from({ length: 9 }, () => ({
        content: "c".repeat(2_000),
        toolCalls: [],
        finishReason: "stop",
        servedModel: MODEL,
        systemFingerprint: "fp_1",
        usage,
      })),
      finalOutput: { raw, attempts: RISK_V1.invalidOutputRetries + 1 },
      findings: findings.map((f) => ({ ...f, origin: "model" as const })),
    });
    expect(canonicalJson(outputOf(RISK_V1.toolOutputMaxBytes)).length).toBe(RISK_V1.toolOutputMaxBytes);
    expect(publish(maximal, 80, findings.map((f) => f.code)).bytes).toBeGreaterThan(RISK_V1.maxEvidenceBytes);
    expect(publish(sampleRecord()).bytes).toBeLessThan(RISK_V1.maxEvidenceBytes);
  });

  it("oversized evidence declines before sending: runRiskV1 returns EVIDENCE_TOO_LARGE with the size", async () => {
    const explanation = "e".repeat(RISK_V1.maxExplanationChars);
    const findings = Array.from({ length: RISK_V1.maxFindings }, () => ({ code: "OTHER", severity: "low", explanation, sources: ["simulate_action"] }));
    const llm = scriptedLlm([
      chatResponse({ content: "p".repeat(2_000), toolCalls: [toolCall("simulate_action")] }),
      chatResponse({ content: "q".repeat(2_000) }),
      chatResponse({ content: "x".repeat(6_000) }),
      chatResponse({ content: "y".repeat(6_000) }),
      chatResponse({ content: findingsJson(findings) }),
    ]);
    const chain = new FakeChain();
    const { jsonB, rhB, rhA } = requestPair(fakeAction());
    const result = await runRiskV1({
      reader: new FakeRiskReader(chain),
      llm: llm.client,
      guard: fakeGuard(),
      nansen: unavailableNansen(),
      model: MODEL,
      addresses: ADDRESSES,
      mandateValidator: VALIDATOR_A,
      request: mandateRequestOf(jsonB, rhB, 1_000n),
      pinned: blockAt(1_004n),
      prerequisite: { validator: VALIDATOR_A, requestHash: rhA, score: 100, responseHash: keccak256(toHex("A")), tag: "mandate-v1", reasons: [] },
    });
    expect(llm.requests).toHaveLength(5);
    expect(result).toEqual({ decline: expect.stringMatching(/^EVIDENCE_TOO_LARGE: \d+ bytes$/) });
    const bytes = Number(/(\d+)/.exec((result as { decline: string }).decline)?.[1]);
    expect(bytes).toBeGreaterThan(RISK_V1.maxEvidenceBytes);
  });
});
