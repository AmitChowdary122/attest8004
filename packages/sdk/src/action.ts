import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/** An agent action that a gate executes only with validators' verdicts (SPEC §4.3). */
export interface Action {
  agentId: bigint;
  target: Address;
  value: bigint;
  data: Hex;
  /** Unix seconds; the gate rejects the action after this time. uint64. */
  deadline: bigint;
  /** 32 bytes that make otherwise identical actions distinct. */
  salt: Hex;
}

export interface ActionHashArgs {
  chainId: number | bigint;
  /** The gate contract that will execute the action (e.g. a DemoAgentVault). */
  gate: Address;
  action: Action;
}

export interface RequestHashArgs extends ActionHashArgs {
  /** The validator this request is addressed to: one requestHash per validator. */
  validator: Address;
}

const EVEN_HEX = /^0x([0-9a-fA-F]{2})*$/;

/**
 * keccak256(abi.encode(chainId, gate, agentId, target, value, keccak256(data), deadline, salt)).
 * The gate marks this hash consumed, so an action runs at most once. Same encoding as
 * contracts/src/ActionHash.sol; both are checked against test/vectors.json.
 */
export function computeActionHash({ chainId, gate, action }: ActionHashArgs): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint64" },
        { type: "bytes32" },
      ],
      [BigInt(chainId), gate, action.agentId, action.target, action.value, dataHash(action.data), action.deadline, action.salt],
    ),
  );
}

/**
 * The ERC-8004 requestHash for one validator:
 * keccak256(abi.encode(chainId, gate, validator, agentId, target, value, keccak256(data), deadline, salt)).
 * The gate recomputes it for each validator it requires. Same encoding as contracts/src/ActionHash.sol.
 */
export function computeRequestHash({ chainId, gate, validator, action }: RequestHashArgs): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint64" },
        { type: "bytes32" },
      ],
      [
        BigInt(chainId),
        gate,
        validator,
        action.agentId,
        action.target,
        action.value,
        dataHash(action.data),
        action.deadline,
        action.salt,
      ],
    ),
  );
}

/**
 * viem would read "0x123" as the bytes 0x0123, which is not what the calldata says, so anything but
 * whole bytes of hex is rejected. viem checks the rest: address checksums, integer ranges, bytes32 size.
 */
function dataHash(data: Hex): Hex {
  if (!EVEN_HEX.test(data)) {
    throw new TypeError(`action.data must be 0x-prefixed hex with whole bytes, got "${data}"`);
  }
  return keccak256(data);
}
