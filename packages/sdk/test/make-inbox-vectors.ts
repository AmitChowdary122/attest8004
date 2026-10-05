// Writes packages/sdk/test/inbox-vectors.json: one sealed findings envelope (ARCHITECTURE §6), computed with
// node:crypto (OpenSSL's X25519 through KeyObject, hkdfSync, aes-256-gcm), an implementation independent of the SDK's
// noble one. viem is used only for the inputs' sha256, the AAD's abi.encode and the event topic's keccak256.
// inbox-crypto.test.ts checks that the SDK reproduces every stored value (and runs a live cross-check with the functions
// exported here), and contracts/test/InboxVectors.t.sol checks the AAD against Solidity's abi.encode and the topic
// against FindingsBoard.FindingsPosted.selector. The file holds nothing secret-shaped, so it passes the repo's stock
// gitleaks rules: secret inputs are derived from public labels at run time, and secret intermediates aren't stored.
// Every input is fixed and public, so a re-run writes the same file.
//
//   mise exec node@22 -- node packages/sdk/test/make-inbox-vectors.ts          rewrite the file
//   mise exec node@22 -- node packages/sdk/test/make-inbox-vectors.ts --check  exit 1 if any stored value differs
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  type KeyObject,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  bytesToHex,
  concat,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  sha256,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import { DEPLOYMENTS } from "../src/deployments.ts";

// The scheme's labels, written out here rather than imported, so the SDK's constants are checked against them.
const INBOX_PRF_SALT_PREIMAGE = "attest8004.inbox.v1";
const INBOX_KEY_INFO = "attest8004.inbox.x25519.v1";
const FINDINGS_AEAD_INFO = "attest8004.findings.aes256gcm.v1";
const FINDINGS_POSTED = "FindingsPosted(bytes32,uint256,address,bytes)";
/** DeployFindingsBoard.predictedAddress() at commit 17a241f, recorded as a literal: the vector stays valid whatever the board's bytecode becomes. */
const FINDINGS_BOARD: Address = "0xa7d52B3B08FAB0cd0527c6242ca678f9Feee6a1c";

// RFC 8410 DER wrappers for a raw 32-byte X25519 key: PKCS#8 for a private key, SubjectPublicKeyInfo for a public one.
const PKCS8_X25519_PREFIX = hexToBytes("0x302e020100300506032b656e04220420");
const SPKI_X25519_PREFIX = hexToBytes("0x302a300506032b656e032100");

/** The envelope's binding context, as the SDK's `EnvelopeContext`. */
export interface NodeEnvelopeContext {
  chainId: number;
  findingsBoard: Address;
  validationRegistry: Address;
  requestHash: Hex;
  agentId: bigint;
  validator: Address;
  recipient: Hex;
}

function privateKeyObject(raw: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.from(concat([PKCS8_X25519_PREFIX, raw])), format: "der", type: "pkcs8" });
}

function publicKeyObject(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.from(concat([SPKI_X25519_PREFIX, raw])), format: "der", type: "spki" });
}

function hkdf32(ikm: Uint8Array, salt: Uint8Array, info: string): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", ikm, salt, stringToBytes(info), 32));
}

/** HKDF-SHA256(prfOutput, empty salt, INBOX_KEY_INFO, 32), clamped per RFC 7748 §5. */
export function nodeInboxPrivateKey(prfOutput: Uint8Array): Uint8Array {
  const k = hkdf32(prfOutput, new Uint8Array(0), INBOX_KEY_INFO);
  k[0] = (k[0] ?? 0) & 248;
  k[31] = ((k[31] ?? 0) & 127) | 64;
  return k;
}

/** X25519(privateKey, 9). OpenSSL clamps the scalar itself, so a raw (unclamped) key works too. */
export function nodePublicKey(privateKey: Uint8Array): Uint8Array {
  const spki = createPublicKey(privateKeyObject(privateKey)).export({ format: "der", type: "spki" });
  return new Uint8Array(spki.subarray(SPKI_X25519_PREFIX.length));
}

export function nodeSharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return new Uint8Array(diffieHellman({ privateKey: privateKeyObject(privateKey), publicKey: publicKeyObject(publicKey) }));
}

