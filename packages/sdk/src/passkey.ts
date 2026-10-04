// Passkey approvals for MandateRegistry v2 (SPEC §4.2, ARCHITECTURE §6): the rpId, the challenge and change hashes
// exactly as the contract computes them, the two file formats (registration and approval), and the checks the
// /approve page and the scripts both run. Browser-safe: viem and zod only.
import {
  bytesToHex,
  encodeAbiParameters,
  formatEther,
  getAddress,
  hexToBytes,
  keccak256,
  sha256,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import { zAddress, zBytes32, zDecimal, zHexBytes } from "./request.ts";
import {
  attestedCredential,
  authenticatorFlags,
  base64UrlDecode,
  isOnP256,
  verifyAssertionLocally,
  type AssertionProblem,
  type WebAuthnAuthJson,
} from "./webauthn.ts";

/** The WebAuthn relying party: passkeys are bound to this domain, and MandateRegistry v2 checks its hash. */
export const RP_ID = "attest8004.vercel.app";
/** `sha256(RP_ID)`, the first 32 bytes of every valid assertion's authenticator data (v2's immutable `rpIdHash`). */
export const RP_ID_HASH: Hex = sha256(stringToBytes(RP_ID));

/** `ROTATE_PASSKEY` and `SET_INBOX_KEY` in MandateRegistry v2: the tags that separate the change hashes. */
export const ROTATE_PASSKEY: Hex = keccak256(stringToBytes("attest8004.MandateRegistry.rotatePasskey"));
export const SET_INBOX_KEY: Hex = keccak256(stringToBytes("attest8004.MandateRegistry.setInboxKey"));

/**
 * The PRF salt of the /approve page's Mera check only, never P7's inbox salt: the page shows a fingerprint of this
 * salt's output so two devices can be compared, which reveals nothing about the output for any other salt.
 */
export const PRF_CHECK_SALT: Hex = sha256(stringToBytes("attest8004.prf-check.v1"));

export const REGISTRATION_SCHEMA_V1 = "attest8004.passkey.v1";
export const APPROVAL_SCHEMA_V1 = "attest8004.approval.v1";
/** WebAuthn's COSE algorithm id for ES256 (ECDSA P-256 with SHA-256), the only one MandateRegistry v2 verifies. */
export const ES256 = -7;

/** A mandate as MandateRegistry stores it (`MandateRegistry.Mandate`). */
export interface Mandate {
  allowedTargets: Address[];
  allowedSelectors: Hex[];
  maxValuePerTx: bigint;
  maxValuePerDay: bigint;
  validUntil: bigint;
}

const MANDATE_TUPLE = {
  type: "tuple",
  components: [
    { name: "allowedTargets", type: "address[]" },
    { name: "allowedSelectors", type: "bytes4[]" },
    { name: "maxValuePerTx", type: "uint256" },
    { name: "maxValuePerDay", type: "uint256" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

/** `keccak256(abi.encode(mandate))`, what `MandateRegistry.mandateHashOf` returns and what a `setMandate` approval binds. */
export function mandateHash(mandate: Mandate): Hex {
  return keccak256(encodeAbiParameters([MANDATE_TUPLE], [mandate]));
}

/** `keccak256(abi.encode(ROTATE_PASSKEY, qx, qy))`, the change a `rotatePasskey` approval binds. */
export function rotatePasskeyChangeHash(qx: Hex, qy: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [ROTATE_PASSKEY, qx, qy]));
}

/** `keccak256(abi.encode(SET_INBOX_KEY, x25519Pub))`, the change a `setInboxKey` approval binds. */
export function inboxKeyChangeHash(x25519Pub: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [SET_INBOX_KEY, x25519Pub]));
}

/**
 * `sha256(abi.encode(chainId, registry, agentId, changeHash, nonce))`, exactly `MandateRegistry.challengeFor`. The
 * WebAuthn challenge is these 32 raw bytes.
 */
export function passkeyChallenge(o: { chainId: number; registry: Address; agentId: bigint; changeHash: Hex; nonce: bigint }): Hex {
  return sha256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
      [BigInt(o.chainId), o.registry, o.agentId, o.changeHash, o.nonce],
    ),
  );
}

/** The e2e mandate's terms (unchanged since P5): plain MON transfers only, 0.002 MON per tx, 0.005 MON per day, until 2026-10-31T00:00:00Z. */
export const E2E_MANDATE_TERMS = {
  allowedSelectors: ["0x00000000"] as Hex[],
  maxValuePerTx: 2_000_000_000_000_000n,
  maxValuePerDay: 5_000_000_000_000_000n,
  validUntil: 1_793_404_800n,
} as const;

