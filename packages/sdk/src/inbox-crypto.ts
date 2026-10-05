// The findings inbox's cryptography (SPEC §4.7, ARCHITECTURE §6 "Findings envelope"): the operator's X25519 inbox key,
// derived from a passkey's PRF output, and the sealed envelope a validator posts to FindingsBoard for it, bound to one
// chain, board, registry, request, agent, validator and recipient. Browser-safe: viem and noble only, no Node APIs.
//
// Every secret buffer a function allocates is handed to the optional `SecretTracker` (so tests can prove it) and zeroed
// in `finally`. What can't be zeroed is listed in ARCHITECTURE §9: noble's internal copies and bigints, the browser's
// own PRF ArrayBuffer and JS strings.
import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, encodeAbiParameters, hexToBytes, sha256, stringToBytes, type Address, type Hex } from "viem";

/** The PRF salt (Mera's `prfSalt`) whose output is the inbox key's input: `sha256("attest8004.inbox.v1")`. */
export const INBOX_PRF_SALT: Hex = sha256(stringToBytes("attest8004.inbox.v1"));
/** HKDF `info` for the inbox private key. */
export const INBOX_KEY_INFO = "attest8004.inbox.x25519.v1";
/** HKDF `info` for an envelope's AES-256-GCM key. */
export const FINDINGS_AEAD_INFO = "attest8004.findings.aes256gcm.v1";

/** The envelope's first byte. */
export const ENVELOPE_VERSION = 1;
/** FindingsBoard's `MAX_ENVELOPE_BYTES`: the board reverts a longer post. */
export const MAX_ENVELOPE_BYTES = 8192;
/** Version (1) + ephemeral public key (32) + nonce (12) + GCM tag (16). */
export const ENVELOPE_OVERHEAD_BYTES = 61;
/** The largest plaintext that still fits one post: `MAX_ENVELOPE_BYTES − ENVELOPE_OVERHEAD_BYTES`. */
export const MAX_REPORT_PLAINTEXT_BYTES = 8131;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
/** Version, ephemeral public key, nonce: everything before the ciphertext. */
const HEADER_BYTES = 1 + KEY_BYTES + NONCE_BYTES;

/** Receives every secret buffer a function allocates, before that function zeroes it. Tests use it to check the zeroing. */
export interface SecretTracker {
  track(buffer: Uint8Array): void;
}

/** What an envelope is bound to: its AAD, so a ciphertext can't be replayed under any other request, agent or validator. */
export interface EnvelopeContext {
  chainId: number;
  findingsBoard: Address;
  validationRegistry: Address;
  requestHash: Hex;
  agentId: bigint;
  validator: Address;
  /** The agent's inbox public key (X25519, 32 bytes), as `MandateRegistry.inboxKeyOf` returns it. */
  recipient: Hex;
}

/** Why an envelope didn't open, in the order the checks run. */
export type EnvelopeProblem = "MALFORMED" | "VERSION" | "RECIPIENT_MISMATCH" | "LOW_ORDER_KEY" | "DECRYPT_FAILED";

/** The recipient key is low order, so the X25519 shared secret would be all zero: nothing is sealed. */
export class LowOrderKeyError extends Error {
  constructor() {
    super("the inbox key is a low-order X25519 point: the shared secret would be zero, so nothing is sealed");
    this.name = "LowOrderKeyError";
  }
}

/** The plaintext doesn't fit one FindingsBoard post. */
export class PlaintextTooLargeError extends Error {
  /** The plaintext's size. */
  readonly bytes: number;

  constructor(bytes: number) {
    super(`the plaintext is ${bytes} bytes; an envelope carries at most ${MAX_REPORT_PLAINTEXT_BYTES}`);
    this.name = "PlaintextTooLargeError";
    this.bytes = bytes;
  }
}

/** Overwrites every byte of each buffer with zero. */
export function wipe(...buffers: Uint8Array[]): void {
  for (const buffer of buffers) buffer.fill(0);
}

/** HKDF-SHA256 with L = 32. The PRK between extract and expand is a secret too: tracked and zeroed here. */
function hkdf32(ikm: Uint8Array, salt: Uint8Array, info: string, tracker: SecretTracker | undefined): Uint8Array {
  const prk = extract(nobleSha256, ikm, salt);
  tracker?.track(prk);
  try {
    const okm = expand(nobleSha256, prk, stringToBytes(info), KEY_BYTES);
    tracker?.track(okm);
    return okm;
  } finally {
    wipe(prk);
  }
}

/** True when every byte is zero, reading every byte whatever it finds (no early exit). */
function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < bytes.length; i++) acc |= bytes[i] ?? 0;
  return acc === 0;
}

