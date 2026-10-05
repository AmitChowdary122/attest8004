import { hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { bytesToHex, hexToBytes, sha256, stringToBytes, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  DEPLOYMENTS,
  ENVELOPE_OVERHEAD_BYTES,
  ENVELOPE_VERSION,
  FINDINGS_AEAD_INFO,
  INBOX_KEY_INFO,
  INBOX_PRF_SALT,
  LowOrderKeyError,
  MAX_ENVELOPE_BYTES,
  MAX_REPORT_PLAINTEXT_BYTES,
  PlaintextTooLargeError,
  deriveInboxPrivateKey,
  envelopeAad,
  inboxPublicKeyFromPrf,
  openEnvelope,
  sealEnvelope,
  withInboxKey,
  x25519PublicKey,
  type EnvelopeContext,
} from "../src/index.ts";
import { expectAllZero, recordingTracker } from "./helpers/secrets.ts";
import { nodeInboxPrivateKey, nodeOpen, nodePublicKey, nodeSeal } from "./make-inbox-vectors.ts";

// inbox-vectors.json comes from node:crypto (make-inbox-vectors.ts), independent of the SDK's noble implementation;
// contracts/test/InboxVectors.t.sol checks its AAD against Solidity's abi.encode. It stores nothing secret-shaped: the
// ephemeral key is sha256(ephemeralSeedLabel), derived here at run time, and the secret intermediates aren't stored
// (the envelope, byte for byte, depends on each of them).
interface InboxVectors {
  inboxPrfSalt: Hex;
  inboxKeyInfo: string;
  findingsAeadInfo: string;
  prfOutput: Hex;
  ephemeralSeedLabel: string;
  nonce: Hex;
  plaintext: string;
  context: {
    chainId: string;
    findingsBoard: Address;
    validationRegistry: Address;
    requestHash: Hex;
    agentId: string;
    validator: Address;
    recipient: Hex;
  };
  inboxPublicKey: Hex;
  ephemeralPublicKey: Hex;
  aad: Hex;
  envelope: Hex;
}

const vector = JSON.parse(readFileSync(new URL("./inbox-vectors.json", import.meta.url), "utf8")) as InboxVectors;
const vectorContext: EnvelopeContext = {
  ...vector.context,
  chainId: Number(vector.context.chainId),
  agentId: BigInt(vector.context.agentId),
};

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** A fresh inbox key pair, from a random PRF output. */
function inbox(): { privateKey: Uint8Array; publicKey: Hex } {
  const privateKey = deriveInboxPrivateKey(random(32));
  return { privateKey, publicKey: x25519PublicKey(privateKey) };
}

/** The vector's context, addressed to `recipient`. */
function contextFor(recipient: Hex, change: Partial<EnvelopeContext> = {}): EnvelopeContext {
  return { ...vectorContext, recipient, ...change };
}

/** The 32-byte u-coordinate 1 (little-endian): a point of order 4, so X25519 with any clamped scalar gives zero. */
const U_ONE: Hex = `0x01${"00".repeat(31)}`;
const U_ZERO: Hex = `0x${"00".repeat(32)}`;

describe("inbox crypto: the node:crypto vectors", () => {
  it('INBOX_PRF_SALT is sha256("attest8004.inbox.v1")', () => {
    expect(INBOX_PRF_SALT).toBe(sha256(stringToBytes("attest8004.inbox.v1")));
    expect(INBOX_PRF_SALT).toBe(vector.inboxPrfSalt);
  });

  it("the labels and sizes match the vector and the board", () => {
    expect(INBOX_KEY_INFO).toBe(vector.inboxKeyInfo);
    expect(FINDINGS_AEAD_INFO).toBe(vector.findingsAeadInfo);
    expect(ENVELOPE_VERSION).toBe(1);
    expect(ENVELOPE_OVERHEAD_BYTES).toBe(1 + 32 + 12 + 16);
    expect(MAX_ENVELOPE_BYTES).toBe(8192);
    expect(MAX_REPORT_PLAINTEXT_BYTES).toBe(MAX_ENVELOPE_BYTES - ENVELOPE_OVERHEAD_BYTES);
  });

  it("derives the vector key", () => {
    const privateKey = deriveInboxPrivateKey(hexToBytes(vector.prfOutput));
    expect(x25519PublicKey(privateKey)).toBe(vector.inboxPublicKey);
    expect(vector.context.recipient).toBe(vector.inboxPublicKey);

    // The private key's bytes: node:crypto's HKDF of the same input, clamped here (RFC 7748).
    const expected = new Uint8Array(hkdfSync("sha256", hexToBytes(vector.prfOutput), new Uint8Array(0), stringToBytes(vector.inboxKeyInfo), 32));
    expected[0] = (expected[0] ?? 0) & 248;
    expected[31] = ((expected[31] ?? 0) & 127) | 64;
    expect(privateKey).toEqual(expected);
    // The clamp bits: the low 3 bits clear, the top bit clear, bit 254 set.
    expect((privateKey[0] ?? 0xff) & 7).toBe(0);
    expect((privateKey[31] ?? 0xff) & 0x80).toBe(0);
    expect((privateKey[31] ?? 0) & 0x40).toBe(0x40);
  });

  it("seals the vector envelope byte for byte", () => {
    // Byte equality covers what the vector doesn't store: the shared secret and the AEAD key.
    const envelope = sealEnvelope({
      plaintext: stringToBytes(vector.plaintext),
      context: vectorContext,
      ephemeralPrivateKey: hexToBytes(sha256(stringToBytes(vector.ephemeralSeedLabel))),
      nonce: hexToBytes(vector.nonce),
    });
    expect(envelope).toBe(vector.envelope);
    expect(bytesToHex(hexToBytes(envelope).subarray(1, 33))).toBe(vector.ephemeralPublicKey);

    const opened = openEnvelope({
      envelope: vector.envelope,
      privateKey: deriveInboxPrivateKey(hexToBytes(vector.prfOutput)),
      context: vectorContext,
    });
    expect(opened).toEqual({ ok: true, plaintext: stringToBytes(vector.plaintext) });
  });

  it("envelopeAad equals the vector's 224 bytes", () => {
    const aad = envelopeAad(vectorContext);
    expect(aad.length).toBe(224);
    expect(bytesToHex(aad)).toBe(vector.aad);
  });

  it("node:crypto opens noble's envelope and noble opens node's", () => {
    const prf = random(32);
    const privateKey = deriveInboxPrivateKey(prf);
    expect(privateKey).toEqual(nodeInboxPrivateKey(prf));
    const recipient = x25519PublicKey(privateKey);
    expect(recipient).toBe(bytesToHex(nodePublicKey(privateKey)));
    const context = contextFor(recipient);
    const plaintext = random(500);

    const fromNoble = sealEnvelope({ plaintext, context });
    expect(nodeOpen({ envelope: hexToBytes(fromNoble), privateKey, context })).toEqual(plaintext);

    const fromNode = nodeSeal({ plaintext, context, ephemeralPrivateKey: random(32), nonce: random(12) });
    expect(openEnvelope({ envelope: bytesToHex(fromNode.envelope), privateKey, context })).toEqual({ ok: true, plaintext });
  });
});

describe("inbox crypto: round trips", () => {
  it.each([0, 1, 1_000, 8_131])("round trip (%i bytes)", (size) => {
    const key = inbox();
    const context = contextFor(key.publicKey);
    const plaintext = random(size);
    const envelope = sealEnvelope({ plaintext, context });
    expect(hexToBytes(envelope).length).toBe(size + ENVELOPE_OVERHEAD_BYTES);
    expect(openEnvelope({ envelope, privateKey: key.privateKey, context })).toEqual({ ok: true, plaintext });
  });

  it("8,132 bytes throws PlaintextTooLargeError", () => {
    const key = inbox();
    let error: unknown;
    try {
      sealEnvelope({ plaintext: random(8_132), context: contextFor(key.publicKey) });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(PlaintextTooLargeError);
    expect((error as PlaintextTooLargeError).bytes).toBe(8_132);
  });

  it("two seals of the same plaintext differ and both open", () => {
    const key = inbox();
    const context = contextFor(key.publicKey);
    const plaintext = stringToBytes("same report");
    const a = sealEnvelope({ plaintext, context });
    const b = sealEnvelope({ plaintext, context });
    expect(a).not.toBe(b);
    // A fresh ephemeral key and a fresh nonce each time.
    expect(a.slice(4, 68)).not.toBe(b.slice(4, 68));
    expect(a.slice(68, 92)).not.toBe(b.slice(68, 92));
    for (const envelope of [a, b]) {
      expect(openEnvelope({ envelope, privateKey: key.privateKey, context })).toEqual({ ok: true, plaintext });
    }
  });
});

describe("inbox crypto: failures", () => {
  it("wrong key fails", () => {
    const key = inbox();
    const other = inbox();
    const envelope = sealEnvelope({ plaintext: stringToBytes("for key only"), context: contextFor(key.publicKey) });
    expect(openEnvelope({ envelope, privateKey: other.privateKey, context: contextFor(other.publicKey) })).toEqual({
      ok: false,
      problem: "DECRYPT_FAILED",
    });
    expect(openEnvelope({ envelope, privateKey: other.privateKey, context: contextFor(key.publicKey) })).toEqual({
      ok: false,
      problem: "RECIPIENT_MISMATCH",
    });
  });

  it("one flipped bit fails", () => {
    const key = inbox();
    const context = contextFor(key.publicKey);
    const bytes = hexToBytes(sealEnvelope({ plaintext: Uint8Array.of(0x2a), context }));
    expect(bytes.length).toBe(62);
    const wrong: string[] = [];
    let flips = 0;
    for (let bit = 0; bit < bytes.length * 8; bit++) {
      const flipped = bytes.slice();
      flipped[bit >> 3] = (flipped[bit >> 3] ?? 0) ^ (1 << (bit & 7));
      const result = openEnvelope({ envelope: bytesToHex(flipped), privateKey: key.privateKey, context });
      const expected = bit < 8 ? "VERSION" : "DECRYPT_FAILED";
      if (result.ok || result.problem !== expected) wrong.push(`bit ${bit}: ${result.ok ? "opened" : result.problem}`);
      flips++;
    }
    expect(flips).toBe(496);
    expect(wrong).toEqual([]);
  });

  it("AAD swap fails: R's ciphertext presented as S's", () => {
    const key = inbox();
    const r = contextFor(key.publicKey);
    const envelope = sealEnvelope({ plaintext: stringToBytes("findings for request R"), context: r });
    expect(openEnvelope({ envelope, privateKey: key.privateKey, context: r }).ok).toBe(true);

    const s = { ...r, requestHash: sha256(stringToBytes("attest8004.test.request.S")) };
    expect(openEnvelope({ envelope, privateKey: key.privateKey, context: s })).toEqual({ ok: false, problem: "DECRYPT_FAILED" });

    const other = inbox();
    const changes: [string, Partial<EnvelopeContext>, Uint8Array][] = [
      ["chainId", { chainId: 143 }, key.privateKey],
      ["findingsBoard", { findingsBoard: "0x000000000000000000000000000000000000dEaD" }, key.privateKey],
      ["validationRegistry", { validationRegistry: DEPLOYMENTS[10143].agentRequestForwarder }, key.privateKey],
      ["agentId", { agentId: 1985n }, key.privateKey],
      ["validator", { validator: DEPLOYMENTS[10143].validators.riskV1 }, key.privateKey],
      // The recipient can only change together with the key that opens it (otherwise RECIPIENT_MISMATCH comes first).
      ["recipient", { recipient: other.publicKey }, other.privateKey],
    ];
    for (const [field, change, privateKey] of changes) {
      const result = openEnvelope({ envelope, privateKey, context: { ...r, ...change } });
      expect(result, field).toEqual({ ok: false, problem: "DECRYPT_FAILED" });
    }
  });

  it("malformed", () => {
    const key = inbox();
    const context = contextFor(key.publicKey);
    const open = (envelope: string) => openEnvelope({ envelope: envelope as Hex, privateKey: key.privateKey, context });
    const malformed = { ok: false, problem: "MALFORMED" };
    expect(open(`0x01${"00".repeat(59)}`)).toEqual(malformed); // 60 bytes
    expect(open(`0x01${"00".repeat(8_192)}`)).toEqual(malformed); // 8,193 bytes
    expect(open("0x")).toEqual(malformed);
    // Hostile text never throws either.
    expect(open(`0x01${"00".repeat(60)}0`)).toEqual(malformed); // an odd number of hex digits
    expect(open(`0x01${"zz".repeat(60)}`)).toEqual(malformed);
    expect(open(`01${"00".repeat(61)}`)).toEqual(malformed);
    expect(open("")).toEqual(malformed);
  });

  it("low-order recipient", () => {
    for (const recipient of [U_ZERO, U_ONE]) {
      expect(() => sealEnvelope({ plaintext: stringToBytes("x"), context: contextFor(recipient) }), recipient).toThrow(
        LowOrderKeyError,
      );
    }
    const key = inbox();
    const context = contextFor(key.publicKey);
    for (const ephemeral of [U_ZERO, U_ONE]) {
      const envelope = bytesToHex(new Uint8Array([1, ...hexToBytes(ephemeral), ...random(12), ...random(17)]));
      expect(openEnvelope({ envelope, privateKey: key.privateKey, context }), ephemeral).toEqual({
        ok: false,
        problem: "LOW_ORDER_KEY",
      });
    }
  });
});

describe("inbox crypto: zeroing", () => {
  it("inboxPublicKeyFromPrf zeroes the PRF output and the private key", () => {
    const prf = random(32);
    const expected = x25519PublicKey(deriveInboxPrivateKey(prf.slice()));
    const tracker = recordingTracker();
    expect(inboxPublicKeyFromPrf(prf, tracker)).toBe(expected);
    expect(tracker.buffers.length).toBeGreaterThanOrEqual(2);
    expectAllZero([prf, ...tracker.buffers]);

    // A PRF output of the wrong size is refused, and zeroed all the same.
    const short = random(31);
    expect(() => inboxPublicKeyFromPrf(short)).toThrow();
    expectAllZero([short]);
  });

  it("withInboxKey zeroes after use, and after a throw", async () => {
    const prf = random(32);
    const expected = deriveInboxPrivateKey(prf.slice());
    const tracker = recordingTracker();
    let captured: Uint8Array | undefined;
    const publicKey = await withInboxKey(
      prf,
      async ({ privateKey, publicKey }) => {
        captured = privateKey;
        await new Promise((resolve) => setTimeout(resolve, 1));
        // Still intact while `use` runs, across an await.
        expect(privateKey).toEqual(expected);
        return publicKey;
      },
      tracker,
    );
    expect(publicKey).toBe(x25519PublicKey(expected));
    expect(captured).toBeDefined();
    expect(tracker.buffers.length).toBeGreaterThanOrEqual(2);
    expectAllZero([prf, captured ?? Uint8Array.of(1), ...tracker.buffers]);

    const prf2 = random(32);
    let captured2: Uint8Array | undefined;
    await expect(
      withInboxKey(prf2, ({ privateKey }) => {
        captured2 = privateKey;
        throw new Error("use failed");
      }),
    ).rejects.toThrow("use failed");
    expect(captured2).toBeDefined();
    expectAllZero([prf2, captured2 ?? Uint8Array.of(1)]);
  });

  it("seal zeroes the ephemeral key, the shared secret and the AEAD key", () => {
    const key = inbox();
    const context = contextFor(key.publicKey);
    const tracker = recordingTracker();
    sealEnvelope({ plaintext: stringToBytes("report"), context, tracker });
    expect(tracker.buffers.length).toBeGreaterThanOrEqual(3);
    expectAllZero(tracker.buffers);

    // A passed ephemeral key is zeroed too, also when the seal throws.
    const passed = [random(32), random(32), random(32)];
    sealEnvelope({ plaintext: stringToBytes("report"), context, ephemeralPrivateKey: passed[0] });
    expect(() => sealEnvelope({ plaintext: random(8_132), context, ephemeralPrivateKey: passed[1] })).toThrow(
      PlaintextTooLargeError,
    );
    const tracker2 = recordingTracker();
    expect(() =>
      sealEnvelope({ plaintext: stringToBytes("x"), context: contextFor(U_ONE), ephemeralPrivateKey: passed[2], tracker: tracker2 }),
    ).toThrow(LowOrderKeyError);
    expectAllZero([...passed, ...tracker2.buffers]);
  });

  it("open zeroes the shared secret and the AEAD key, on success and on DECRYPT_FAILED", () => {
    const key = inbox();
    const context = contextFor(key.publicKey);
    const envelope = sealEnvelope({ plaintext: stringToBytes("report"), context });

    const opened = recordingTracker();
    expect(openEnvelope({ envelope, privateKey: key.privateKey, context, tracker: opened }).ok).toBe(true);
    expect(opened.buffers.length).toBeGreaterThanOrEqual(2);
    expectAllZero(opened.buffers);

    const bytes = hexToBytes(envelope);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    const failed = recordingTracker();
    expect(openEnvelope({ envelope: bytesToHex(bytes), privateKey: key.privateKey, context, tracker: failed })).toEqual({
      ok: false,
      problem: "DECRYPT_FAILED",
    });
    expect(failed.buffers.length).toBeGreaterThanOrEqual(2);
    expectAllZero(failed.buffers);
  });
});