/** Demo agent 1984's e2e mandate: the agent's owner and the DemoPassThrough as targets, in that order, with {@link E2E_MANDATE_TERMS}. */
export function e2eMandate(o: { owner: Address; demoPassThrough: Address }): Mandate {
  return {
    allowedTargets: [getAddress(o.owner), getAddress(o.demoPassThrough)],
    allowedSelectors: [...E2E_MANDATE_TERMS.allowedSelectors],
    maxValuePerTx: E2E_MANDATE_TERMS.maxValuePerTx,
    maxValuePerDay: E2E_MANDATE_TERMS.maxValuePerDay,
    validUntil: E2E_MANDATE_TERMS.validUntil,
  };
}

const UINT256_MAX = 2n ** 256n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

const base64Url = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => {
    try {
      base64UrlDecode(s);
      return true;
    } catch {
      return false;
    }
  }, "must be canonical unpadded base64url");

const selector = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}$/, "must be a 4-byte selector")
  .transform((s) => s.toLowerCase() as Hex);

const index = z.number().int().nonnegative().refine(Number.isSafeInteger, "must be a safe integer");

/** A mandate as JSON (`uint` values as decimal strings): the shape inside an approval, and what /approve's editor accepts. */
export const mandateJsonSchema = z.strictObject({
  allowedTargets: z.array(zAddress).max(16),
  allowedSelectors: z.array(selector).max(16),
  maxValuePerTx: zDecimal(UINT256_MAX),
  maxValuePerDay: zDecimal(UINT256_MAX),
  validUntil: zDecimal(UINT64_MAX),
});

const authJsonSchema = z.strictObject({
  r: zBytes32,
  s: zBytes32,
  challengeIndex: index,
  typeIndex: index,
  authenticatorData: zHexBytes,
  clientDataJSON: z.string().max(4096),
});

/**
 * `attest8004.passkey.v1`: a passkey created on /approve, public data only. Structural checks here; what makes it
 * usable for MandateRegistry v2 is {@link registrationProblems}.
 */
export const registrationSchema = z.strictObject({
  schema: z.literal(REGISTRATION_SCHEMA_V1),
  rpId: z.string().max(253),
  credentialId: base64Url,
  transports: z.array(z.string().max(32)).max(8),
  alg: z.number().int(),
  qx: zBytes32,
  qy: zBytes32,
  /** The creation ceremony's authenticator data, kept for its rpIdHash, flags and attested credential data. */
  authenticatorData: zHexBytes,
  prfEnabled: z.boolean(),
});
export type PasskeyRegistration = z.output<typeof registrationSchema>;

/**
 * `attest8004.approval.v1`: one signed approval, public data only. `change.kind` is `setMandate` in P6 (P7 adds
 * `setInboxKey`). `passkey` is the key the approval was checked against (the agent's onchain passkey).
 */
export const approvalSchema = z.strictObject({
  schema: z.literal(APPROVAL_SCHEMA_V1),
  chainId: z.number().int().positive().refine(Number.isSafeInteger, "must be a safe integer"),
  registry: zAddress,
  agentId: zDecimal(UINT256_MAX),
  change: z.strictObject({ kind: z.literal("setMandate"), mandate: mandateJsonSchema }),
  changeHash: zBytes32,
  nonce: zDecimal(UINT256_MAX),
  challenge: zBytes32,
  passkey: z.strictObject({ credentialId: base64Url, qx: zBytes32, qy: zBytes32 }),
  auth: authJsonSchema,
});
export type Approval = z.output<typeof approvalSchema>;
export type MandateJson = Approval["change"]["mandate"];

export function mandateFromJson(json: MandateJson): Mandate {
  return {
    allowedTargets: json.allowedTargets.map((t) => getAddress(t)),
    allowedSelectors: json.allowedSelectors.map((s) => s.toLowerCase() as Hex),
    maxValuePerTx: BigInt(json.maxValuePerTx),
    maxValuePerDay: BigInt(json.maxValuePerDay),
    validUntil: BigInt(json.validUntil),
  };
}

export function mandateToJson(mandate: Mandate): MandateJson {
  return {
    allowedTargets: mandate.allowedTargets.map((t) => getAddress(t)),
    allowedSelectors: mandate.allowedSelectors.map((s) => s.toLowerCase() as Hex),
    maxValuePerTx: mandate.maxValuePerTx.toString(),
    maxValuePerDay: mandate.maxValuePerDay.toString(),
    validUntil: mandate.validUntil.toString(),
  };
}