/**
 * The inbox private key: `HKDF-SHA256(prfOutput, salt = empty, info = INBOX_KEY_INFO, L = 32)`, clamped per RFC 7748
 * (`k[0] &= 248; k[31] &= 127; k[31] |= 64`). An empty salt is RFC 5869's all-zero salt; the PRF output is already
 * uniform. The caller owns the result and must zero it. `prfOutput` is never zeroed here; it must be 32 bytes.
 */
export function deriveInboxPrivateKey(prfOutput: Uint8Array, tracker?: SecretTracker): Uint8Array {
  if (!(prfOutput instanceof Uint8Array) || prfOutput.length !== KEY_BYTES) {
    throw new Error("the PRF output must be 32 bytes");
  }
  const key = hkdf32(prfOutput, new Uint8Array(0), INBOX_KEY_INFO, tracker);
  key[0] = (key[0] ?? 0) & 248;
  key[31] = ((key[31] ?? 0) & 127) | 64;
  return key;
}

/** `X25519(privateKey, 9)`, as the 32-byte hex `MandateRegistry.setInboxKey` takes. */
export function x25519PublicKey(privateKey: Uint8Array): Hex {
  return bytesToHex(x25519.getPublicKey(privateKey));
}

/**
 * The inbox public key for a PRF output, for publishing with `setInboxKey`. Zeroes `prfOutput` and the private key
 * before it returns or throws.
 */
export function inboxPublicKeyFromPrf(prfOutput: Uint8Array, tracker?: SecretTracker): Hex {
  let privateKey: Uint8Array | undefined;
  try {
    privateKey = deriveInboxPrivateKey(prfOutput, tracker);
    return x25519PublicKey(privateKey);
  } finally {
    if (privateKey) wipe(privateKey);
    wipe(prfOutput);
  }
}

/**
 * Runs `use` with the inbox key pair, then zeroes the private key and `prfOutput`, whether `use` returns, rejects or
 * throws. `use` must not keep the private key: it is all zero once the returned promise settles.
 */
export async function withInboxKey<T>(
  prfOutput: Uint8Array,
  use: (key: { privateKey: Uint8Array; publicKey: Hex }) => T | Promise<T>,
  tracker?: SecretTracker,
): Promise<T> {
  let privateKey: Uint8Array | undefined;
  try {
    privateKey = deriveInboxPrivateKey(prfOutput, tracker);
    return await use({ privateKey, publicKey: x25519PublicKey(privateKey) });
  } finally {
    if (privateKey) wipe(privateKey);
    wipe(prfOutput);
  }
}

/**
 * The envelope's AAD, 224 bytes: `abi.encode(uint256 chainId, address findingsBoard, address validationRegistry,
 * bytes32 requestHash, uint256 agentId, address validator, bytes32 recipient)`.
 */
export function envelopeAad(context: EnvelopeContext): Uint8Array {
  return hexToBytes(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
      ],
      [
        BigInt(context.chainId),
        context.findingsBoard,
        context.validationRegistry,
        context.requestHash,
        context.agentId,
        context.validator,
        context.recipient,
      ],
    ),
  );
}

/** `X25519(privateKey, publicKey)`, refusing an all-zero result (a low-order `publicKey`) with `LowOrderKeyError`. */
function sharedSecret(privateKey: Uint8Array, publicKey: Uint8Array, tracker: SecretTracker | undefined): Uint8Array {
  let shared: Uint8Array;
  try {
    // noble refuses an all-zero result itself; both input lengths are checked before this call.
    shared = x25519.getSharedSecret(privateKey, publicKey);
  } catch {
    throw new LowOrderKeyError();
  }
  tracker?.track(shared);
  if (isAllZero(shared)) throw new LowOrderKeyError();
  return shared;
}

/** `HKDF-SHA256(shared, salt = ephemeralPub ‖ recipientPub, info = FINDINGS_AEAD_INFO, L = 32)`. */
function aeadKey(
  shared: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  recipient: Uint8Array,
  tracker: SecretTracker | undefined,
): Uint8Array {
  const salt = new Uint8Array(2 * KEY_BYTES);
  salt.set(ephemeralPublicKey, 0);
  salt.set(recipient, KEY_BYTES);
  return hkdf32(shared, salt, FINDINGS_AEAD_INFO, tracker);
}

/**
 * Seals `plaintext` to `context.recipient`: `0x01 ‖ ephemeralPub (32) ‖ nonce (12) ‖ AES-256-GCM(key, nonce, aad,
 * plaintext) ‖ tag (16)`, with a fresh ephemeral key and nonce from `crypto.getRandomValues`. `ephemeralPrivateKey` and
 * `nonce` are for fixed test vectors only; a passed ephemeral key is zeroed like a generated one. Throws
 * `PlaintextTooLargeError` above `MAX_REPORT_PLAINTEXT_BYTES` and `LowOrderKeyError` when the shared secret would be zero.
 */
