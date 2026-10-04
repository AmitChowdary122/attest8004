// WebAuthn parsing and a local P-256 check for passkey approvals (SPEC §4.2, ARCHITECTURE §6).
// Browser-safe: viem plus Web APIs (WebCrypto, TextEncoder) only, so /approve and the scripts share it.
import { bytesToHex, concat, hexToBytes, sha256, type Hex } from "viem";

/** The order of the P-256 group. */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
/** OpenZeppelin's `P256` accepts `s` up to this value only (low-s); `s` above it is replaced by `n − s`. */
export const P256_HALF_N = P256_N >> 1n;

const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

/**
 * One WebAuthn assertion as OpenZeppelin's `WebAuthn.WebAuthnAuth` takes it, JSON-shaped: `r` and `s`
 * as 32-byte hex (`s` already low), the two indices as byte offsets into the UTF-8 `clientDataJSON`.
 */
export interface WebAuthnAuthJson {
  r: Hex;
  s: Hex;
  challengeIndex: number;
  typeIndex: number;
  authenticatorData: Hex;
  clientDataJSON: string;
}

/** Why a local check refused an assertion; each is a check the contract would also fail. */
export type AssertionProblem =
  | "RP_ID_HASH"
  | "USER_NOT_PRESENT"
  | "USER_NOT_VERIFIED"
  | "BACKUP_STATE"
  | "TYPE"
  | "CHALLENGE"
  | "HIGH_S"
  | "SIGNATURE";

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url, as WebAuthn puts the challenge in `clientDataJSON` and as credential ids travel. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
    for (let c = 0; c < chars; c++) out += BASE64URL[(chunk >> (18 - 6 * c)) & 63];
  }
  return out;
}

/** Decodes canonical unpadded base64url; throws on any other character, padding, or non-canonical trailing bits. */
export function base64UrlDecode(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error("not base64url: impossible length");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const value = BASE64URL.indexOf(ch);
    if (value < 0) throw new Error("not base64url: unexpected character");
    buffer = ((buffer << 6) | value) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) throw new Error("not base64url: non-canonical trailing bits");
  return Uint8Array.from(out);
}

const SPKI_P256_PREFIX = hexToBytes("0x3059301306072a8648ce3d020106082a8648ce3d030107034200");

/**
 * The public key `(qx, qy)` from a P-256 SubjectPublicKeyInfo, as `AuthenticatorAttestationResponse.getPublicKey()`
 * returns it: exactly the 26-byte P-256 SPKI prefix, `0x04` (uncompressed), x, y. Anything else throws, and so does a
 * point that isn't on the curve.
 */
export function p256PublicKeyFromSpki(spki: Uint8Array): { qx: Hex; qy: Hex } {
  if (spki.length !== SPKI_P256_PREFIX.length + 65) throw new Error("not an uncompressed P-256 SPKI key: wrong length");
  for (let i = 0; i < SPKI_P256_PREFIX.length; i++) {
    if (spki[i] !== SPKI_P256_PREFIX[i]) throw new Error("not a P-256 SPKI key: wrong algorithm or curve");
  }
  if (spki[SPKI_P256_PREFIX.length] !== 0x04) throw new Error("not an uncompressed P-256 point");
  const start = SPKI_P256_PREFIX.length + 1;
  const qx = bytesToHex(spki.slice(start, start + 32));
  const qy = bytesToHex(spki.slice(start + 32, start + 64));
  if (!isOnP256(qx, qy)) throw new Error("the SPKI point is not on P-256");
  return { qx, qy };
}

/** Whether `(qx, qy)` is a point on P-256 with both coordinates below p (the check OpenZeppelin's `P256.isValidPublicKey` makes). */
export function isOnP256(qx: Hex, qy: Hex): boolean {
  const x = BigInt(qx);
  const y = BigInt(qy);
  if (x >= P256_P || y >= P256_P) return false;
  const mod = (v: bigint) => ((v % P256_P) + P256_P) % P256_P;
  return mod(y * y) === mod(x * x * x - 3n * x + P256_B);
}

