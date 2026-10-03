import { getAddress, isAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { z } from "zod";
import { computeRequestHash, type Action } from "./action.ts";

/**
 * Request JSON v1 (ARCHITECTURE §6): what an agent puts at `requestURI`, one document per validator.
 * Validators recompute `requestHash` from these fields (SPEC §4.3) and ignore the request if it
 * doesn't match. `agentId`, `value` and `deadline` are decimal strings, so values above 2^53 survive
 * JSON; `chainId` is a JSON number.
 */
export interface RequestJsonV1 {
  schema: typeof REQUEST_SCHEMA_V1;
  chainId: number;
  gate: Address;
  validator: Address;
  agentId: string;
  action: { target: Address; value: string; data: Hex; deadline: string; salt: Hex };
}

export const REQUEST_SCHEMA_V1 = "attest8004.request.v1";

/** Validators accept a request only as a data: URI of at most this many bytes, and never fetch one. */
export const MAX_REQUEST_URI_BYTES = 16_384;

const UINT256_MAX = 2n ** 256n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

const decimal = (max: bigint) =>
  z
    .string()
    .regex(/^(0|[1-9]\d*)$/, "must be a decimal string without leading zeros")
    .refine((s) => BigInt(s) <= max, "out of range");

// Lower-case is accepted; mixed case must be a valid EIP-55 checksum. Output is checksummed.
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address")
  .refine((s) => isAddress(s, { strict: true }), "bad EIP-55 checksum")
  .transform((s) => getAddress(s));

const wholeBytes = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})*$/, "must be 0x-prefixed hex with whole bytes")
  .transform((s) => s as Hex);

const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be 32 bytes of 0x-prefixed hex")
  .transform((s) => s as Hex);

/** Strict: unknown keys are rejected, so everything a validator reads is something the hash covers. */
export const requestJsonV1Schema: z.ZodType<RequestJsonV1> = z.strictObject({
  schema: z.literal(REQUEST_SCHEMA_V1),
  chainId: z.number().int().positive().refine(Number.isSafeInteger, "must be a safe integer"),
  gate: address,
  validator: address,
  agentId: decimal(UINT256_MAX),
  action: z.strictObject({
    target: address,
    value: decimal(UINT256_MAX),
    data: wholeBytes,
    deadline: decimal(UINT64_MAX),
    salt: bytes32,
  }),
});

/** The request JSON v1 for one validator. Throws if any field is out of range or malformed. */
export function buildRequestJson(args: {
  chainId: number;
  gate: Address;
  validator: Address;
  action: Action;
}): RequestJsonV1 {
  const { chainId, gate, validator, action } = args;
  return requestJsonV1Schema.parse({
    schema: REQUEST_SCHEMA_V1,
    chainId,
    gate,
    validator,
    agentId: action.agentId.toString(),
    action: {
      target: action.target,
      value: action.value.toString(),
      data: action.data,
      deadline: action.deadline.toString(),
      salt: action.salt,
    },
  });
}

export function requestJsonToAction(json: RequestJsonV1): Action {
  return {
    agentId: BigInt(json.agentId),
    target: json.action.target,
    value: BigInt(json.action.value),
    data: json.action.data,
    deadline: BigInt(json.action.deadline),
    salt: json.action.salt,
  };
}

/** The requestHash these fields commit to (SPEC §4.3). Validators compare it with the event's. */
export function requestHashOfJson(json: RequestJsonV1): Hex {
  return computeRequestHash({
    chainId: json.chainId,
    gate: json.gate,
    validator: json.validator,
    action: requestJsonToAction(json),
  });
}

/** A JSON document as a base64 data: URI, plus keccak256 of its exact UTF-8 bytes. */
export function encodeJsonDataUri(doc: unknown): { uri: string; hash: Hex } {
  const bytes = stringToBytes(JSON.stringify(doc));
  return { uri: `data:application/json;base64,${toBase64(bytes)}`, hash: keccak256(bytes) };
}

export type UriRejection = "URI_NOT_DATA" | "URI_TOO_LARGE" | "URI_MALFORMED";
export type RequestRejection = UriRejection | "JSON_INVALID" | "SCHEMA_INVALID";

const DATA_URI_PREFIX = /^data:application\/json(;charset=utf-8)?(;base64)?,/i;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decodes a `data:application/json` URI (base64 or percent-encoded) without fetching anything.
 * `requestURI` comes from whoever sent the request, so it is checked before any decoding: only this
 * one URI form, at most `maxBytes`, printable ASCII, and the payload must decode to valid UTF-8.
 */
export function decodeJsonDataUri(
  uri: string,
  maxBytes: number = MAX_REQUEST_URI_BYTES,
): { ok: true; text: string } | { ok: false; reason: UriRejection; detail: string } {
  const prefix = DATA_URI_PREFIX.exec(uri.slice(0, 64));
  if (!prefix) return { ok: false, reason: "URI_NOT_DATA", detail: `not a data:application/json URI: ${preview(uri)}` };
  if (uri.length > maxBytes) {
    return { ok: false, reason: "URI_TOO_LARGE", detail: `${uri.length} bytes, the limit is ${maxBytes}` };
  }
  if (!PRINTABLE_ASCII.test(uri)) return { ok: false, reason: "URI_MALFORMED", detail: "non-ASCII characters" };

  const payload = uri.slice(prefix[0].length);
  if (prefix[2]) {
    if (payload.length % 4 !== 0 || !BASE64.test(payload)) {
      return { ok: false, reason: "URI_MALFORMED", detail: "invalid base64" };
    }
    try {
      return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(fromBase64(payload)) };
    } catch {
      return { ok: false, reason: "URI_MALFORMED", detail: "the base64 payload is not valid UTF-8" };
    }
  }
  try {
    return { ok: true, text: decodeURIComponent(payload) };
  } catch {
    return { ok: false, reason: "URI_MALFORMED", detail: "invalid percent-encoding" };
  }
}

/** Decodes and validates a `requestURI` as request JSON v1. Never fetches; never throws. */
export function parseRequestUri(
  uri: string,
  maxBytes: number = MAX_REQUEST_URI_BYTES,
): { ok: true; json: RequestJsonV1 } | { ok: false; reason: RequestRejection; detail: string } {
  const decoded = decodeJsonDataUri(uri, maxBytes);
  if (!decoded.ok) return decoded;
  let doc: unknown;
  try {
    doc = JSON.parse(decoded.text);
  } catch {
    return { ok: false, reason: "JSON_INVALID", detail: "the payload is not JSON" };
  }
  const parsed = requestJsonV1Schema.safeParse(doc);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid";
    return { ok: false, reason: "SCHEMA_INVALID", detail };
  }
  return { ok: true, json: parsed.data };
}

function preview(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

// atob/btoa exist in browsers and Node, so the SDK's root entry needs no Node-only APIs.
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
