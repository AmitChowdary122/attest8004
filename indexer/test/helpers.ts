// Builders for the handler tests: real Attest8004 addresses, block metadata, and request/evidence URIs made with the
// SDK itself (imported by relative path for tests only), so a test's events look exactly like the chain's.
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import {
  DEPLOYMENTS,
  buildRequestJson,
  computeActionHash,
  computeRequestHash,
  encodeCanonicalJsonDataUri,
  encodeJsonDataUri,
  type Action,
} from "../../packages/sdk/src/index.ts";

const testnet = DEPLOYMENTS[10143];
const lower = (a: string) => a.toLowerCase() as Address;

export const CHAIN_ID = 10143;
export const REGISTRY = lower(testnet.validationRegistry);
export const FORWARDER = lower(testnet.agentRequestForwarder);
export const MANDATE_V1 = lower(testnet.mandateRegistries[0]?.address ?? "");
export const MANDATE_V2 = lower(testnet.mandateRegistries[1]?.address ?? "");
export const BOARD = lower(testnet.findingsBoard.address);
export const VAULT = lower(testnet.demoAgentVault);
export const VAULT_P3 = lower(testnet.demoAgentVaultP3);
export const IDENTITY = lower(testnet.identityRegistry);
export const VALIDATOR_A = lower(testnet.validators.mandateV1);
export const VALIDATOR_B = lower(testnet.validators.riskV1);
export const STRANGER = "0x00000000000000000000000000000000000057a1" as Address;
export const OWNER = "0x00000000000000000000000000000000000000a1" as Address;
export const OTHER_OWNER = "0x00000000000000000000000000000000000000b2" as Address;
export const HOT_KEY = "0x00000000000000000000000000000000000000c3" as Address;
/** v2's deploy block: the first block of the current MandateRegistry's epoch. */
export const V2_FROM = 68_196_462;
/** A block well inside every contract's range. */
export const B = 68_400_000;

const BASE_TIME = 1_790_000_000;
/** Block metadata for a simulated event: a timestamp that grows with the block, and a transaction hash. */
export function at(block: number, logIndex = 0, tag = "") {
  return {
    block: { number: block, timestamp: BASE_TIME + Math.floor(block / 3) },
    transaction: { hash: txHash(block, logIndex, tag) },
    logIndex,
  };
}
export const txHash = (block: number, logIndex = 0, tag = ""): Hex => keccak256(toHex(`tx ${block} ${logIndex} ${tag}`));
export const timeOf = (block: number) => BigInt(BASE_TIME + Math.floor(block / 3));

/** A request for `validator` on the demo vault: its data: URI, requestHash and actionHash (lowercase). */
export function request(o: { validator: Address; agentId?: bigint; salt?: string; gate?: Address; value?: bigint; data?: Hex }) {
  const action: Action = {
    agentId: o.agentId ?? 1984n,
    target: getAddress("0x00000000000000000000000000000000000000d4"),
    value: o.value ?? 1_000_000_000_000_000n,
    data: o.data ?? "0x",
    deadline: 1_790_100_000n,
    salt: keccak256(toHex(o.salt ?? "salt")),
  };
  const gate = getAddress(o.gate ?? VAULT);
  const validator = getAddress(o.validator);
  const json = buildRequestJson({ chainId: CHAIN_ID, gate, validator, action });
  return {
    uri: encodeJsonDataUri(json).uri,
    requestHash: computeRequestHash({ chainId: CHAIN_ID, gate, validator, action }).toLowerCase() as Hex,
    actionHash: computeActionHash({ chainId: CHAIN_ID, gate, action }).toLowerCase() as Hex,
    action,
  };
}

/** Inline evidence v1 for a verdict: its data: URI and responseHash. */
export function evidence(o: { requestHash: Hex; score: number; reasons?: string[]; tag?: string }) {
  const { uri, hash } = encodeCanonicalJsonDataUri({
    schema: "attest8004.evidence.v1",
    validator: o.tag ?? "mandate-v1",
    requestHash: o.requestHash,
    score: o.score,
    reasons: o.reasons ?? [],
  });
  return { uri, responseHash: hash.toLowerCase() as Hex };
}

/** A simulated ValidationRequest event. */
export function requestEvent(r: { uri: string; requestHash: Hex }, o: { validator: Address; agentId?: bigint; block: number; logIndex?: number }) {
  return {
    contract: "ValidationRegistry" as const,
    event: "ValidationRequest" as const,
    srcAddress: REGISTRY,
    params: { validatorAddress: o.validator, agentId: o.agentId ?? 1984n, requestURI: r.uri, requestHash: r.requestHash },
    ...at(o.block, o.logIndex),
  };
}

/** A simulated ValidationResponse event with inline evidence. */
export function responseEvent(o: { validator: Address; requestHash: Hex; score: number; tag?: string; reasons?: string[]; agentId?: bigint; block: number; logIndex?: number; uri?: string }) {
  const ev = evidence({ requestHash: o.requestHash, score: o.score, reasons: o.reasons, tag: o.tag });
  return {
    contract: "ValidationRegistry" as const,
    event: "ValidationResponse" as const,
    srcAddress: REGISTRY,
    params: {
      validatorAddress: o.validator,
      agentId: o.agentId ?? 1984n,
      requestHash: o.requestHash,
      response: BigInt(o.score),
      responseURI: o.uri ?? ev.uri,
      responseHash: ev.responseHash,
      tag: o.tag ?? "mandate-v1",
    },
    ...at(o.block, o.logIndex),
  };
}