/**
 * `(r, s)` from a DER `ECDSA-Sig-Value`, as WebAuthn returns an ES256 signature, each as 32-byte hex, with `s`
 * replaced by `n − s` when it is above `n/2`: an equally valid signature, and the only form OpenZeppelin's `P256`
 * accepts. Throws on malformed DER, trailing bytes, or `r`/`s` outside `[1, n − 1]`.
 */
export function signatureFromDer(der: Uint8Array): { r: Hex; s: Hex } {
  let at = 0;
  const byte = (): number => {
    const b = der[at++];
    if (b === undefined) throw new Error("DER signature: truncated");
    return b;
  };
  const length = (): number => {
    const first = byte();
    if (first < 0x80) return first;
    if (first !== 0x81) throw new Error("DER signature: unsupported length form");
    const value = byte();
    if (value < 0x80) throw new Error("DER signature: non-minimal length");
    return value;
  };
  const integer = (): bigint => {
    if (byte() !== 0x02) throw new Error("DER signature: expected an INTEGER");
    const len = length();
    if (len === 0 || len > 33 || at + len > der.length) throw new Error("DER signature: bad INTEGER length");
    const value = der.slice(at, at + len);
    at += len;
    if ((value[0] ?? 0) & 0x80) throw new Error("DER signature: negative INTEGER");
    return BigInt(bytesToHex(value));
  };
  if (byte() !== 0x30) throw new Error("DER signature: expected a SEQUENCE");
  const total = length();
  if (at + total !== der.length) throw new Error("DER signature: length mismatch or trailing bytes");
  const r = integer();
  let s = integer();
  if (at !== der.length) throw new Error("DER signature: trailing bytes in SEQUENCE");
  if (r <= 0n || r >= P256_N || s <= 0n || s >= P256_N) throw new Error("DER signature: r or s out of range");
  if (s > P256_HALF_N) s = P256_N - s;
  return { r: toBytes32(r), s: toBytes32(s) };
}

/**
 * The byte offsets of `"type":"webauthn.get"` and `"challenge":"` in the UTF-8 encoding of `clientDataJSON`, the
 * string exactly as the browser returned it. Browsers may add keys (Chrome sometimes appends
 * `other_keys_can_be_added_here`), so this searches rather than assuming a template. Throws if either is missing.
 */
export function clientDataIndices(clientDataJSON: string): { typeIndex: number; challengeIndex: number } {
  const bytes = new TextEncoder().encode(clientDataJSON);
  const typeIndex = indexOfBytes(bytes, new TextEncoder().encode('"type":"webauthn.get"'));
  const challengeIndex = indexOfBytes(bytes, new TextEncoder().encode('"challenge":"'));
  if (typeIndex < 0) throw new Error('clientDataJSON has no "type":"webauthn.get"');
  if (challengeIndex < 0) throw new Error('clientDataJSON has no "challenge"');
  return { typeIndex, challengeIndex };
}

/** The challenge `clientDataJSON` carries, base64url-decoded, as hex. */
export function challengeFromClientData(clientDataJSON: string): Hex {
  const parsed: unknown = JSON.parse(clientDataJSON);
  const challenge = (parsed as { challenge?: unknown }).challenge;
  if (typeof challenge !== "string") throw new Error("clientDataJSON has no challenge string");
  return bytesToHex(base64UrlDecode(challenge));
}

/** `rpIdHash` and the UP, UV, BE and BS flags of WebAuthn authenticator data (at least 37 bytes). */
export function authenticatorFlags(authenticatorData: Uint8Array): { rpIdHash: Hex; up: boolean; uv: boolean; be: boolean; bs: boolean } {
  if (authenticatorData.length < 37) throw new Error("authenticator data is shorter than 37 bytes");
  const flags = authenticatorData[32] ?? 0;
  return {
    rpIdHash: bytesToHex(authenticatorData.slice(0, 32)),
    up: (flags & 0x01) !== 0,
    uv: (flags & 0x04) !== 0,
    be: (flags & 0x08) !== 0,
    bs: (flags & 0x10) !== 0,
  };
}

/**
 * The attested credential data of a creation's authenticator data (WebAuthn §6.5.1): the credential id, and the x and
 * y of its COSE EC2 key (`-2: bstr(32)`, `-3: bstr(32)`), or `null` when the AT flag is clear or the data is truncated.
 * A key that isn't EC2 P-256 gives `x` and `y` as `null`.
 */
