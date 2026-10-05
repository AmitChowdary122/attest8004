import { bytesToBigInt, bytesToHex, decodeEventLog, getAddress, parseAbi, type Address, type Hex } from "viem";

export const validationRequestEventAbi = parseAbi([
  "event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)",
]);

/** A `ValidationRequest` as the log trigger delivered it: the event's fields and where it was emitted. */
export interface TriggerRequest {
  validator: Address;
  agentId: bigint;
  /** Attacker-controlled text: parsed, never fetched. */
  requestURI: string;
  /** Lower-case. */
  requestHash: Hex;
  /** The request's block: validator C's pin `P`, identical on every node. */
  block: bigint;
  blockHash: Hex;
  txHash: Hex;
}

/** The fields of CRE's EVM log this decoder reads (the SDK's `EVMLog`). */
export interface TriggerLog {
  topics: Uint8Array[];
  data: Uint8Array;
  blockHash: Uint8Array;
  txHash: Uint8Array;
  blockNumber?: { absVal: Uint8Array; sign: bigint };
}

/** Decodes the trigger's log as a ValidationRequest. Throws on any other event or a log without a block number. */
export function decodeValidationRequest(log: TriggerLog): TriggerRequest {
  if (log.blockNumber === undefined || log.blockNumber.sign < 0n) throw new Error("the trigger log carries no block number");
  const { args } = decodeEventLog({
    abi: validationRequestEventAbi,
    eventName: "ValidationRequest",
    data: bytesToHex(log.data),
    topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
  });
  return {
    validator: getAddress(args.validatorAddress),
    agentId: args.agentId,
    requestURI: args.requestURI,
    requestHash: args.requestHash.toLowerCase() as Hex,
    block: bytesToBigInt(log.blockNumber.absVal),
    blockHash: bytesToHex(log.blockHash),
    txHash: bytesToHex(log.txHash),
  };
}
