import { generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { bytesToHex, concat, hexToBytes, sha256, stringToBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  P256_HALF_N,
  P256_N,
  RP_ID_HASH,
  authenticatorFlags,
  base64UrlDecode,
  base64UrlEncode,
  challengeFromClientData,
  clientDataIndices,
  p256PublicKeyFromSpki,
  signatureFromDer,
  verifyAssertionLocally,
  type WebAuthnAuthJson,
} from "../src/index.ts";

const CHALLENGE: Hex = `0x${"ab".repeat(32)}`;

function p256(): { privateKey: KeyObject; spki: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, spki: new Uint8Array(publicKey.export({ type: "spki", format: "der" })) };
}

/** Chrome's clientDataJSON for a get() on attest8004.vercel.app, optionally with its sometimes-added extra key or keys reordered. */
function clientData(challenge: Hex, variant: "plain" | "extraKey" | "reordered" = "plain"): string {
  const b64 = base64UrlEncode(hexToBytes(challenge));
  if (variant === "reordered") return `{"challenge":"${b64}","origin":"https://attest8004.vercel.app","type":"webauthn.get"}`;
  const base = `{"type":"webauthn.get","challenge":"${b64}","origin":"https://attest8004.vercel.app","crossOrigin":false`;
  return variant === "extraKey"
    ? `${base},"other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See https://goo.gl/yabPex"}`
    : `${base}}`;
}

function authData(o: { rpIdHash?: Hex; flags?: number } = {}): Hex {
  return concat([o.rpIdHash ?? RP_ID_HASH, bytesToHex(Uint8Array.of(o.flags ?? 0x1d)), "0x00000000"]);
}

/** An assertion signed with node:crypto, parsed with the SDK (DER → low-s, searched indices). */
function assertion(privateKey: KeyObject, o: { challenge?: Hex; flags?: number; rpIdHash?: Hex; variant?: "plain" | "extraKey" | "reordered" } = {}): WebAuthnAuthJson {
  const clientDataJSON = clientData(o.challenge ?? CHALLENGE, o.variant);
  const authenticatorData = authData(o);
  const der = sign("sha256", hexToBytes(concat([authenticatorData, sha256(stringToBytes(clientDataJSON))])), privateKey);
  return { ...signatureFromDer(new Uint8Array(der)), ...clientDataIndices(clientDataJSON), authenticatorData, clientDataJSON };
}

/** A DER ECDSA-Sig-Value for (r, s), minimally encoded. */
function der(r: bigint, s: bigint): Uint8Array {
  const int = (v: bigint) => {
    let hex = v.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    if (Number.parseInt(hex.slice(0, 2), 16) & 0x80) hex = `00${hex}`;
    const bytes = hexToBytes(`0x${hex}`);
    return Uint8Array.of(0x02, bytes.length, ...bytes);
  };
  const body = Uint8Array.of(...int(r), ...int(s));
  return Uint8Array.of(0x30, body.length, ...body);
}

describe("base64url", () => {
  it("round-trips every remainder length without padding", () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);
      const text = base64UrlEncode(bytes);
      expect(text).not.toMatch(/[=+/]/);
      expect(text).toBe(Buffer.from(bytes).toString("base64url"));
      expect(base64UrlDecode(text)).toEqual(bytes);
    }
  });

  it("encodes a 32-byte challenge as 43 characters", () => {
    expect(base64UrlEncode(hexToBytes(CHALLENGE))).toHaveLength(43);
  });

  it("rejects padding, other alphabets and non-canonical trailing bits", () => {
    expect(() => base64UrlDecode("qw==")).toThrow();
    expect(() => base64UrlDecode("q+8")).toThrow();
    expect(() => base64UrlDecode("qx")).toThrow(); // "qw" is canonical for 0xab; "qx" sets unused bits
    expect(() => base64UrlDecode("a")).toThrow();
  });
});

describe("p256PublicKeyFromSpki", () => {
  it("returns x and y of a node:crypto P-256 key's SPKI", () => {
    const { privateKey, spki } = p256();
    const jwk = privateKey.export({ format: "jwk" });
    const { qx, qy } = p256PublicKeyFromSpki(spki);
    expect(qx).toBe(bytesToHex(Buffer.from(jwk.x as string, "base64url")));
    expect(qy).toBe(bytesToHex(Buffer.from(jwk.y as string, "base64url")));
  });

  it("rejects P-384, Ed25519, a wrong prefix and a point off the curve", () => {
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey.export({ type: "spki", format: "der" });
    const ed25519 = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
    expect(() => p256PublicKeyFromSpki(new Uint8Array(p384))).toThrow();
    expect(() => p256PublicKeyFromSpki(new Uint8Array(ed25519))).toThrow();
    const { spki } = p256();
    const wrongPrefix = spki.slice();
    wrongPrefix[5] = 0x99;
    expect(() => p256PublicKeyFromSpki(wrongPrefix)).toThrow(/algorithm or curve/);
    const offCurve = spki.slice();
    offCurve[offCurve.length - 1] = (offCurve[offCurve.length - 1] ?? 0) ^ 1;
    expect(() => p256PublicKeyFromSpki(offCurve)).toThrow(/not on P-256/);
  });
});

