// The two WebAuthn ceremonies /approve runs (ARCHITECTURE §5.1): creating the agent's passkey, and asserting over a
// mandate change's challenge. Parsing and checks live in @attest8004/sdk/browser, where they are unit tested.
import {
  ES256,
  REGISTRATION_SCHEMA_V1,
  RP_ID,
  authenticatorFlags,
  base64UrlDecode,
  bufferOf,
  clientDataIndices,
  p256PublicKeyFromSpki,
  registrationProblems,
  signatureFromDer,
  type PasskeyRegistration,
  type RegistrationProblem,
  type WebAuthnAuthJson,
} from "@attest8004/sdk/browser";
import { bytesToHex, type Hex } from "viem";

export interface CreatedPasskey {
  registration: PasskeyRegistration;
  /** The creation's UP, UV, BE and BS flags; BS means backed up (synced), so the phone on the same Google account has it. */
  flags: { up: boolean; uv: boolean; be: boolean; bs: boolean };
  problems: RegistrationProblem[];
}

/**
 * `navigator.credentials.create` for the agent's passkey: ES256 only, a discoverable credential (resident key
 * required), user verification required, attestation "none", and the PRF extension requested so P7's Mera inbox can
 * derive keys from this same passkey.
 */
export async function createPasskey(userName: string): Promise<CreatedPasskey> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { id: RP_ID, name: "Attest8004" },
      user: { id: crypto.getRandomValues(new Uint8Array(32)), name: userName, displayName: userName },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: ES256 }],
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      attestation: "none",
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("the browser returned no credential");
  const response = credential.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey();
  if (!spki) throw new Error("the browser didn't return the public key; this passkey can't be used");
  const authenticatorData = new Uint8Array(response.getAuthenticatorData());
  const prf = (credential.getClientExtensionResults() as { prf?: { enabled?: boolean } }).prf;
  const { qx, qy } = p256PublicKeyFromSpki(new Uint8Array(spki));
  const registration: PasskeyRegistration = {
    schema: REGISTRATION_SCHEMA_V1,
    rpId: RP_ID,
    credentialId: credential.id,
    transports: response.getTransports?.() ?? [],
    alg: response.getPublicKeyAlgorithm(),
    qx,
    qy,
    authenticatorData: bytesToHex(authenticatorData),
    prfEnabled: prf?.enabled === true,
  };
  const { up, uv, be, bs } = authenticatorFlags(authenticatorData);
  return { registration, flags: { up, uv, be, bs }, problems: registrationProblems(registration) };
}

/**
 * `navigator.credentials.get` over `challenge` (its 32 raw bytes), user verification required: any discoverable
 * passkey for the rpId (the contract stores only the public key, not a credential id), or only `credentialId` when
 * given (the inbox key's approval must come from the passkey that derived the key). Returns the assertion in the
 * contract's shape: `s` low, indices found by search in the exact `clientDataJSON` the browser returned.
 */
export async function approveWithPasskey(challenge: Hex, o: { credentialId?: string } = {}): Promise<{ auth: WebAuthnAuthJson; credentialId: string }> {
  const allowCredentials =
    o.credentialId === undefined ? undefined : [{ type: "public-key" as const, id: bufferOf(bytesToHex(base64UrlDecode(o.credentialId))) }];
  const credential = (await navigator.credentials.get({
    publicKey: { challenge: bufferOf(challenge), rpId: RP_ID, userVerification: "required", timeout: 120_000, ...(allowCredentials ? { allowCredentials } : {}) },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("the browser returned no assertion");
  if (o.credentialId !== undefined && credential.id !== o.credentialId) throw new Error("the browser answered with another passkey than the one asked for");
  const response = credential.response as AuthenticatorAssertionResponse;
  const clientDataJSON = new TextDecoder().decode(response.clientDataJSON);
  const { r, s } = signatureFromDer(new Uint8Array(response.signature));
  return {
    auth: {
      r,
      s,
      ...clientDataIndices(clientDataJSON),
      authenticatorData: bytesToHex(new Uint8Array(response.authenticatorData)),
      clientDataJSON,
    },
    credentialId: credential.id,
  };
}