/** The assertion as viem encodes `WebAuthn.WebAuthnAuth` for a contract call. */
export function authArgs(auth: WebAuthnAuthJson): {
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
} {
  return { ...auth, challengeIndex: BigInt(auth.challengeIndex), typeIndex: BigInt(auth.typeIndex) };
}

/** Builds the approval document for a `setMandate` change, computing its `changeHash` and `challenge`. */
export function buildApproval(o: {
  chainId: number;
  registry: Address;
  agentId: bigint;
  mandate: Mandate;
  nonce: bigint;
  passkey: { credentialId: string; qx: Hex; qy: Hex };
  auth: WebAuthnAuthJson;
}): Approval {
  const changeHash = mandateHash(o.mandate);
  return {
    schema: APPROVAL_SCHEMA_V1,
    chainId: o.chainId,
    registry: getAddress(o.registry),
    agentId: o.agentId.toString(),
    change: { kind: "setMandate", mandate: mandateToJson(o.mandate) },
    changeHash,
    nonce: o.nonce.toString(),
    challenge: passkeyChallenge({ chainId: o.chainId, registry: o.registry, agentId: o.agentId, changeHash, nonce: o.nonce }),
    passkey: { credentialId: o.passkey.credentialId, qx: o.passkey.qx, qy: o.passkey.qy },
    auth: o.auth,
  };
}

export type ApprovalSelfProblem = "CHANGE_HASH_MISMATCH" | "CHALLENGE_MISMATCH" | AssertionProblem;

/**
 * What an approval document says about itself, before any chain read: its `changeHash` and `challenge` recompute
 * from its own fields, and its assertion passes {@link verifyAssertionLocally} against its `passkey`. Empty means
 * consistent; the chain checks (registry, nonce, passkey, owner) are the caller's.
 */
export async function approvalSelfProblems(approval: Approval): Promise<ApprovalSelfProblem[]> {
  const problems: ApprovalSelfProblem[] = [];
  const changeHash = mandateHash(mandateFromJson(approval.change.mandate));
  if (changeHash.toLowerCase() !== approval.changeHash.toLowerCase()) problems.push("CHANGE_HASH_MISMATCH");
  const challenge = passkeyChallenge({
    chainId: approval.chainId,
    registry: approval.registry,
    agentId: BigInt(approval.agentId),
    changeHash,
    nonce: BigInt(approval.nonce),
  });
  if (challenge.toLowerCase() !== approval.challenge.toLowerCase()) problems.push("CHALLENGE_MISMATCH");
  const verdict = await verifyAssertionLocally({
    auth: approval.auth,
    challenge,
    qx: approval.passkey.qx,
    qy: approval.passkey.qy,
    rpIdHash: RP_ID_HASH,
  });
  if (!verdict.ok) problems.push(verdict.problem);
  return problems;
}

export type RegistrationProblem =
  | "RP_ID"
  | "ALG"
  | "PRF_NOT_ENABLED"
  | "RP_ID_HASH"
  | "USER_NOT_PRESENT"
  | "USER_NOT_VERIFIED"
  | "CREDENTIAL_DATA"
  | "KEY_NOT_ON_CURVE";

/**
 * Why a registration can't serve as an agent's passkey on MandateRegistry v2 (and P7's Mera inbox). Empty means usable.
 * `CREDENTIAL_DATA`: the key or credential id isn't the one attested in the creation's authenticator data.
 */
export function registrationProblems(registration: PasskeyRegistration): RegistrationProblem[] {
  const problems: RegistrationProblem[] = [];
  if (registration.rpId !== RP_ID) problems.push("RP_ID");
  if (registration.alg !== ES256) problems.push("ALG");
  if (!registration.prfEnabled) problems.push("PRF_NOT_ENABLED");
  const authenticatorData = hexToBytes(registration.authenticatorData);
  if (authenticatorData.length < 37) {
    problems.push("RP_ID_HASH");
  } else {
    const flags = authenticatorFlags(authenticatorData);
    if (flags.rpIdHash.toLowerCase() !== RP_ID_HASH.toLowerCase()) problems.push("RP_ID_HASH");
    if (!flags.up) problems.push("USER_NOT_PRESENT");
    if (!flags.uv) problems.push("USER_NOT_VERIFIED");
  }
  // The key and credential id the page took from getPublicKey() and credential.id must be the ones the authenticator
  // attested in the same creation, so a page bug can't bind a key that doesn't belong to the passkey.
  const attested = attestedCredential(authenticatorData);
  const credentialMatches = (() => {
    try {
      return attested !== null && attested.credentialId === bytesToHex(base64UrlDecode(registration.credentialId));
    } catch {
      return false;
    }
  })();
  const keyMatches = attested?.x?.toLowerCase() === registration.qx.toLowerCase() && attested?.y?.toLowerCase() === registration.qy.toLowerCase();
  if (!credentialMatches || !keyMatches) problems.push("CREDENTIAL_DATA");
  if (!isOnP256(registration.qx, registration.qy)) problems.push("KEY_NOT_ON_CURVE");
  return problems;
}

