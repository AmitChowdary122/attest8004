import { expect } from "bun:test";
import { bytesToHex, hexToBase64, type EVMLog } from "@chainlink/cre-sdk";
import { EvmMock, HttpActionsMock, newTestRuntime, test } from "@chainlink/cre-sdk/test";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  hexToBytes,
  keccak256,
  numberToHex,
  parseAbi,
  parseAbiParameters,
  stringToBytes,
  zeroHash,
  type Hex,
} from "viem";
import { buildAction } from "../../../packages/sdk/src/action.ts";
import { canonicalJson } from "../../../packages/sdk/src/canonical.ts";
import { buildRequestJson, encodeJsonDataUri, requestHashOfJson } from "../../../packages/sdk/src/request.ts";
import type { WorkflowConfig } from "../src/config.ts";
import { validationRequestEventAbi } from "../src/trigger.ts";
import { initWorkflow, onValidationRequest } from "../src/workflow.ts";
import { REAL, testConfig } from "./helpers.ts";

const MONAD_TESTNET = 2183018362218727504n;
const reportProcessedAbi = parseAbi(["event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)"]);
const C = "0x6D12F00870cB6edA2d8e389696f6B5d050423B95" as const;
const FORWARDER = "0xB9F79d863261869B234c481D1f9A7af84AeAd192" as const;
const P = 68_500_000n;
const P_HASH = keccak256(stringToBytes("block 68500000"));
const P_TIME = 1_791_300_000n;
const INNER_GAS = 300_000n;

const registryAbi = parseAbi([
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
]);
const receiverAbi = parseAbi(["function onReport(bytes metadata, bytes report)"]);

const cfg: WorkflowConfig = testConfig({ creValidator: C });

/** A request naming C through the demo vault for agent 1984, with a log as the trigger delivers it. */
function scenario(over: { deadline?: bigint; gate?: Hex } = {}) {
  const json = buildRequestJson({
    chainId: 10143,
    gate: (over.gate ?? REAL.vault) as `0x${string}`,
    validator: C,
    action: buildAction({ agentId: 1984n, target: REAL.owner, value: 500_000_000_000_000n, deadline: over.deadline ?? P_TIME + 1_800n, salt: keccak256(stringToBytes("salt")) }),
  });
  const requestHash = requestHashOfJson(json);
  const topics = encodeEventTopics({ abi: validationRequestEventAbi, eventName: "ValidationRequest", args: { validatorAddress: C, agentId: 1984n, requestHash } });
  const log = {
    address: hexToBytes(cfg.validationRegistry),
    topics: topics.map((t) => hexToBytes(t as Hex)),
    data: hexToBytes(encodeAbiParameters(parseAbiParameters("string"), [encodeJsonDataUri(json).uri])),
    blockHash: hexToBytes(P_HASH),
    txHash: hexToBytes(keccak256(stringToBytes("request tx"))),
    blockNumber: { absVal: hexToBytes(numberToHex(P, { size: 8 })), sign: 1n },
  } as unknown as EVMLog;
  const evidence = canonicalJson({
    schema: "attest8004.evidence.v1",
    validator: "mandate-v1",
    requestHash,
    score: 100,
    reasons: [],
    block: { number: P, hash: P_HASH, timestamp: P_TIME },
    request: {
      block: P,
      chainId: 10143,
      gate: json.gate,
      agentId: 1984n,
      target: json.action.target,
      value: 500_000_000_000_000n,
      dataHash: keccak256("0x"),
      selector: "0x00000000",
      deadline: BigInt(json.action.deadline),
      salt: json.action.salt.toLowerCase(),
    },
  });
  const evidenceHash = keccak256(stringToBytes(evidence));
  const done = { status: "done", score: 100, reasons: [], evidence, evidenceHash };
  return { json, requestHash, log, evidence, evidenceHash, done };
}

type Status = { validator: Hex; response: number; responseHash: Hex; tag: string };
const pendingStatus: Status = { validator: C, response: 0, responseHash: zeroHash, tag: "" };

