import { hexToBytes, numberToHex, type Address, type Hex } from "viem";
import type { WorkflowConfig } from "../src/config.ts";
import requestLog from "./fixtures/request-log.json";

/** The real ValidationRequest log (fixtures/request-log.json) in the shape CRE's log trigger delivers it. */
export function realTriggerLog() {
  return {
    address: hexToBytes(requestLog.address as Hex),
    topics: requestLog.topics.map((t) => hexToBytes(t as Hex)),
    data: hexToBytes(requestLog.data as Hex),
    blockHash: hexToBytes(requestLog.blockHash as Hex),
    txHash: hexToBytes(requestLog.transactionHash as Hex),
    blockNumber: { absVal: hexToBytes(numberToHex(BigInt(requestLog.blockNumber))), sign: 1n },
  };
}

export const REAL = {
  block: 68_438_285n,
  blockHash: "0xc5e59324931c60056454d59cbfafbb68d9e95b493701f538b89c6572fe5e1f25" as Hex,
  /** Block 68,438,285's timestamp (the P11 spike's own header read). */
  blockTime: 1_791_214_459n,
  requestHash: "0xcc1c8a97a38a369c9354a41c68e54748da56719c961687d12767af529dd6ce77" as Hex,
  validatorA: "0xa62DaB21E0C0F57e94B3ed6e675F214199989e92" as Address,
  vault: "0x12fAb3E3cA810Cc44bD9f537613a230a2be8D614" as Address,
  owner: "0x3EFEB3Cf2FB54A7D99abE90AaB786cE5A831a8CF" as Address,
  deadline: 1_791_216_243n,
};

/** A workflow config for the tests; `creValidator` defaults to validator A so the real request is "ours". */
export function testConfig(over: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    chainSelectorName: "monad-testnet",
    chainId: 10143,
    validationRegistry: "0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f",
    creValidator: REAL.validatorA,
    forwarder: "0xB9F79d863261869B234c481D1f9A7af84AeAd192",
    evaluateUrl: "http://127.0.0.1:8787/evaluate",
    gates: [{ gate: REAL.vault, agentId: "1984" }],
    pinLagBlocks: 5,
    maxEvidenceBytes: 16_384,
    pollAttempts: 10,
    httpTimeout: "9s",
    gas: { outerBase: 49_000, outerPerByte: 40, routing: 50_000, headroomPercent: 20, max: 1_000_000 },
    ...over,
  };
}