export type MandateRuleProblem = "ZERO_TARGET" | "EXPIRED" | "TX_CAP_ABOVE_DAILY_CAP";

/**
 * The validation MandateRegistry's `setMandate` applies that a JSON schema can't (the 16-entry limits are in
 * {@link mandateJsonSchema}): a zero target, `validUntil` at or before `nowSeconds`, a per-tx cap above the daily cap.
 * /approve refuses to ask for a signature the registry would reject.
 */
export function mandateRuleProblems(mandate: Mandate, nowSeconds: bigint): MandateRuleProblem[] {
  const problems: MandateRuleProblem[] = [];
  if (mandate.allowedTargets.some((t) => BigInt(t) === 0n)) problems.push("ZERO_TARGET");
  if (mandate.validUntil <= nowSeconds) problems.push("EXPIRED");
  if (mandate.maxValuePerTx > mandate.maxValuePerDay) problems.push("TX_CAP_ABOVE_DAILY_CAP");
  return problems;
}

/** Function selectors /approve names when a mandate allowlists them; token amounts are never capped by a mandate. */
const KNOWN_TOKEN_SELECTORS: Record<string, string> = {
  "0xa9059cbb": "transfer(address,uint256)",
  "0x095ea7b3": "approve(address,uint256)",
  "0x23b872dd": "transferFrom(address,address,uint256)",
};

/**
 * A mandate in plain words, one line per fact, for the person about to approve it. `labels` names known addresses
 * (checksummed keys), such as the agent's owner or the DemoPassThrough.
 */
export function describeMandate(mandate: Mandate, labels: Record<string, string>): string[] {
  const lines = [
    `At most ${formatEther(mandate.maxValuePerTx)} MON per transaction and ${formatEther(mandate.maxValuePerDay)} MON per day (native MON only).`,
  ];
  if (mandate.allowedTargets.length === 0) {
    lines.push("No target is allowed, so every action fails.");
  } else {
    for (const target of mandate.allowedTargets) {
      const address = getAddress(target);
      const label = labels[address];
      lines.push(`May send to ${address}${label ? ` (${label})` : " (unlabelled address)"}.`);
    }
  }
  if (mandate.allowedSelectors.length === 0) {
    lines.push("No call is allowed, so every action fails.");
  } else {
    for (const raw of mandate.allowedSelectors) {
      const sel = raw.toLowerCase();
      const token = KNOWN_TOKEN_SELECTORS[sel];
      if (sel === "0x00000000") lines.push(mandate.allowedSelectors.length === 1 ? "Plain MON transfers only (empty calldata)." : "Plain MON transfers (empty calldata).");
      else if (token) lines.push(`Calls ${token} (${sel}): token amounts are NOT capped by this mandate.`);
      else lines.push(`Calls the function with selector ${sel} (not a function this page knows).`);
    }
  }
  lines.push(`Valid until ${formatUnixTime(mandate.validUntil)}.`);
  return lines;
}

// Date covers ±8.64e15 ms; a larger validUntil (a typed mandate can hold up to 2^64 − 1) is shown as raw unix time.
const MAX_DATE_SECONDS = 8_640_000_000_000n;

function formatUnixTime(seconds: bigint): string {
  if (seconds > MAX_DATE_SECONDS) return `unix time ${seconds} (beyond any calendar date)`;
  return new Date(Number(seconds) * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

/** Whether passkey ceremonies may run on this host: only the production rpId, never localhost or a preview URL. */
export function isApproveHost(hostname: string): boolean {
  return hostname === RP_ID;
}

/** The first 8 bytes of `sha256(prfOutput)`, shown to compare two devices' PRF outputs without revealing them. */
export function prfFingerprint(prfOutput: Uint8Array): Hex {
  return bytesToHex(hexToBytes(sha256(prfOutput)).slice(0, 8));
}
