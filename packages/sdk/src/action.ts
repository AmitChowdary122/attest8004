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
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

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
      [
        chainIdOf(chainId),
        gate,
        action.agentId,
        action.target,
        action.value,
        dataHash(action.data),
        action.deadline,
        salt(action.salt),
      ],
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
        chainIdOf(chainId),
        gate,
        validator,
        action.agentId,
        action.target,
        action.value,
        dataHash(action.data),
        action.deadline,
        salt(action.salt),
      ],
    ),
  );
}

// The checks below reject input that viem would otherwise turn into a hash no contract can produce:
// viem reads "0x123" as the bytes 0x0123, rounds a 63-digit bytes32 up and pads it, and hashes
// non-hex strings as UTF-8 text. viem itself rejects bad address checksums and out-of-range integers.

function dataHash(data: Hex): Hex {
  if (!EVEN_HEX.test(data)) {
    throw new TypeError(`action.data must be 0x-prefixed hex with whole bytes, got "${data}"`);
  }
  return keccak256(data);
}

function salt(value: Hex): Hex {
  if (!BYTES32.test(value)) throw new TypeError(`action.salt must be 32 bytes of 0x-prefixed hex, got "${value}"`);
  return value;
}

function chainIdOf(chainId: number | bigint): bigint {
  if (typeof chainId === "number" && !Number.isSafeInteger(chainId)) {
    throw new TypeError(`chainId must be a safe integer or a bigint, got ${chainId}`);
  }
  return BigInt(chainId);
}