/** HKDF-SHA256(sharedSecret, ephemeralPub ‖ recipientPub, FINDINGS_AEAD_INFO, 32). */
export function nodeAeadKey(sharedSecret: Uint8Array, ephemeralPublicKey: Uint8Array, recipient: Uint8Array): Uint8Array {
  return hkdf32(sharedSecret, concat([ephemeralPublicKey, recipient]), FINDINGS_AEAD_INFO);
}

/** abi.encode(uint256 chainId, address findingsBoard, address validationRegistry, bytes32 requestHash, uint256 agentId, address validator, bytes32 recipient). */
export function nodeAad(c: NodeEnvelopeContext): Uint8Array {
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
      [BigInt(c.chainId), c.findingsBoard, c.validationRegistry, c.requestHash, c.agentId, c.validator, c.recipient],
    ),
  );
}

/** 0x01 ‖ ephemeralPub (32) ‖ nonce (12) ‖ AES-256-GCM ciphertext ‖ tag (16), with every intermediate value. */
export function nodeSeal(o: {
  plaintext: Uint8Array;
  context: NodeEnvelopeContext;
  ephemeralPrivateKey: Uint8Array;
  nonce: Uint8Array;
}): { ephemeralPublicKey: Uint8Array; sharedSecret: Uint8Array; aeadKey: Uint8Array; aad: Uint8Array; envelope: Uint8Array } {
  const recipient = hexToBytes(o.context.recipient);
  const ephemeralPublicKey = nodePublicKey(o.ephemeralPrivateKey);
  const sharedSecret = nodeSharedSecret(o.ephemeralPrivateKey, recipient);
  const aeadKey = nodeAeadKey(sharedSecret, ephemeralPublicKey, recipient);
  const aad = nodeAad(o.context);
  const cipher = createCipheriv("aes-256-gcm", aeadKey, o.nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(o.plaintext), cipher.final(), cipher.getAuthTag()]);
  const envelope = concat([Uint8Array.of(1), ephemeralPublicKey, o.nonce, new Uint8Array(ciphertext)]);
  return { ephemeralPublicKey, sharedSecret, aeadKey, aad, envelope };
}

