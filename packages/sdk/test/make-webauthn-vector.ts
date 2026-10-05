// Writes attest8004.approval.v1 documents signed the way Chrome signs a WebAuthn assertion (authenticatorData ‖
// sha256(clientDataJSON), DER ECDSA over P-256) with a fixed test key, then parsed with the SDK's own WebAuthn helpers:
// - packages/sdk/test/webauthn-vector.json, the e2e mandate at nonce 0 (`mandate`);
// - packages/sdk/test/webauthn-inbox-vector.json, a setInboxKey change at nonce 1, after it (`inbox`, P7).
// contracts/test/PasskeyVectors.t.sol replays them through MandateRegistry v2, in that order, so the TypeScript parsing
// and the Solidity verification are checked against each other. ECDSA signing is randomized, so a re-run writes a
// different (equally valid) signature: write each once, commit the output.
//
//   mise exec node@22 -- node packages/sdk/test/make-webauthn-vector.ts [mandate|inbox|all]   (default: all)
import { createECDH, createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { bytesToHex, concat, hexToBytes, sha256, stringToBytes, type Address, type Hex } from "viem";
import {
  RP_ID_HASH,
  approvalSelfProblems,
  base64UrlEncode,
  buildApproval,
  changeHashOf,
  clientDataIndices,
  e2eMandate,
  passkeyChallenge,
  signatureFromDer,
  type ApprovalChange,
} from "../src/index.ts";

interface Vectors {
  challenges: { registry: Address }[];
  e2eMandate: { owner: Address; demoPassThrough: Address };
}

const vectors = JSON.parse(readFileSync(new URL("./passkey-vectors.json", import.meta.url), "utf8")) as Vectors;
const registry = vectors.challenges[0]?.registry;
if (!registry) throw new Error("passkey-vectors.json has no challenge vector");

// A fixed, public test key: d = sha256("attest8004.webauthn-vector.v1"). Never a real passkey.
const d = hexToBytes(sha256(stringToBytes("attest8004.webauthn-vector.v1")));
const ecdh = createECDH("prime256v1");
ecdh.setPrivateKey(d);
const point = new Uint8Array(ecdh.getPublicKey());
const x = point.slice(1, 33);
const y = point.slice(33, 65);
const key = createPrivateKey({
  key: { kty: "EC", crv: "P-256", d: base64UrlEncode(d), x: base64UrlEncode(x), y: base64UrlEncode(y) },
  format: "jwk",
});

const chainId = 10143;
const agentId = 1984n;

/** Signs `change` at `nonce` with the fixed test key and writes the approval to `file`, after its own checks. */
async function writeVector(change: ApprovalChange, nonce: bigint, file: string): Promise<void> {
  const at = registry as Address;
  const challenge = passkeyChallenge({ chainId, registry: at, agentId, changeHash: changeHashOf(change), nonce });

  // Chrome's shape, including the key it sometimes appends, so the indices are found by search.
  const clientDataJSON =
    `{"type":"webauthn.get","challenge":"${base64UrlEncode(hexToBytes(challenge))}","origin":"https://attest8004.vercel.app",` +
    `"crossOrigin":false,"other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See https://goo.gl/yabPex"}`;
  // UP | UV | BE | BS, as a synced Google Password Manager passkey sets them; sign count 0.
  const authenticatorData: Hex = concat([RP_ID_HASH, "0x1d", "0x00000000"]);
  const der = sign("sha256", hexToBytes(concat([authenticatorData, sha256(stringToBytes(clientDataJSON))])), key);

  const approval = buildApproval({
    chainId,
    registry: at,
    agentId,
    change,
    nonce,
    passkey: { credentialId: base64UrlEncode(stringToBytes("sdk-webauthn-vector")), qx: bytesToHex(x), qy: bytesToHex(y) },
    auth: { ...signatureFromDer(new Uint8Array(der)), ...clientDataIndices(clientDataJSON), authenticatorData, clientDataJSON },
  });

  const problems = await approvalSelfProblems(approval);
  if (problems.length > 0) throw new Error(`the generated vector fails its own checks: ${problems.join(", ")}`);

  const out = new URL(file, import.meta.url);
  writeFileSync(out, `${JSON.stringify(approval, null, 2)}\n`);
  console.log(`wrote ${out.pathname}`);
}

const which = process.argv[2] ?? "all";
if (!["mandate", "inbox", "all"].includes(which)) throw new Error(`usage: make-webauthn-vector.ts [mandate|inbox|all], got "${which}"`);
if (which !== "inbox") await writeVector({ kind: "setMandate", mandate: e2eMandate(vectors.e2eMandate) }, 0n, "./webauthn-vector.json");
// The inbox key is the inbox vectors' derived public key (packages/sdk/test/inbox-vectors.json).
const inboxVectors = JSON.parse(readFileSync(new URL("./inbox-vectors.json", import.meta.url), "utf8")) as { inboxPublicKey: Hex };
if (which !== "mandate") await writeVector({ kind: "setInboxKey", x25519Pub: inboxVectors.inboxPublicKey }, 1n, "./webauthn-inbox-vector.json");
