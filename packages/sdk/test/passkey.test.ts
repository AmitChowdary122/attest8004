import { readFileSync } from "node:fs";
import { concat, hexToBytes, toHex, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  E2E_MANDATE_TERMS,
  RP_ID,
  RP_ID_HASH,
  ROTATE_PASSKEY,
  SET_INBOX_KEY,
  approvalSchema,
  approvalSelfProblems,
  base64UrlDecode,
  base64UrlEncode,
  describeMandate,
  e2eMandate,
  inboxKeyChangeHash,
  isApproveHost,
  mandateHash,
  mandateRuleProblems,
  passkeyChallenge,
  registrationProblems,
  registrationSchema,
  rotatePasskeyChangeHash,
  type Mandate,
  type PasskeyRegistration,
} from "../src/index.ts";

interface PasskeyVectors {
  rpId: string;
  rpIdHash: Hex;
  challenges: { name: string; chainId: string; registry: Address; agentId: string; changeHash: Hex; nonce: string; expected: Hex; challengeB64url: string }[];
  rotateChangeHash: { tag: Hex; qx: Hex; qy: Hex; expected: Hex };
  inboxKeyChangeHash: { tag: Hex; x25519Pub: Hex; expected: Hex };
  e2eMandate: { owner: Address; demoPassThrough: Address; allowedSelectors: Hex[]; maxValuePerTx: string; maxValuePerDay: string; validUntil: string; mandateHash: Hex };
}

const vectors = JSON.parse(readFileSync(new URL("./passkey-vectors.json", import.meta.url), "utf8")) as PasskeyVectors;
const sdkVector: unknown = JSON.parse(readFileSync(new URL("./webauthn-vector.json", import.meta.url), "utf8"));

describe("passkey-vectors.json (cast-computed, shared with forge)", () => {
  it("rpId and rpIdHash", () => {
    expect(RP_ID).toBe(vectors.rpId);
    expect(RP_ID_HASH).toBe(vectors.rpIdHash);
  });

  it("passkeyChallenge matches every vector", () => {
    expect(vectors.challenges.length).toBeGreaterThan(0);
    for (const v of vectors.challenges) {
      const challenge = passkeyChallenge({ chainId: Number(v.chainId), registry: v.registry, agentId: BigInt(v.agentId), changeHash: v.changeHash, nonce: BigInt(v.nonce) });
      expect(challenge, v.name).toBe(v.expected);
      expect(base64UrlEncode(hexToBytes(challenge)), v.name).toBe(v.challengeB64url);
      expect(v.challengeB64url).toHaveLength(43);
    }
  });

  it("the two tagged change hashes", () => {
    expect(ROTATE_PASSKEY).toBe(vectors.rotateChangeHash.tag);
    expect(SET_INBOX_KEY).toBe(vectors.inboxKeyChangeHash.tag);
    expect(rotatePasskeyChangeHash(vectors.rotateChangeHash.qx, vectors.rotateChangeHash.qy)).toBe(vectors.rotateChangeHash.expected);
    expect(inboxKeyChangeHash(vectors.inboxKeyChangeHash.x25519Pub)).toBe(vectors.inboxKeyChangeHash.expected);
  });

  it("mandateHash(e2eMandate) and the e2e terms", () => {
    const v = vectors.e2eMandate;
    expect(E2E_MANDATE_TERMS.allowedSelectors).toEqual(v.allowedSelectors);
    expect(E2E_MANDATE_TERMS.maxValuePerTx.toString()).toBe(v.maxValuePerTx);
    expect(E2E_MANDATE_TERMS.maxValuePerDay.toString()).toBe(v.maxValuePerDay);
    expect(E2E_MANDATE_TERMS.validUntil.toString()).toBe(v.validUntil);
    expect(mandateHash(e2eMandate({ owner: v.owner, demoPassThrough: v.demoPassThrough }))).toBe(v.mandateHash);
  });
});

