// Pure decoders for the indexer's handlers (no envio imports, so they're unit-tested and checked against the SDK).
// They mirror the SDK's own rules (packages/sdk/src/request.ts, action.ts), which Envio Cloud can't import: it
// uploads only this folder. test/lib.test.ts holds them to the SDK on every shared hash vector.
//
// Everything here reads attacker-controlled strings from events: nothing is fetched, nothing throws, and every
// output is lowercase hex or a decimal string.
import { encodeAbiParameters, isAddress, keccak256, type Hex } from "viem";

export type DecodeStatus = "VERIFIED" | "HASH_MISMATCH" | "NOT_INLINE" | "UNREADABLE";

/** The validators' limit on a request URI (SPEC §4.4): longer ones are never answered. */
export const MAX_REQUEST_URI_BYTES = 16_384;
/** The largest evidence document read for reasons; risk-v1 declines anything over 24,576 bytes. */
export const MAX_EVIDENCE_BYTES = 32_768;
/** Reasons kept per verdict, and the shape each one must have: a code, never prose or markup. */
export const MAX_REASONS = 16;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

const DATA_URI_PREFIX = /^data:application\/json(;charset=utf-8)?(;base64)?,/i;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DECIMAL = /^(0|[1-9]\d*)$/;
const HEX_BYTES = /^0x([0-9a-fA-F]{2})*$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const UINT256_MAX = 2n ** 256n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

type Decoded = { kind: "bytes"; bytes: Uint8Array } | { kind: "not-inline" } | { kind: "unreadable" };

/** A `data:application/json` URI's payload bytes, in the one form the SDK accepts (base64 or percent-encoded). */
function decodeDataUri(uri: string, maxUriLength: number): Decoded {
  const prefix = DATA_URI_PREFIX.exec(uri.slice(0, 64));
  if (!prefix) return { kind: "not-inline" };
  if (uri.length > maxUriLength || !PRINTABLE_ASCII.test(uri)) return { kind: "unreadable" };
  const payload = uri.slice(prefix[0].length);
  if (prefix[2]) {
    if (payload.length % 4 !== 0 || !BASE64.test(payload)) return { kind: "unreadable" };
    return { kind: "bytes", bytes: new Uint8Array(Buffer.from(payload, "base64")) };
  }
  try {
    return { kind: "bytes", bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
  } catch {
    return { kind: "unreadable" };
  }
}

function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseJson(bytes: Uint8Array): unknown {
  const text = utf8(bytes);
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));

/**
 * A verdict's evidence: `VERIFIED` when its `responseURI` is an inline document hashing to `responseHash`, with the
 * reason codes of an `attest8004.evidence.v1` document (codes only, at most {@link MAX_REASONS}); otherwise why not.
 */
export function decodeEvidence(uri: string, responseHash: string): { status: DecodeStatus; reasons: string[] | null } {
  const decoded = decodeDataUri(uri, Math.ceil((MAX_EVIDENCE_BYTES * 4) / 3) + 64);
  if (decoded.kind === "not-inline") return { status: "NOT_INLINE", reasons: null };
  if (decoded.kind === "unreadable" || decoded.bytes.length > MAX_EVIDENCE_BYTES) return { status: "UNREADABLE", reasons: null };
  if (keccak256(decoded.bytes) !== responseHash.toLowerCase()) return { status: "HASH_MISMATCH", reasons: null };
  const doc = parseJson(decoded.bytes);
  if (doc === undefined) return { status: "UNREADABLE", reasons: null };
  if (!isPlainObject(doc) || doc.schema !== "attest8004.evidence.v1" || !Array.isArray(doc.reasons)) {
    return { status: "VERIFIED", reasons: null };
  }
  const reasons = doc.reasons.filter((r): r is string => typeof r === "string" && REASON.test(r)).slice(0, MAX_REASONS);
  return { status: "VERIFIED", reasons };
}

export type DecodedRequest =
  | { status: "VERIFIED"; gate: string; target: string; value: string; deadline: bigint; actionHash: string }
  | { status: Exclude<DecodeStatus, "VERIFIED"> };

const address = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && isAddress(value, { strict: true });
const decimal = (value: unknown, max: bigint): value is string =>
  typeof value === "string" && DECIMAL.test(value) && BigInt(value) <= max;

/**
 * A request's JSON v1 (SPEC §4.4), read the way the validators read it: `VERIFIED` when its `requestURI` is an inline
 * document the SDK's strict schema accepts and whose fields recompute to `requestHash` on `chainId`, with the gate,
 * target, value, deadline and the `actionHash` the gate marks consumed.
 */
export function decodeRequest(uri: string, requestHash: string, chainId: number): DecodedRequest {
  const decoded = decodeDataUri(uri, MAX_REQUEST_URI_BYTES);
  if (decoded.kind === "not-inline") return { status: "NOT_INLINE" };
  if (decoded.kind === "unreadable") return { status: "UNREADABLE" };
  const doc = parseJson(decoded.bytes);
  if (!isPlainObject(doc) || !hasExactly(doc, ["schema", "chainId", "gate", "validator", "agentId", "action"])) return { status: "UNREADABLE" };
  const action = doc.action;
  if (!isPlainObject(action) || !hasExactly(action, ["target", "value", "data", "deadline", "salt"])) return { status: "UNREADABLE" };
  const { chainId: docChain, gate, validator, agentId } = doc;
  const { target, value, data, deadline, salt } = action;
  if (
    doc.schema !== "attest8004.request.v1" ||
    typeof docChain !== "number" ||
    !Number.isSafeInteger(docChain) ||
    docChain <= 0 ||
    !address(gate) ||
    !address(validator) ||
    !decimal(agentId, UINT256_MAX) ||
    !address(target) ||
    !decimal(value, UINT256_MAX) ||
    typeof data !== "string" ||
    !HEX_BYTES.test(data) ||
    !decimal(deadline, UINT64_MAX) ||
    typeof salt !== "string" ||
    !BYTES32.test(salt)
  ) {
    return { status: "UNREADABLE" };
  }
  const parts = [BigInt(docChain), gate as Hex, BigInt(agentId), target as Hex, BigInt(value), keccak256(data as Hex), BigInt(deadline), salt as Hex] as const;
  const recomputed = keccak256(
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
      [parts[0], parts[1], validator as Hex, parts[2], parts[3], parts[4], parts[5], parts[6], parts[7]],
    ),
  );
  if (docChain !== chainId || recomputed !== requestHash.toLowerCase()) return { status: "HASH_MISMATCH" };
  const actionHash = keccak256(
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
      [...parts],
    ),
  );
  return { status: "VERIFIED", gate: gate.toLowerCase(), target: target.toLowerCase(), value, deadline: BigInt(deadline), actionHash };
}

/**
 * A bytes4 value (a function selector) as 4-byte lowercase hex. HyperSync hands a `bytes4[]` element over as its full
 * 32-byte ABI word (left-aligned, as the ABI encodes bytesN); a right-aligned word is read too, and anything else is
 * kept as given.
 */
export function bytes4(value: string): string {
  const v = value.toLowerCase();
  if (/^0x[0-9a-f]{64}$/.test(v)) {
    if (/^0{56}$/.test(v.slice(10))) return v.slice(0, 10);
    if (/^0{56}$/.test(v.slice(2, 58))) return `0x${v.slice(58)}`;
  }
  return v;
}
