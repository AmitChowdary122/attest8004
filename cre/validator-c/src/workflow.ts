import {
  blockNumber,
  bytesToHex,
  cre,
  encodeCallMsg,
  getNetwork,
  hexToBase64,
  LAST_FINALIZED_BLOCK_NUMBER,
  LATEST_BLOCK_NUMBER,
  prepareReportRequest,
  protoBigIntToBigint,
  TxStatus,
  type EVMLog,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeEventTopics, encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { MANDATE_V1 } from "../../../validators/mandate/src/params.ts";
import type { WorkflowConfig } from "./config.ts";
import { pollEvaluate } from "./evaluate-client.ts";
import { checkEvidence } from "./evidence.ts";
import { gasLimitFor } from "./gas.ts";
import { landedFromReceipt, metadataOf, onReportCalldata, reportPayload } from "./report.ts";
import { checkLive, checkPinned, checkRequest, type Decline, type OnchainStatus } from "./request.ts";
import { decodeValidationRequest, validationRequestEventAbi } from "./trigger.ts";

const registryAbi = parseAbi([
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
]);

type BlockRef = ReturnType<typeof blockNumber> | typeof LAST_FINALIZED_BLOCK_NUMBER | typeof LATEST_BLOCK_NUMBER;
type EVM = InstanceType<typeof cre.capabilities.EVMClient>;

function evmClient(cfg: WorkflowConfig): EVM {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainSelectorName, isTestnet: true });
  if (network === undefined) throw new Error(`no CRE network named ${cfg.chainSelectorName}`);
  return new cre.capabilities.EVMClient(network.chainSelector.selector);
}

function readHeader(runtime: Runtime<WorkflowConfig>, evm: EVM, at: BlockRef): { number: bigint; hash: Hex; timestamp: bigint } {
  const header = evm.headerByNumber(runtime, { blockNumber: at }).result().header;
  if (header?.blockNumber === undefined) throw new Error("headerByNumber returned no header");
  return { number: protoBigIntToBigint(header.blockNumber), hash: bytesToHex(header.hash), timestamp: header.timestamp };
}

function readStatus(runtime: Runtime<WorkflowConfig>, evm: EVM, requestHash: Hex, at: BlockRef): OnchainStatus {
  const cfg = runtime.config;
  const data = encodeFunctionData({ abi: registryAbi, functionName: "getValidationStatus", args: [requestHash] });
  const reply = evm.callContract(runtime, { call: encodeCallMsg({ from: cfg.creValidator, to: cfg.validationRegistry, data }), blockNumber: at }).result();
  const [validator, agentId, response, responseHash, tag] = decodeFunctionResult({ abi: registryAbi, functionName: "getValidationStatus", data: bytesToHex(reply.data) });
  return { validator: getAddress(validator), agentId, response, responseHash: responseHash.toLowerCase() as Hex, tag };
}

/**
 * The onReport estimate, or null when onReport reverts (a decline: the call can never land, e.g. answered in the
 * meantime). Any other failure throws `ESTIMATE_FAILED`, so the run fails and is retried instead of declining (P12).
 */
function estimateInner(runtime: Runtime<WorkflowConfig>, evm: EVM, data: Hex): bigint | null {
  const cfg = runtime.config;
  try {
    const reply = evm.estimateGas(runtime, { msg: encodeCallMsg({ from: cfg.forwarder, to: cfg.creValidator, data }) }).result();
    return BigInt(reply.gas);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/revert/i.test(message)) return null;
    throw new Error(`ESTIMATE_FAILED: ${message.split("\n")[0]}`);
  }
}

/** The write's receipt logs as hex, for `landedFromReceipt`. */
function receiptLogs(runtime: Runtime<WorkflowConfig>, evm: EVM, txHash: Hex): { address: Hex; topics: Hex[]; data: Hex }[] {
  const reply = evm.getTransactionReceipt(runtime, { hash: hexToBase64(txHash) }).result();
  return (reply.receipt?.logs ?? []).map((log) => ({ address: bytesToHex(log.address), topics: log.topics.map((t) => bytesToHex(t)), data: bytesToHex(log.data) }));
}

const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();

/**
 * Validator C (P11, docs/cre.md): one ValidationRequest naming CreValidator, orchestrated end to end. In order:
 *
 * 1. decode the trigger and authenticate its request JSON (the repo SDK's requestHash); the pin P is the request's block;
 * 2. own reads: the header at P (its hash must be the trigger's block hash) and the request at P naming C;
 * 3. at the finalized head: P at least `pinLagBlocks` under it (else throw: re-run later), the deadline not passed,
 *    the request not answered yet;
 * 4. /evaluate (mandate-v1's unchanged logic, read-only, on 127.0.0.1) through identical-aggregation consensus;
 * 5. cross-check the evidence against steps 1–3, and compute responseURI and responseHash here;
 * 6. sign the report; estimate CreValidator.onReport as the forwarder calls it; size the gas limit (Monad charges the
 *    limit) and refuse above the cap;
 * 7. write through the forwarder; then read C's verdict back at the latest block: a successful write isn't proof,
 *    because the forwarder swallows a receiver's revert.
 *
 * A request it turns away returns `{"declined": <code>, …}` and writes nothing; a failure throws and writes nothing
 * (or, after the write, reports that the verdict didn't land). Six chain reads in all (CRE allows 15).
 */
