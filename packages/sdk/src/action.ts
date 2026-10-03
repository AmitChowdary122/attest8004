import { encodeAbiParameters, getAddress, keccak256, toHex, type Address, type Hex } from "viem";

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

/**
 * The fields `computeRequestHashFromParts`/`computeActionHashFromParts` hash directly, with
 * `dataHash` already computed (`keccak256(data)`) instead of raw `data`. A caller that already
 * holds these parts — recomputed from on-chain state, or from a verified `mandate-v1` evidence
 * `request` — hashes them straight through, without reassembling an `Action`.
 */
export interface RequestParts {
  chainId: number | bigint;
  /** The gate contract that will execute the action (e.g. a DemoAgentVault). */
  gate: Address;
  /** The validator this request is addressed to: one requestHash per validator. */
  validator: Address;
  agentId: bigint;
  target: Address;
  value: bigint;
  /** keccak256 of the action's `data`. */
  dataHash: Hex;
  /** Unix seconds; the gate rejects the action after this time. uint64. */
  deadline: bigint;
  /** 32 bytes that make otherwise identical actions distinct. */
  salt: Hex;
}

const EVEN_HEX = /^0x([0-9a-fA-F]{2})*$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * keccak256(abi.encode(chainId, gate, agentId, target, value, keccak256(data), deadline, salt)).
 * The gate marks this hash consumed, so an action runs at most once. Same encoding as
 * contracts/src/ActionHash.sol; both are checked against test/vectors.json.
 */
export function computeActionHash({ chainId, gate, action }: ActionHashArgs): Hex {
  return computeActionHashFromParts({
    chainId,
    gate,
    agentId: action.agentId,
    target: action.target,
    value: action.value,
    dataHash: dataHash(action.data),
    deadline: action.deadline,
    salt: salt(action.salt),
  });
}

/**
 * The ERC-8004 requestHash for one validator:
 * keccak256(abi.encode(chainId, gate, validator, agentId, target, value, keccak256(data), deadline, salt)).
 * The gate recomputes it for each validator it requires. Same encoding as contracts/src/ActionHash.sol.
 */
export function computeRequestHash({ chainId, gate, validator, action }: RequestHashArgs): Hex {
  return computeRequestHashFromParts({
    chainId,
    gate,
    validator,
    agentId: action.agentId,
    target: action.target,
    value: action.value,
    dataHash: dataHash(action.data),
    deadline: action.deadline,
    salt: salt(action.salt),
  });
}

/**
 * `computeActionHash`, taking `dataHash` (`keccak256(data)`) directly instead of `data`. Unlike
 * `computeActionHash`, this does not check that `dataHash`/`salt` are well-formed 32-byte hex (the
 * caller is expected to already hold them in that form); `chainId` is still range-checked.
 */
export function computeActionHashFromParts(p: Omit<RequestParts, "validator">): Hex {
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
      [chainIdOf(p.chainId), p.gate, p.agentId, p.target, p.value, p.dataHash, p.deadline, p.salt],
    ),
  );
}

/**
 * `computeRequestHash`, taking `dataHash` (`keccak256(data)`) directly instead of `data`. Unlike
 * `computeRequestHash`, this does not check that `dataHash`/`salt` are well-formed 32-byte hex (the
 * caller is expected to already hold them in that form); `chainId` is still range-checked.
 */
export function computeRequestHashFromParts(p: RequestParts): Hex {
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
      [chainIdOf(p.chainId), p.gate, p.validator, p.agentId, p.target, p.value, p.dataHash, p.deadline, p.salt],
    ),
  );
}

const UINT256_MAX = 2n ** 256n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

/**
 * An action with defaults: value 0, empty data and a random 32-byte salt. Throws on any field the
 * gate would see differently (out-of-range integers, partial bytes, a salt that isn't 32 bytes, a
 * bad address checksum), and checksums the target.
 */
export function buildAction(args: {
  agentId: bigint;
  target: Address;
  value?: bigint;
  data?: Hex;
  deadline: bigint;
  salt?: Hex;
}): Action {
  const action: Action = {
    agentId: inRange("action.agentId", args.agentId, UINT256_MAX),
    target: getAddress(args.target),
    value: inRange("action.value", args.value ?? 0n, UINT256_MAX),
    data: args.data ?? "0x",
    deadline: inRange("action.deadline", args.deadline, UINT64_MAX),
    salt: args.salt ?? toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  dataHash(action.data);
  salt(action.salt);
  return action;
}

function inRange(label: string, value: bigint, max: bigint): bigint {
  if (value < 0n || value > max) throw new RangeError(`${label} must be between 0 and ${max}, got ${value}`);
  return value;
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