/** Mocks for one run: chain reads by block, /evaluate answers in order, the estimate and the write. */
function mocks(o: {
  requestHash: Hex;
  evaluate: Array<{ statusCode: number; body: string } | "throw">;
  finalizedNumber?: bigint;
  finalizedStatus?: Status;
  landedStatus?: Status;
  estimate?: bigint | "revert" | "transport";
  headerHash?: Hex;
  /** The write's receipt: the forwarder's ReportProcessed for C with result true (default) or false, or no event. */
  receipt?: "landed" | "reverted" | "none";
}) {
  const evm = EvmMock.testInstance(MONAD_TESTNET);
  const seen = { writes: [] as any[], estimates: [] as any[], receipts: [] as Hex[], http: 0 };
  const isTag = (bn: any, abs: number) => bn !== undefined && bn.sign === -1n && bytesToHex(bn.absVal) === numberToHex(abs, { size: 1 });
  evm.headerByNumber = (input) => {
    const finalized = isTag(input.blockNumber, 3);
    const number = finalized ? (o.finalizedNumber ?? P + 10n) : P;
    return {
      header: {
        timestamp: (finalized ? P_TIME + 5n : P_TIME).toString(),
        blockNumber: { absVal: hexToBase64(numberToHex(number, { size: 8 })), sign: "1" },
        hash: hexToBase64(finalized ? keccak256(stringToBytes("finalized")) : (o.headerHash ?? P_HASH)),
      },
    };
  };
  evm.callContract = (input) => {
    const latest = isTag(input.blockNumber, 2);
    const finalized = isTag(input.blockNumber, 3);
    const s = latest ? (seen.writes.length > 0 ? (o.landedStatus ?? pendingStatus) : pendingStatus) : finalized ? (o.finalizedStatus ?? pendingStatus) : pendingStatus;
    const data = encodeFunctionResult({ abi: registryAbi, functionName: "getValidationStatus", result: [s.validator, 1984n, s.response, s.responseHash, s.tag, P_TIME] });
    return { data: hexToBase64(data) };
  };
  evm.estimateGas = (input) => {
    seen.estimates.push(input);
    if (o.estimate === "revert") throw new Error("execution reverted: AlreadyAnswered");
    if (o.estimate === "transport") throw new Error("rpc: connection reset by peer");
    return { gas: (o.estimate ?? INNER_GAS).toString() };
  };
  evm.writeReport = (input) => {
    seen.writes.push(input);
    return { txStatus: "TX_STATUS_SUCCESS", txHash: hexToBase64(keccak256(stringToBytes("report tx"))) };
  };
  evm.getTransactionReceipt = (input) => {
    seen.receipts.push(bytesToHex(input.hash));
    const kind = o.receipt ?? "landed";
    const topics = encodeEventTopics({
      abi: reportProcessedAbi,
      eventName: "ReportProcessed",
      args: { receiver: C, workflowExecutionId: `0x${"11".repeat(32)}`, reportId: "0x0001" },
    }) as Hex[];
    const log = { address: hexToBase64(FORWARDER), topics: topics.map(hexToBase64), data: hexToBase64(encodeAbiParameters([{ type: "bool" }], [kind === "landed"])) };
    return { receipt: { status: "1", logs: kind === "none" ? [] : [log] } };
  };
  const http = HttpActionsMock.testInstance();
  http.sendRequest = () => {
    const next = o.evaluate[Math.min(seen.http, o.evaluate.length - 1)];
    seen.http++;
    if (next === "throw" || next === undefined) throw new Error("context deadline exceeded");
    return { statusCode: next.statusCode, body: btoa(next.body) }; // ResponseJson: bytes as base64
  };
  return seen;
}

const DONE = (s: ReturnType<typeof scenario>) => ({ statusCode: 200, body: JSON.stringify(s.done) });
const PENDING = { statusCode: 200, body: '{"status":"pending"}' };
const landed = (s: ReturnType<typeof scenario>): Status => ({ validator: C, response: 100, responseHash: s.evidenceHash, tag: "mandate-v1" });
const run = (log: EVMLog, config: WorkflowConfig = cfg) => onValidationRequest(newTestRuntime(null, {}, config), log);