/** Opens an envelope sealed to `privateKey`'s public key; throws if it doesn't authenticate. */
export function nodeOpen(o: { envelope: Uint8Array; privateKey: Uint8Array; context: NodeEnvelopeContext }): Uint8Array {
  const { envelope } = o;
  if (envelope[0] !== 1) throw new Error("unknown envelope version");
  const ephemeralPublicKey = envelope.subarray(1, 33);
  const nonce = envelope.subarray(33, 45);
  const ciphertext = envelope.subarray(45, envelope.length - 16);
  const tag = envelope.subarray(envelope.length - 16);
  const sharedSecret = nodeSharedSecret(o.privateKey, ephemeralPublicKey);
  const aeadKey = nodeAeadKey(sharedSecret, ephemeralPublicKey, nodePublicKey(o.privateKey));
  const decipher = createDecipheriv("aes-256-gcm", aeadKey, nonce, { authTagLength: 16 });
  decipher.setAAD(nodeAad(o.context));
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

/** The ephemeral key's label: the key is `sha256(label)`, computed at run time by this script and by the tests. */
const EPHEMERAL_SEED_LABEL = "attest8004.test.ephemeral";

/**
 * The vector file's contents. Integers are decimal strings, as in vectors.json. Nothing secret-shaped is stored: the
 * secret inputs are derived from public labels at run time, and the intermediates (the inbox private key, the shared
 * secret, the AEAD key) are left out; the envelope, byte for byte, depends on every one of them.
 */
function buildVectors(): Record<string, unknown> {
  const fixed = (label: string) => hexToBytes(sha256(stringToBytes(label)));
  const prfOutput = fixed("attest8004.test.inbox-prf");
  const nonce = fixed("attest8004.test.nonce").slice(0, 12);
  const plaintext = "attest8004 inbox test vector: agent 1984's action scored 0 — target outside its mandate.";

  const inboxPublicKey = bytesToHex(nodePublicKey(nodeInboxPrivateKey(prfOutput)));
  const deployment = DEPLOYMENTS[10143];
  const context: NodeEnvelopeContext = {
    chainId: 10143,
    findingsBoard: FINDINGS_BOARD,
    validationRegistry: deployment.validationRegistry,
    requestHash: sha256(stringToBytes("attest8004.test.request")),
    agentId: 1984n,
    validator: deployment.validators.mandateV1,
    recipient: inboxPublicKey,
  };
  const sealed = nodeSeal({
    plaintext: stringToBytes(plaintext),
    context,
    ephemeralPrivateKey: fixed(EPHEMERAL_SEED_LABEL),
    nonce,
  });

  return {
    schema: "attest8004.inbox-vectors.v1",
    description:
      "One sealed findings envelope (ARCHITECTURE §6), computed with node:crypto by packages/sdk/test/make-inbox-vectors.ts, independent of the SDK's noble implementation. The secret inputs are derived from public labels at run time (the ephemeral key is sha256(ephemeralSeedLabel)), and the secret intermediates (the inbox private key, the shared secret, the AEAD key) aren't stored: the envelope, byte for byte, depends on each of them. Checked by packages/sdk/test/inbox-crypto.test.ts (noble) and contracts/test/InboxVectors.t.sol (the AAD against abi.encode, the topic against FindingsPosted.selector). Integers are decimal strings.",
    formulas: {
      inputs:
        'prfOutput = sha256("attest8004.test.inbox-prf"); the ephemeral private key = sha256(ephemeralSeedLabel), derived at run time; nonce = the first 12 bytes of sha256("attest8004.test.nonce"); requestHash = sha256("attest8004.test.request"); plaintext is UTF-8',
      inboxPrfSalt: `sha256("${INBOX_PRF_SALT_PREIMAGE}")`,
      inboxPublicKey:
        "X25519(k, 9), where k = HKDF-SHA256(ikm = prfOutput, salt = empty, info = inboxKeyInfo, L = 32), clamped: k[0] &= 248; k[31] &= 127; k[31] |= 64 (not stored)",
      ephemeralPublicKey: "X25519(sha256(ephemeralSeedLabel), 9)",
      aad: "abi.encode(uint256 chainId, address findingsBoard, address validationRegistry, bytes32 requestHash, uint256 agentId, address validator, bytes32 recipient)",
      envelope:
        "0x01 ‖ ephemeralPublicKey (32) ‖ nonce (12) ‖ AES-256-GCM(key, nonce, aad, plaintext) ‖ tag (16), where key = HKDF-SHA256(ikm = X25519(ephemeral, recipient), salt = ephemeralPublicKey ‖ recipient, info = findingsAeadInfo, L = 32) (not stored)",
      findingsPostedTopic: `keccak256("${FINDINGS_POSTED}")`,
    },
    inboxPrfSalt: sha256(stringToBytes(INBOX_PRF_SALT_PREIMAGE)),
    inboxKeyInfo: INBOX_KEY_INFO,
    findingsAeadInfo: FINDINGS_AEAD_INFO,
    prfOutput: bytesToHex(prfOutput),
    ephemeralSeedLabel: EPHEMERAL_SEED_LABEL,
    nonce: bytesToHex(nonce),
    plaintext,
    context: {
      chainId: String(context.chainId),
      findingsBoard: context.findingsBoard,
      validationRegistry: context.validationRegistry,
      requestHash: context.requestHash,
      agentId: String(context.agentId),
      validator: context.validator,
      recipient: context.recipient,
    },
    inboxPublicKey,
    ephemeralPublicKey: bytesToHex(sealed.ephemeralPublicKey),
    aad: bytesToHex(sealed.aad),
    envelope: bytesToHex(sealed.envelope),
    findingsPostedTopic: keccak256(stringToBytes(FINDINGS_POSTED)),
  };
}

if (import.meta.main) {
  const out = new URL("./inbox-vectors.json", import.meta.url);
  const text = `${JSON.stringify(buildVectors(), null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const stored = readFileSync(out, "utf8");
    if (stored !== text) {
      const want = JSON.parse(text) as Record<string, unknown>;
      const have = JSON.parse(stored) as Record<string, unknown>;
      const keys = Object.keys(want).filter((k) => JSON.stringify(want[k]) !== JSON.stringify(have[k]));
      console.error(`inbox-vectors.json differs from node:crypto's values: ${keys.join(", ") || "formatting"}`);
      process.exit(1);
    }
    console.log("inbox-vectors.json matches node:crypto's values");
  } else {
    writeFileSync(out, text);
    console.log(`wrote ${out.pathname}`);
  }
}