describe("signatureFromDer", () => {
  it("flips s above n/2 to n − s, and node:crypto still accepts the result", () => {
    const { privateKey, spki } = p256();
    const message = Buffer.from("attest8004");
    for (let i = 0; i < 32; i++) {
      const raw = new Uint8Array(sign("sha256", message, privateKey));
      const { r, s } = signatureFromDer(raw);
      expect(BigInt(s) <= P256_HALF_N).toBe(true);
      const p1363 = Buffer.from(hexToBytes(concat([r, s])));
      expect(verify("sha256", message, { ...spkiKey(spki), dsaEncoding: "ieee-p1363" }, p1363)).toBe(true);
    }
  });

  it("handles a 33-byte (0x00-padded) r and a 31-byte s", () => {
    const r = 0x80n << 248n; // high bit set → DER pads with 0x00
    const s = 0x01n << 240n; // 31 bytes
    const parsed = signatureFromDer(der(r, s));
    expect(BigInt(parsed.r)).toBe(r);
    expect(BigInt(parsed.s)).toBe(s);
    expect(parsed.r).toHaveLength(66);
    expect(parsed.s).toHaveLength(66);
  });

  it("returns n − s for a high s", () => {
    const s = P256_N - 5n;
    expect(BigInt(signatureFromDer(der(7n, s)).s)).toBe(5n);
  });

  it("rejects malformed DER, trailing bytes, and r or s out of range", () => {
    expect(() => signatureFromDer(Uint8Array.of(0x31, 0x00))).toThrow();
    expect(() => signatureFromDer(Uint8Array.of(...der(1n, 1n), 0x00))).toThrow();
    expect(() => signatureFromDer(der(0n, 1n))).toThrow(/out of range/);
    expect(() => signatureFromDer(der(1n, P256_N))).toThrow(/out of range/);
  });
});

describe("clientDataIndices", () => {
  it("finds type and challenge in Chrome's JSON, with the extra key, and with keys reordered", () => {
    for (const variant of ["plain", "extraKey", "reordered"] as const) {
      const json = clientData(CHALLENGE, variant);
      const { typeIndex, challengeIndex } = clientDataIndices(json);
      expect(json.slice(typeIndex, typeIndex + 21)).toBe('"type":"webauthn.get"');
      expect(json.slice(challengeIndex, challengeIndex + 13)).toBe('"challenge":"');
    }
  });

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    const json = `{"origin":"https://é.example","type":"webauthn.get","challenge":"qw"}`;
    expect(clientDataIndices(json).typeIndex).toBe(json.indexOf('"type"') + 1);
  });

  it("throws when either key is missing", () => {
    expect(() => clientDataIndices(`{"type":"webauthn.create","challenge":"qw"}`)).toThrow();
    expect(() => clientDataIndices(`{"type":"webauthn.get"}`)).toThrow();
  });

  it("challengeFromClientData decodes the challenge", () => {
    expect(challengeFromClientData(clientData(CHALLENGE))).toBe(CHALLENGE);
  });
});

describe("authenticatorFlags", () => {
  it("reads rpIdHash, UP, UV, BE and BS", () => {
    expect(authenticatorFlags(hexToBytes(authData({ flags: 0x1d })))).toEqual({ rpIdHash: RP_ID_HASH, up: true, uv: true, be: true, bs: true });
    expect(authenticatorFlags(hexToBytes(authData({ flags: 0x01 })))).toEqual({ rpIdHash: RP_ID_HASH, up: true, uv: false, be: false, bs: false });
    expect(() => authenticatorFlags(new Uint8Array(36))).toThrow();
  });
});

describe("verifyAssertionLocally", () => {
  const { privateKey, spki } = p256();
  const { qx, qy } = p256PublicKeyFromSpki(spki);
  const check = (auth: WebAuthnAuthJson, o: { challenge?: Hex; qx?: Hex } = {}) =>
    verifyAssertionLocally({ auth, challenge: o.challenge ?? CHALLENGE, qx: o.qx ?? qx, qy, rpIdHash: RP_ID_HASH });

  it("accepts a node:crypto-signed assertion, with the extra key too", async () => {
    await expect(check(assertion(privateKey))).resolves.toEqual({ ok: true });
    await expect(check(assertion(privateKey, { variant: "extraKey" }))).resolves.toEqual({ ok: true });
  });

  it("names each problem", async () => {
    const other = p256PublicKeyFromSpki(p256().spki);
    await expect(check(assertion(privateKey), { qx: other.qx })).resolves.toEqual({ ok: false, problem: "SIGNATURE" });
    await expect(check(assertion(privateKey), { challenge: `0x${"cd".repeat(32)}` })).resolves.toEqual({ ok: false, problem: "CHALLENGE" });
    await expect(check(assertion(privateKey, { flags: 0x04 }))).resolves.toEqual({ ok: false, problem: "USER_NOT_PRESENT" });
    await expect(check(assertion(privateKey, { flags: 0x01 }))).resolves.toEqual({ ok: false, problem: "USER_NOT_VERIFIED" });
    await expect(check(assertion(privateKey, { flags: 0x15 }))).resolves.toEqual({ ok: false, problem: "BACKUP_STATE" });
    const evil = sha256(stringToBytes("evil.example"));
    await expect(check(assertion(privateKey, { rpIdHash: evil }))).resolves.toEqual({ ok: false, problem: "RP_ID_HASH" });
    const good = assertion(privateKey);
    const highS = { ...good, s: `0x${(P256_N - BigInt(good.s)).toString(16).padStart(64, "0")}` as Hex };
    await expect(check(highS)).resolves.toEqual({ ok: false, problem: "HIGH_S" });
    await expect(check({ ...good, typeIndex: good.typeIndex + 1 })).resolves.toEqual({ ok: false, problem: "TYPE" });
    await expect(check({ ...good, challengeIndex: 10 ** 9 })).resolves.toEqual({ ok: false, problem: "CHALLENGE" });
  });
});

function spkiKey(spki: Uint8Array) {
  return { key: Buffer.from(spki), format: "der" as const, type: "spki" as const };
}