test("onRequest_writesVerdictWithExactPayloadAndGas", () => {
  const s = scenario();
  const seen = mocks({ requestHash: s.requestHash, evaluate: [DONE(s)], landedStatus: landed(s) });
  const out = JSON.parse(run(s.log));

  expect(out).toMatchObject({ requestHash: s.requestHash, score: 100, responseHash: s.evidenceHash });
  expect(seen.writes).toHaveLength(1);
  const write = seen.writes[0];
  expect(bytesToHex(write.receiver)).toBe(C.toLowerCase() as Hex);
  const raw: Uint8Array = write.report.rawReport;
  const [requestHash, score, responseURI, responseHash] = decodeAbiParameters(parseAbiParameters("bytes32, uint8, string, bytes32"), bytesToHex(raw.slice(109)));
  expect(requestHash).toBe(s.requestHash);
  expect(score).toBe(100);
  expect(responseURI).toBe(`data:application/json;base64,${btoa(s.evidence)}`);
  expect(responseHash).toBe(s.evidenceHash);
  // max(inner 300,000 + routing 50,000, 49,000 + 40 per raw-report byte) × 1.2, rounded up
  const floor = 49_000n + 40n * BigInt(raw.length);
  const expected = (((floor > 350_000n ? floor : 350_000n) * 120n + 99n) / 100n).toString();
  expect(String(write.gasConfig.gasLimit)).toBe(expected); // uint64 in the protobuf message
  expect(out.gasLimit).toBe(expected);

  const estimate = seen.estimates[0].msg;
  expect(bytesToHex(estimate.from)).toBe(FORWARDER.toLowerCase() as Hex);
  expect(bytesToHex(estimate.to)).toBe(C.toLowerCase() as Hex);
  const call = decodeFunctionData({ abi: receiverAbi, data: bytesToHex(estimate.data) });
  expect(call.args[0]).toBe(bytesToHex(raw.slice(45, 109)));
  expect(call.args[1]).toBe(bytesToHex(raw.slice(109)));
});

test("onRequest_declinesAnsweredRequestWithoutWriting", () => {
  const s = scenario();
  const seen = mocks({ requestHash: s.requestHash, evaluate: [DONE(s)], finalizedStatus: landed(s) });
  expect(JSON.parse(run(s.log))).toMatchObject({ declined: "ALREADY_ANSWERED" });
  expect(seen.writes).toHaveLength(0);
  expect(seen.http).toBe(0);
});

test("onRequest_declinesWrongGate", () => {
  const s = scenario({ gate: C });
  const seen = mocks({ requestHash: s.requestHash, evaluate: [DONE(s)] });
  expect(JSON.parse(run(s.log))).toMatchObject({ declined: "GATE_NOT_SERVED" });
  expect(seen.writes).toHaveLength(0);
});

test("onRequest_declinesWhenServiceDeclines", () => {
  const s = scenario();
  const seen = mocks({ requestHash: s.requestHash, evaluate: [{ statusCode: 200, body: '{"code":"EVIDENCE_TOO_LARGE","detail":"x","status":"declined"}' }] });
  expect(JSON.parse(run(s.log))).toMatchObject({ declined: "EVIDENCE_TOO_LARGE" });
  expect(seen.writes).toHaveLength(0);
});

test("onRequest_declinesOnEstimateRevert", () => {
  const s = scenario();
  const seen = mocks({ requestHash: s.requestHash, evaluate: [DONE(s)], estimate: "revert" });
  expect(JSON.parse(run(s.log))).toMatchObject({ declined: "ESTIMATE_REVERTED" });
  expect(seen.writes).toHaveLength(0);
});

test("onRequest_declinesGasOverCap", () => {
  const s = scenario();
  const seen = mocks({ requestHash: s.requestHash, evaluate: [DONE(s)], estimate: 2_000_000n });
  expect(JSON.parse(run(s.log))).toMatchObject({ declined: "GAS_OVER_CAP" });
  expect(seen.writes).toHaveLength(0);
});

test("onRequest_throwsAfterPollBudgetWithoutWriting", () => {
  const s = scenario();
  const seen = mocks({ requestHash: s.requestHash, evaluate: [PENDING] });
  expect(() => run(s.log)).toThrow(/EVALUATE_TIMEOUT/);
  expect(seen.http).toBe(cfg.pollAttempts);
  expect(seen.writes).toHaveLength(0);
});

