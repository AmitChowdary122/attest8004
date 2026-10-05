import { encodeCanonicalJsonDataUri, encodeJsonDataUri, requestHashOfJson, type RequestEvent, type RequestJsonV1 } from "@attest8004/sdk";
import { getAddress, keccak256, stringToBytes, toHex, type Address, type Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { CRE_MAX_EVIDENCE_BYTES, evaluateAtPin, type EvaluateOutcome } from "../src/evaluate.ts";
import { MANDATE_V1 } from "../src/params.ts";
import type { MandateContracts } from "../src/reader.ts";
import { verifyRequest } from "../src/verify.ts";
import { AGENT, FakeChain, FakeReader, GATE, OWNER, P4_REGISTRY, RECORDED, requestJson, tsOf, UNLISTED, VALIDATOR } from "./helpers/fake-chain.ts";

/** Validator C (CreValidator, P11): the contract the /evaluate service answers for. */
const C = getAddress("0x6d12f00870cb6eda2d8e389696f6b5d050423b95");
const OTHER_GATE = getAddress("0x00000000000000000000000000000000000000b1");
const SERVED = [{ gate: GATE, agentId: AGENT }];

let chain: FakeChain;

beforeEach(() => {
  chain = new FakeChain(C);
});

function contracts(): MandateContracts {
  return { ...RECORDED, mandateRegistries: [{ address: P4_REGISTRY, fromBlock: chain.mandateDeployBlock }] };
}

function addRequest(json: RequestJsonV1, block = 1_000n): RequestEvent {
  const event: RequestEvent = {
    validator: json.validator,
    agentId: BigInt(json.agentId),
    requestURI: encodeJsonDataUri(json).uri,
    requestHash: requestHashOfJson(json),
    blockNumber: block,
    logIndex: chain.events.length,
    txHash: keccak256(toHex(`request tx ${chain.events.length}`)),
  };
  chain.events.push(event);
  return event;
}

function evaluate(
  requestHash: Hex,
  pinnedBlock: bigint,
  o: { reader?: FakeReader; validator?: Address; gates?: typeof SERVED } = {},
): Promise<EvaluateOutcome> {
  return evaluateAtPin({
    reader: o.reader ?? new FakeReader(chain),
    context: { contracts: contracts(), validationRegistryDeployBlock: chain.deployBlock },
    validator: o.validator ?? C,
    gates: o.gates ?? SERVED,
    requestHash,
    pinnedBlock,
  });
}

function done(outcome: EvaluateOutcome): Extract<EvaluateOutcome, { status: "done" }> {
  if (outcome.status !== "done") throw new Error(`expected done, got ${JSON.stringify(outcome)}`);
  return outcome;
}

/** Lands C's response by hand in block 1,005, as CreValidator would post it, with `evidence` as its document. */
function land(requestHash: Hex, score: number, evidence: string): void {
  const { uri, hash } = encodeCanonicalJsonDataUri(JSON.parse(evidence));
  chain.landed.set(requestHash.toLowerCase() as Hex, {
    block: 1_005n,
    logIndex: 0,
    uri,
    status: { validator: C, agentId: AGENT, response: score, responseHash: hash, tag: MANDATE_V1.tag, lastUpdate: tsOf(1_005n) },
  });
  chain.finalized = 1_010n;
}

describe("evaluateAtPin: mandate-v1's verdict at the request's block, as verify recomputes it", () => {
  it("an approval for C: verify re-executes it to a match with the same responseHash", async () => {
    const e = addRequest(requestJson({ validator: C }));
    const out = done(await evaluate(e.requestHash, 1_000n));

    expect(out.score).toBe(100);
    expect(out.reasons).toEqual([]);
    expect(out.evidenceHash).toBe(keccak256(stringToBytes(out.evidence)));

    land(e.requestHash, out.score, out.evidence);
    const report = await verifyRequest({
      reader: new FakeReader(chain),
      requestHash: e.requestHash,
      contracts: contracts(),
      validationRegistryDeployBlock: chain.deployBlock,
    });
    expect(report).toMatchObject({ verdict: "match", validator: C, pinnedBlock: 1_000n, problems: [] });
    expect(report.recomputed?.responseHash).toBe(out.evidenceHash);
  });

  it("a target outside the mandate scores 0 with TARGET_NOT_ALLOWED", async () => {
    const e = addRequest(requestJson({ validator: C, target: UNLISTED }));
    const out = done(await evaluate(e.requestHash, 1_000n));
    expect(out.score).toBe(0);
    expect(out.reasons).toContain("TARGET_NOT_ALLOWED");
  });

  it("the evidence is canonical, names C's request and pins the request's own block", async () => {
    const e = addRequest(requestJson({ validator: C }));
    const out = done(await evaluate(e.requestHash, 1_000n));
    const doc = JSON.parse(out.evidence);
    expect(doc).toMatchObject({
      schema: "attest8004.evidence.v1",
      validator: "mandate-v1",
      requestHash: e.requestHash,
      score: 100,
      block: { number: "1000", hash: keccak256(toHex("block 1000")), timestamp: tsOf(1_000n).toString() },
      request: { block: "1000", gate: GATE, agentId: "1984", target: OWNER },
    });
  });

  it("is deterministic: two runs on fresh readers give byte-equal evidence", async () => {
    const e = addRequest(requestJson({ validator: C }));
    const first = done(await evaluate(e.requestHash, 1_000n));
    const second = done(await evaluate(e.requestHash, 1_000n));
    expect(second.evidence).toBe(first.evidence);
  });
});

describe("evaluateAtPin: declines, each with a fixed code", () => {
  it("evaluate_declinesPinNotRequestBlock: a pin after the request's block", async () => {
    const e = addRequest(requestJson({ validator: C }));
    expect(await evaluate(e.requestHash, 1_001n)).toMatchObject({ status: "declined", code: "PIN_NOT_REQUEST_BLOCK" });
  });

  it("evaluate_declinesNotThisValidator: a request naming validator A", async () => {
    const e = addRequest(requestJson({ validator: VALIDATOR }));
    expect(await evaluate(e.requestHash, 1_000n)).toMatchObject({ status: "declined", code: "NOT_THIS_VALIDATOR" });
  });

  it("evaluate_declinesGateNotServed: with mandate-v1's own text", async () => {
    const e = addRequest(requestJson({ validator: C, gate: OTHER_GATE }));
    expect(await evaluate(e.requestHash, 1_000n)).toEqual({
      status: "declined",
      code: "GATE_NOT_SERVED",
      detail: `GATE_NOT_SERVED: agent 1984 requested through gate ${OTHER_GATE}, which this validator doesn't serve`,
    });
  });

  it("evaluate_declinesGateNotForAgent: a served gate for another agent", async () => {
    const e = addRequest(requestJson({ validator: C }));
    const out = await evaluate(e.requestHash, 1_000n, { gates: [{ gate: GATE, agentId: 7n }] });
    expect(out).toEqual({ status: "declined", code: "GATE_NOT_FOR_AGENT", detail: `GATE_NOT_FOR_AGENT: gate ${GATE} serves agent 7, not 1984` });
  });

  it("evaluate_declinesRequestInvalid: a deadline more than 3,600 s after the pin's time", async () => {
    const e = addRequest(requestJson({ validator: C, deadline: tsOf(1_000n) + 3_601n }));
    expect(await evaluate(e.requestHash, 1_000n)).toMatchObject({ status: "declined", code: "REQUEST_INVALID" });
  });

  it("evaluate_declinesRequestNotFound: a hash the registry doesn't know", async () => {
    expect(await evaluate(keccak256(toHex("nobody asked")), 1_000n)).toMatchObject({ status: "declined", code: "REQUEST_NOT_FOUND" });
  });

  it("evaluate_declinesPinBeforeFirstRegistry: no mandate can be read there", async () => {
    const e = addRequest(requestJson({ validator: C }), 940n);
    expect(await evaluate(e.requestHash, 940n)).toMatchObject({ status: "declined", code: "PIN_BEFORE_FIRST_REGISTRY" });
  });

  it("evaluate_declinesEvidenceTooLarge: evidence above 16,384 bytes can't pass CRE's consensus", async () => {
    const e = addRequest(requestJson({ validator: C }));
    const reader = new FakeReader(chain);
    for (let i = 0; i < 150; i++) {
      reader.permissionEvents.push({ block: 600n + BigInt(i), logIndex: 0, txHash: keccak256(toHex(`perm ${i}`)), emitter: "AgentRequestForwarder", event: "AgentKeySet" });
    }
    const out = await evaluate(e.requestHash, 1_000n, { reader });
    expect(out).toMatchObject({ status: "declined", code: "EVIDENCE_TOO_LARGE" });
    expect(CRE_MAX_EVIDENCE_BYTES).toBe(16_384);
  });
});

describe("evaluateAtPin: a failed read is never a verdict", () => {
  it("evaluate_throwsOnReadFailure", async () => {
    const e = addRequest(requestJson({ validator: C }));
    const reader = new FakeReader(chain);
    reader.statusFailure = () => new Error("rpc down");
    await expect(evaluate(e.requestHash, 1_000n, { reader })).rejects.toThrow("rpc down");
  });

  it("evaluate_throwsWhenTheRequestLogLags: state confirms the block, but the log isn't returned", async () => {
    const e = addRequest(requestJson({ validator: C }));
    const reader = new FakeReader(chain);
    reader.hiddenRequests.add(e.requestHash);
    await expect(evaluate(e.requestHash, 1_000n, { reader })).rejects.toThrow(/REQUEST_NOT_FOUND/);
  });
});

describe("verify against C's verdicts", () => {
  it("verifyRequest_flagsForgedCreVerdictAsMismatch: a forged approval delivered through the mock's open route", async () => {
    const e = addRequest(requestJson({ validator: C, target: UNLISTED }));
    const honest = done(await evaluate(e.requestHash, 1_000n));
    expect(honest.score).toBe(0);
    const forged = JSON.parse(honest.evidence);
    forged.score = 100;
    forged.reasons = [];
    land(e.requestHash, 100, JSON.stringify(forged));

    const report = await verifyRequest({
      reader: new FakeReader(chain),
      requestHash: e.requestHash,
      contracts: contracts(),
      validationRegistryDeployBlock: chain.deployBlock,
    });
    expect(report.verdict).toBe("mismatch");
    expect(report.problems).toContain("SCORE_MISMATCH");
  });
});