export function onValidationRequest(runtime: Runtime<WorkflowConfig>, log: EVMLog): string {
  const cfg = runtime.config;
  const evm = evmClient(cfg);
  const t = decodeValidationRequest(log);
  runtime.log(`TRIGGER request ${t.requestHash} agent ${t.agentId} block ${t.block} tx ${t.txHash}`);
  const declined = (d: Decline) => {
    runtime.log(`DECLINED ${d.decline}: ${d.detail}`);
    return JSON.stringify({ declined: d.decline, detail: d.detail, requestHash: t.requestHash });
  };

  const request = checkRequest(t, cfg);
  if ("decline" in request) return declined(request);

  const header = readHeader(runtime, evm, blockNumber(t.block));
  const pinned = checkPinned({ t, header, status: readStatus(runtime, evm, t.requestHash, blockNumber(t.block)), deadline: request.deadline, cfg });
  if ("decline" in pinned) return declined(pinned);

  const finalized = readHeader(runtime, evm, LAST_FINALIZED_BLOCK_NUMBER);
  const live = checkLive({
    P: t.block,
    finalized,
    finalizedStatus: readStatus(runtime, evm, t.requestHash, LAST_FINALIZED_BLOCK_NUMBER),
    deadline: request.deadline,
    cfg,
  });
  if (live !== true) {
    if ("retry" in live) throw new Error(live.retry);
    return declined(live);
  }
  runtime.log(`READS P=${t.block} hash ${header.hash} time ${pinned.pinTime}; finalized ${finalized.number}; request names C, unanswered`);

  const evaluated = pollEvaluate(runtime, { requestHash: t.requestHash, pinnedBlock: t.block });
  if ("decline" in evaluated) return declined(evaluated);

  const checked = checkEvidence(evaluated, {
    requestHash: t.requestHash,
    requestBlock: t.block,
    json: request.json,
    pin: { number: t.block, hash: header.hash, timestamp: pinned.pinTime },
    maxBytes: cfg.maxEvidenceBytes,
  });
  if ("problem" in checked) throw new Error(`EVIDENCE_${checked.problem}`);
  runtime.log(`CHECKS evidence matches the workflow's own reads; score ${checked.score}; responseHash ${checked.responseHash}`);

  const payload = reportPayload({ requestHash: t.requestHash, score: checked.score, responseURI: checked.responseURI, responseHash: checked.responseHash });
  const report = runtime.report(prepareReportRequest(payload)).result();
  const raw = report.rawReport();
  const innerGas = estimateInner(runtime, evm, onReportCalldata(metadataOf(raw), payload));
  if (innerGas === null) return declined({ decline: "ESTIMATE_REVERTED", detail: "CreValidator.onReport reverts as the forwarder would call it" });
  const gas = gasLimitFor({ innerGas, rawReportBytes: raw.length, gas: cfg.gas });
  if ("decline" in gas) return declined(gas);
  runtime.log(`REPORT ${raw.length} bytes; onReport estimate ${innerGas}; gas limit ${gas.limit}`);

  const reply = evm.writeReport(runtime, { receiver: cfg.creValidator, report, gasConfig: { gasLimit: gas.limit.toString() } }).result();
  if (reply.txStatus !== TxStatus.SUCCESS) throw new Error(`WRITE_FAILED: ${reply.errorMessage ?? `status ${reply.txStatus}`}`);
  const txHash = reply.txHash === undefined ? "0x" : bytesToHex(reply.txHash);
  runtime.log(`WRITE tx ${txHash}`);

  // Both forwarders swallow a receiver's revert: only the forwarder's ReportProcessed in this very receipt says whether
  // onReport succeeded (an identical earlier verdict can't stand in for it), then C's status must read back as ours.
  const outcome = landedFromReceipt({ logs: receiptLogs(runtime, evm, txHash), forwarder: cfg.forwarder, receiver: cfg.creValidator });
  if (outcome !== "LANDED") throw new Error(`NOT_LANDED: tx ${txHash}: ${outcome}`);

  const after = readStatus(runtime, evm, t.requestHash, LATEST_BLOCK_NUMBER);
  const isOurs =
    same(after.validator, cfg.creValidator) && after.response === checked.score && after.responseHash === checked.responseHash && after.tag === MANDATE_V1.tag;
  if (!isOurs) throw new Error(`NOT_LANDED: after tx ${txHash}, request ${t.requestHash} reads score ${after.response}, tag "${after.tag.slice(0, 32)}"`);
  runtime.log(`LANDED C's verdict ${checked.score} for ${t.requestHash}`);
  return JSON.stringify({ requestHash: t.requestHash, score: checked.score, responseHash: checked.responseHash, txHash, gasLimit: gas.limit.toString() });
}

/** One handler: ValidationRequest logs from the registry naming CreValidator, at finalized confidence. */
export function initWorkflow(cfg: WorkflowConfig) {
  const topics = encodeEventTopics({ abi: validationRequestEventAbi, eventName: "ValidationRequest", args: { validatorAddress: cfg.creValidator } });
  return [
    cre.handler(
      evmClient(cfg).logTrigger({
        addresses: [hexToBase64(cfg.validationRegistry)],
        topics: topics.map((topic) => ({ values: topic === null ? [] : [hexToBase64(topic as Hex)] })),
        confidence: "CONFIDENCE_LEVEL_FINALIZED",
      }),
      onValidationRequest,
    ),
  ];
}