test("onRequest_throwsOnEvidenceMismatch", () => {
  const s = scenario();
  const wrongPin = { ...s.done, evidence: s.evidence.replace(P_HASH, keccak256(stringToBytes("other block"))) };
  wrongPin.evidenceHash = keccak256(stringToBytes(wrongPin.evidence));
  const seen = mocks({ requestHash: s.requestHash, evaluate: [{ statusCode: 200, body: JSON.stringify(wrongPin) }] });
  expect(() => run(s.log)).toThrow(/EVIDENCE_PIN_MISMATCH:hash/);
  expect(seen.writes).toHaveLength(0);
});

test("onRequest_throwsWhenNotFinal", () => {
  const s = scenario();
  const seen = mocks({ requestHash: s.requestHash, evaluate: [DONE(s)], finalizedNumber: P + 2n });
  expect(() => run(s.log)).toThrow(/NOT_FINAL/);
  expect(seen.http).toBe(0);
  expect(seen.writes).toHaveLength(0);
});

test("onRequest_throwsOnAPinHashOtherThanTheTriggers", () => {
  const s = scenario();
  const seen = mocks({ requestHash: s.requestHash, evaluate: [DONE(s)], headerHash: zeroHash });
  expect(() => run(s.log)).toThrow(/PIN_HASH_MISMATCH/);
  expect(seen.writes).toHaveLength(0);
});

test("onRequest_throwsWhenReportProcessedSaysReverted (P12): the write's receipt, not the read-back, decides", () => {
  const s = scenario();
  const seen = mocks({ requestHash: s.requestHash, evaluate: [DONE(s)], landedStatus: landed(s), receipt: "reverted" });
  expect(() => run(s.log)).toThrow(/NOT_LANDED: .*RECEIVER_REVERTED/);
  expect(seen.receipts).toEqual([keccak256(stringToBytes("report tx"))]);
});

test("onRequest_throwsWhenTheReceiptHasNoReportProcessed (P12)", () => {
  const s = scenario();
  mocks({ requestHash: s.requestHash, evaluate: [DONE(s)], landedStatus: landed(s), receipt: "none" });
  expect(() => run(s.log)).toThrow(/NOT_LANDED: .*NO_REPORT_EVENT/);
});

test("onRequest_estimateTransportErrorIsARetryNotADecline (P12)", () => {
  const s = scenario();
  const seen = mocks({ requestHash: s.requestHash, evaluate: [DONE(s)], estimate: "transport" });
  expect(() => run(s.log)).toThrow(/ESTIMATE_FAILED/);
  expect(seen.writes).toHaveLength(0);
});

test("onRequest_throwsWhenVerdictNotOnChainAfterWrite", () => {
  const s = scenario();
  const seen = mocks({ requestHash: s.requestHash, evaluate: [DONE(s)] });
  expect(() => run(s.log)).toThrow(/NOT_LANDED/);
  expect(seen.writes).toHaveLength(1);
});

test("poll_pendingTwiceThenDone", () => {
  const s = scenario();
  const seen = mocks({ requestHash: s.requestHash, evaluate: [PENDING, { statusCode: 503, body: '{"status":"unavailable"}' }, DONE(s)], landedStatus: landed(s) });
  expect(JSON.parse(run(s.log))).toMatchObject({ score: 100 });
  expect(seen.http).toBe(3);
});

test("poll_failedCallCountsAsPending", () => {
  const s = scenario();
  const seen = mocks({ requestHash: s.requestHash, evaluate: ["throw", DONE(s)], landedStatus: landed(s) });
  expect(JSON.parse(run(s.log))).toMatchObject({ score: 100 });
  expect(seen.http).toBe(2);
});

test("init_triggerFiltersRegistryAndC", () => {
  const [entry] = initWorkflow(cfg);
  const config = (entry as any).trigger.config;
  expect(config.addresses.map((a: Uint8Array) => bytesToHex(a))).toEqual([cfg.validationRegistry.toLowerCase()]);
  const sig = encodeEventTopics({ abi: validationRequestEventAbi, eventName: "ValidationRequest" })[0];
  expect(bytesToHex(config.topics[0].values[0])).toBe(sig);
  expect(bytesToHex(config.topics[1].values[0])).toBe(`0x${"0".repeat(24)}${C.slice(2).toLowerCase()}`);
  expect(config.confidence).toBe(2); // CONFIDENCE_LEVEL_FINALIZED
});