export function sealEnvelope(o: {
  plaintext: Uint8Array;
  context: EnvelopeContext;
  tracker?: SecretTracker;
  ephemeralPrivateKey?: Uint8Array;
  nonce?: Uint8Array;
}): Hex {
  const { plaintext, context, tracker } = o;
  const ephemeralPrivateKey = o.ephemeralPrivateKey ?? crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  tracker?.track(ephemeralPrivateKey);
  let shared: Uint8Array | undefined;
  let key: Uint8Array | undefined;
  try {
    if (plaintext.length > MAX_REPORT_PLAINTEXT_BYTES) throw new PlaintextTooLargeError(plaintext.length);
    if (ephemeralPrivateKey.length !== KEY_BYTES) throw new Error("the ephemeral private key must be 32 bytes");
    const nonce = o.nonce ?? crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    if (nonce.length !== NONCE_BYTES) throw new Error("the nonce must be 12 bytes");
    const recipient = hexToBytes(context.recipient);
    if (recipient.length !== KEY_BYTES) throw new Error("the recipient must be a 32-byte X25519 public key");

    const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);
    shared = sharedSecret(ephemeralPrivateKey, recipient, tracker);
    key = aeadKey(shared, ephemeralPublicKey, recipient, tracker);
    const ciphertext = gcm(key, nonce, envelopeAad(context)).encrypt(plaintext);

    const envelope = new Uint8Array(HEADER_BYTES + ciphertext.length);
    envelope[0] = ENVELOPE_VERSION;
    envelope.set(ephemeralPublicKey, 1);
    envelope.set(nonce, 1 + KEY_BYTES);
    envelope.set(ciphertext, HEADER_BYTES);
    return bytesToHex(envelope);
  } finally {
    wipe(ephemeralPrivateKey);
    if (shared) wipe(shared);
    if (key) wipe(key);
  }
}

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

/**
 * Opens an envelope with the inbox private key. Checks, in order: the length (61 to 8,192 bytes, else `MALFORMED`), the
 * version (`VERSION`), that `privateKey` belongs to `context.recipient` (`RECIPIENT_MISMATCH`), the ECDH (`LOW_ORDER_KEY`)
 * and the GCM tag over the context's AAD (`DECRYPT_FAILED`). Never throws on a hostile envelope. The plaintext is the
 * caller's; the shared secret and the AEAD key are zeroed before it returns.
 */
export function openEnvelope(o: {
  envelope: Hex;
  privateKey: Uint8Array;
  context: EnvelopeContext;
  tracker?: SecretTracker;
}): { ok: true; plaintext: Uint8Array } | { ok: false; problem: EnvelopeProblem } {
  const { envelope, privateKey, context, tracker } = o;
  const fail = (problem: EnvelopeProblem) => ({ ok: false, problem }) as const;

  // The length first, from the text alone, so a huge or non-hex string is never decoded.
  if (typeof envelope !== "string") return fail("MALFORMED");
  const size = (envelope.length - 2) / 2;
  if (!(size >= ENVELOPE_OVERHEAD_BYTES && size <= MAX_ENVELOPE_BYTES) || !HEX_BYTES.test(envelope)) return fail("MALFORMED");
  const bytes = hexToBytes(envelope);
  if (bytes[0] !== ENVELOPE_VERSION) return fail("VERSION");
  const recipient = x25519PublicKey(privateKey);
  if (recipient.toLowerCase() !== context.recipient.toLowerCase()) return fail("RECIPIENT_MISMATCH");

  const ephemeralPublicKey = bytes.subarray(1, 1 + KEY_BYTES);
  const nonce = bytes.subarray(1 + KEY_BYTES, HEADER_BYTES);
  const ciphertext = bytes.subarray(HEADER_BYTES);
  const aad = envelopeAad(context);
  let shared: Uint8Array | undefined;
  let key: Uint8Array | undefined;
  try {
    try {
      shared = sharedSecret(privateKey, ephemeralPublicKey, tracker);
    } catch {
      return fail("LOW_ORDER_KEY");
    }
    key = aeadKey(shared, ephemeralPublicKey, hexToBytes(recipient), tracker);
    try {
      return { ok: true, plaintext: gcm(key, nonce, aad).decrypt(ciphertext) };
    } catch {
      return fail("DECRYPT_FAILED");
    }
  } finally {
    if (shared) wipe(shared);
    if (key) wipe(key);
  }
}