describe("approvalSchema", () => {
  const valid = approvalSchema.parse(sdkVector);

  it("parses the committed SDK vector, and its own hashes and assertion check out", async () => {
    await expect(approvalSelfProblems(valid)).resolves.toEqual([]);
  });

  it("rejects unknown keys, non-decimal uints and a kind other than setMandate", () => {
    const raw = sdkVector as Record<string, unknown>;
    expect(approvalSchema.safeParse({ ...raw, extra: 1 }).success).toBe(false);
    expect(approvalSchema.safeParse({ ...raw, nonce: "0x01" }).success).toBe(false);
    expect(approvalSchema.safeParse({ ...raw, nonce: "01" }).success).toBe(false);
    expect(approvalSchema.safeParse({ ...raw, change: { ...(raw.change as object), kind: "setInboxKey" } }).success).toBe(false);
    expect(approvalSchema.safeParse({ ...raw, auth: { ...(raw.auth as object), extra: true } }).success).toBe(false);
  });

  it("approvalSelfProblems names a changed mandate, nonce and signature", async () => {
    const mandate = { ...valid.change.mandate, maxValuePerDay: "6000000000000000" };
    expect(await approvalSelfProblems({ ...valid, change: { kind: "setMandate", mandate } })).toEqual(expect.arrayContaining(["CHANGE_HASH_MISMATCH"]));
    expect(await approvalSelfProblems({ ...valid, nonce: "1" })).toEqual(expect.arrayContaining(["CHALLENGE_MISMATCH"]));
    const r = `0x${(BigInt(valid.auth.r) ^ 1n).toString(16).padStart(64, "0")}` as Hex;
    expect(await approvalSelfProblems({ ...valid, auth: { ...valid.auth, r } })).toEqual(["SIGNATURE"]);
  });
});

/**
 * Creation authenticator data as an authenticator writes it: rpIdHash, flags, a zero sign count, then the attested
 * credential data (AAGUID, the credential id's length and bytes, and the COSE EC2 P-256 key with x and y).
 */
function creationAuthData(o: { flags: number; credentialId: Uint8Array; qx: Hex; qy: Hex; rpIdHash?: Hex }): Hex {
  const cose = concat(["0xa5010203262001215820", o.qx, "0x225820", o.qy]);
  const length = toHex(o.credentialId.length, { size: 2 });
  return concat([o.rpIdHash ?? RP_ID_HASH, toHex(o.flags, { size: 1 }), "0x00000000", `0x${"00".repeat(16)}`, length, toHex(o.credentialId), cose]);
}

/** k·G for small k, as known P-256 points (2G), to have a valid key other than the vector's. */
function p256Point(k: 2n): { qx: Hex; qy: Hex } {
  void k;
  return {
    qx: "0x7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978",
    qy: "0x07775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1",
  };
}