export function attestedCredential(authenticatorData: Uint8Array): { credentialId: Hex; x: Hex | null; y: Hex | null } | null {
  if (authenticatorData.length < 55 || ((authenticatorData[32] ?? 0) & 0x40) === 0) return null;
  const length = ((authenticatorData[53] ?? 0) << 8) | (authenticatorData[54] ?? 0);
  const keyStart = 55 + length;
  if (length === 0 || authenticatorData.length <= keyStart) return null;
  const key = authenticatorData.slice(keyStart);
  const field = (label: number): Hex | null => {
    const at = indexOfBytes(key, Uint8Array.of(label, 0x58, 0x20));
    return at < 0 || at + 35 > key.length ? null : bytesToHex(key.slice(at + 3, at + 35));
  };
  return { credentialId: bytesToHex(authenticatorData.slice(55, keyStart)), x: field(0x21), y: field(0x22) };
}

/**
 * Checks an assertion the way MandateRegistry v2 will, before anything is exported or sent: the rpIdHash, UP and UV,
 * BE/BS consistency, `"type":"webauthn.get"` and the expected challenge at their indices, low-s, and the P-256
 * signature over `authenticatorData ‖ sha256(clientDataJSON)` against `(qx, qy)` (WebCrypto). The first failing check
 * is the answer; a key that isn't on the curve is `SIGNATURE`.
 */
export async function verifyAssertionLocally(o: {
  auth: WebAuthnAuthJson;
  challenge: Hex;
  qx: Hex;
  qy: Hex;
  rpIdHash: Hex;
}): Promise<{ ok: true } | { ok: false; problem: AssertionProblem }> {
  const { auth } = o;
  const authenticatorData = hexToBytes(auth.authenticatorData);
  if (authenticatorData.length < 37) return { ok: false, problem: "RP_ID_HASH" };
  const flags = authenticatorFlags(authenticatorData);
  if (flags.rpIdHash.toLowerCase() !== o.rpIdHash.toLowerCase()) return { ok: false, problem: "RP_ID_HASH" };
  if (!flags.up) return { ok: false, problem: "USER_NOT_PRESENT" };
  if (!flags.uv) return { ok: false, problem: "USER_NOT_VERIFIED" };
  if (flags.bs && !flags.be) return { ok: false, problem: "BACKUP_STATE" };

  const clientData = new TextEncoder().encode(auth.clientDataJSON);
  if (!bytesAt(clientData, auth.typeIndex, '"type":"webauthn.get"')) return { ok: false, problem: "TYPE" };
  const expected = `"challenge":"${base64UrlEncode(hexToBytes(o.challenge))}"`;
  if (!bytesAt(clientData, auth.challengeIndex, expected)) return { ok: false, problem: "CHALLENGE" };

  const r = BigInt(auth.r);
  const s = BigInt(auth.s);
  if (s > P256_HALF_N) return { ok: false, problem: "HIGH_S" };
  if (r <= 0n || r >= P256_N || s <= 0n || !isOnP256(o.qx, o.qy)) return { ok: false, problem: "SIGNATURE" };

  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey("raw", bufferOf(concat(["0x04", o.qx, o.qy])), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signed = bufferOf(concat([auth.authenticatorData, sha256(clientData)]));
  const valid = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bufferOf(concat([auth.r, auth.s])), signed);
  return valid ? { ok: true } : { ok: false, problem: "SIGNATURE" };
}

/** Hex as bytes backed by a plain ArrayBuffer, the `BufferSource` WebCrypto and WebAuthn take under the DOM types. */
export function bufferOf(hex: Hex): Uint8Array<ArrayBuffer> {
  return new Uint8Array(hexToBytes(hex));
}

function toBytes32(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function bytesAt(haystack: Uint8Array, index: number, text: string): boolean {
  if (!Number.isSafeInteger(index) || index < 0) return false;
  const needle = new TextEncoder().encode(text);
  if (index + needle.length > haystack.length) return false;
  for (let j = 0; j < needle.length; j++) if (haystack[index + j] !== needle[j]) return false;
  return true;
}