describe("registration", () => {
  const qx = (sdkVector as { passkey: { qx: Hex } }).passkey.qx;
  const qy = (sdkVector as { passkey: { qy: Hex } }).passkey.qy;
  const credentialId = base64UrlDecode("c2RrLXZlY3Rvcg");
  const base: PasskeyRegistration = registrationSchema.parse({
    schema: "attest8004.passkey.v1",
    rpId: RP_ID,
    credentialId: "c2RrLXZlY3Rvcg",
    transports: ["internal", "hybrid"],
    alg: -7,
    qx,
    qy,
    authenticatorData: creationAuthData({ flags: 0x5d, credentialId, qx, qy }),
    prfEnabled: true,
  });

  it("a usable registration has no problems", () => {
    expect(registrationProblems(base)).toEqual([]);
  });

  it("names rpId, alg, PRF, flags, rpIdHash and an off-curve key", () => {
    expect(registrationProblems({ ...base, rpId: "localhost" })).toEqual(["RP_ID"]);
    expect(registrationProblems({ ...base, alg: -257 })).toEqual(["ALG"]);
    expect(registrationProblems({ ...base, prfEnabled: false })).toEqual(["PRF_NOT_ENABLED"]);
    expect(registrationProblems({ ...base, authenticatorData: creationAuthData({ flags: 0x59, credentialId, qx, qy }) })).toEqual(["USER_NOT_VERIFIED"]);
    const otherSite = creationAuthData({ flags: 0x5d, credentialId, qx, qy, rpIdHash: `0x${"00".repeat(32)}` });
    expect(registrationProblems({ ...base, authenticatorData: otherSite })).toEqual(["RP_ID_HASH"]);
    const offCurveQy = `0x${(BigInt(base.qy) ^ 1n).toString(16).padStart(64, "0")}` as Hex;
    // Off the curve, and so also not the attested key.
    expect(registrationProblems({ ...base, qy: offCurveQy })).toEqual(["CREDENTIAL_DATA", "KEY_NOT_ON_CURVE"]);
  });

  it("the key and credential id must be the ones attested in the creation's authenticator data", () => {
    const otherKey = p256Point(2n);
    expect(registrationProblems({ ...base, qx: otherKey.qx, qy: otherKey.qy })).toEqual(["CREDENTIAL_DATA"]);
    expect(registrationProblems({ ...base, credentialId: "b3RoZXItaWQ" })).toEqual(["CREDENTIAL_DATA"]);
    // No attested credential data at all (the AT flag clear).
    expect(registrationProblems({ ...base, authenticatorData: `${RP_ID_HASH}1d00000000` })).toEqual(["CREDENTIAL_DATA"]);
    // Truncated attested data.
    expect(registrationProblems({ ...base, authenticatorData: base.authenticatorData.slice(0, 2 + 2 * 60) as Hex })).toEqual(["CREDENTIAL_DATA"]);
  });

  it("the schema rejects unknown keys", () => {
    expect(registrationSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe("describeMandate", () => {
  const owner = "0x3EFEB3Cf2FB54A7D99abE90AaB786cE5A831a8CF";
  const passThrough = "0xEEEBBa55620afC42E9c88b5d962476367b8da338";

  it("the e2e mandate in plain words", () => {
    const lines = describeMandate(e2eMandate({ owner, demoPassThrough: passThrough }), { [owner]: "agent owner", [passThrough]: "DemoPassThrough" });
    expect(lines).toEqual([
      "At most 0.002 MON per transaction and 0.005 MON per day (native MON only).",
      `May send to ${owner} (agent owner).`,
      `May send to ${passThrough} (DemoPassThrough).`,
      "Plain MON transfers only (empty calldata).",
      "Valid until 2026-10-31 00:00:00 UTC.",
    ]);
  });

  it("says 'only' for plain transfers only when no other selector is allowed", () => {
    const both = describeMandate({ ...e2eMandate({ owner, demoPassThrough: passThrough }), allowedSelectors: ["0x00000000", "0x12345678"] }, {});
    expect(both).toContain("Plain MON transfers (empty calldata).");
    expect(both.some((l) => l.includes("Plain MON transfers only"))).toBe(false);
  });

  it("warns that token amounts aren't capped, and names unknown selectors and empty lists", () => {
    const lines = describeMandate(
      { allowedTargets: [], allowedSelectors: ["0xa9059cbb", "0x095ea7b3", "0x23b872dd", "0x12345678"], maxValuePerTx: 0n, maxValuePerDay: 0n, validUntil: 2n ** 64n - 1n },
      {},
    );
    expect(lines).toContain("No target is allowed, so every action fails.");
    expect(lines.filter((l) => l.includes("token amounts are NOT capped"))).toHaveLength(3);
    expect(lines).toContain("Calls the function with selector 0x12345678 (not a function this page knows).");
    expect(lines.at(-1)).toMatch(/beyond any calendar date/);
    expect(describeMandate({ allowedTargets: [owner], allowedSelectors: [], maxValuePerTx: 0n, maxValuePerDay: 0n, validUntil: 1n }, {})).toContain(
      "No call is allowed, so every action fails.",
    );
  });
});

describe("isApproveHost", () => {
  it("is true only for the production rpId", () => {
    expect(isApproveHost("attest8004.vercel.app")).toBe(true);
    for (const host of ["localhost", "127.0.0.1", "attest8004-git-main-x.vercel.app", "attest8004.vercel.app.evil.com", "evil.attest8004.vercel.app", ""]) {
      expect(isApproveHost(host), host).toBe(false);
    }
  });
});

describe("mandateRuleProblems", () => {
  const owner: Address = "0x3EFEB3Cf2FB54A7D99abE90AaB786cE5A831a8CF";
  const ok: Mandate = { allowedTargets: [owner], allowedSelectors: ["0x00000000"], maxValuePerTx: 1n, maxValuePerDay: 1n, validUntil: 101n };

  it("passes the registry's passing boundary (equal caps, validUntil = now + 1)", () => {
    expect(mandateRuleProblems(ok, 100n)).toEqual([]);
  });

  it("names a zero target, an expired validUntil and a per-tx cap above the daily cap", () => {
    expect(mandateRuleProblems({ ...ok, allowedTargets: ["0x0000000000000000000000000000000000000000"] }, 100n)).toEqual(["ZERO_TARGET"]);
    expect(mandateRuleProblems({ ...ok, validUntil: 100n }, 100n)).toEqual(["EXPIRED"]);
    expect(mandateRuleProblems({ ...ok, maxValuePerTx: 2n }, 100n)).toEqual(["TX_CAP_ABOVE_DAILY_CAP"]);
  });
});
