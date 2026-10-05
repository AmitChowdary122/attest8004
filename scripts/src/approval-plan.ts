// submit-approval's and set-passkey's decisions (scripts/src/submit-approval.ts, set-passkey.ts), kept free of env and
// RPC so they can be unit tested. Everything an approval file claims is re-checked against the chain before a send.
import { isAbsolute, resolve } from "node:path";
import { approvalChange, approvalSelfProblems, type Approval, type Mandate } from "@attest8004/sdk";
import { getAddress, type Address, type Hex } from "viem";

/**
 * A file argument as the person meant it: pnpm runs a package script in the package's own directory (`scripts/`),
 * so a relative path resolves against `INIT_CWD`, the directory pnpm was started in.
 */
export function resolveInputPath(arg: string, env: NodeJS.ProcessEnv): string {
  return isAbsolute(arg) ? arg : resolve(env.INIT_CWD ?? process.cwd(), arg);
}

/**
 * The gas caps the two scripts give the SDK's estimate guard (`{ headroomPercent: 20, max }`: the limit sent is the
 * live estimate × 1.2, and a send whose estimate is above the cap is refused). Monad charges the limit, not the gas
 * used, but the cap only bounds the limit, so a generous cap costs nothing. Measured on a fork of Monad testnet
 * against the canonical Identity Registry (an ERC1967 proxy, so `ownerOf` costs about 27k in-frame), plus the 21,000
 * intrinsic gas and calldata (the P6 whole-branch review, 5 Oct 2026; forge's frame gas against the mock registry
 * left all three out), then × 1.3:
 * - `setPasskey`: about 130,239 → 170,000.
 * - `setMandate`, first set of the e2e mandate (2 targets, 1 selector, Chrome's extra clientDataJSON key): about
 *   361,300 → 470,000 (setting it again: about 191,800). Each array entry beyond the e2e mandate's 3 adds a new
 *   storage slot and its calldata, so the cap grows 40,000 per entry, up to 16 targets and 16 selectors.
 */
export const SET_PASSKEY_GAS_CAP = 170_000n;
/**
 * `setInboxKey` (P7), on the same basis: contracts/test/fork/MandateRegistry.fork.t.sol's `testFork_Gas_SetInboxKey`
 * measured the live shape (after a mandate, the inbox key's first set, Chrome's extra clientDataJSON key) at frame
 * 143,832 + 21,000 intrinsic + 7,432 calldata = 172,264, × 1.3 → 224,000.
 */
export const SET_INBOX_KEY_GAS_CAP = 224_000n;
const SET_MANDATE_GAS_CAP_BASE = 470_000n;
const SET_MANDATE_GAS_PER_EXTRA_ENTRY = 40_000n;
const E2E_MANDATE_ENTRIES = 3;

export function setMandateGasCap(mandate: Mandate): bigint {
  const entries = mandate.allowedTargets.length + mandate.allowedSelectors.length;
  return SET_MANDATE_GAS_CAP_BASE + BigInt(Math.max(0, entries - E2E_MANDATE_ENTRIES)) * SET_MANDATE_GAS_PER_EXTRA_ENTRY;
}

/**
 * The scripts' arguments: exactly one file, plus `--<flag> <value>` for each allowed flag. Anything else is refused
 * rather than guessed at (`--agent=1985` or a bare `--agent` must never fall back to agent 1984).
 */
export function parseArgs(argv: string[], allowed: string[]): { file: string; flags: Record<string, string> } {
  const args = argv.filter((a) => a !== "--");
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!allowed.includes(name)) throw new Error(`unknown flag ${arg} (allowed: ${allowed.map((a) => `--${a} <value>`).join(", ")})`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    flags[name] = value;
    i++;
  }
  if (positional.length !== 1) throw new Error(`expected exactly one file, got ${positional.length}`);
  return { file: positional[0] as string, flags };
}

/** A decimal agent id, as `--agent` takes it. */
export function parseAgentId(text: string): bigint {
  if (!/^(0|[1-9]\d{0,76})$/.test(text)) throw new Error(`not a decimal agent id: "${text}"`);
  return BigInt(text);
}

/**
 * What `--confirm` must repeat before a script sends: the first 8 hex digits of the value it would bind (the
 * approval's changeHash, or the passkey's qx). Without it the scripts stop after printing what they would send.
 */
export function confirmationCode(value: Hex): string {
  return value.slice(0, 10).toLowerCase();
}

export function confirms(given: string | undefined, value: Hex): boolean {
  if (given === undefined) return false;
  const normalized = given.toLowerCase().startsWith("0x") ? given.toLowerCase() : `0x${given.toLowerCase()}`;
  return normalized === confirmationCode(value);
}

/** What the chain says right now, read by submit-approval before it decides to send. */
export interface ApprovalChainState {
  chainId: number;
  /** The MandateRegistry valid now (`currentMandateRegistry`). */
  registry: Address;
  /** `nonceOf(agentId)`. */
  nonce: bigint;
  /** `passkeyOf(agentId)`; zero when none is set. */
  qx: Hex;
  qy: Hex;
  /** `ownerOf(agentId)` on the Identity Registry. */
  owner: Address;
  /** The account submit-approval sends from. */
  sender: Address;
  /**
   * The registry's own hash of this change (`mandateHashOf(mandate)` for a mandate), or `null` when the registry has
   * no view for it (`setInboxKey`: its change hash is pinned by the cast-computed passkey-vectors.json instead).
   */
  contractChangeHash: Hex | null;
  /** The registry's own `challengeFor(agentId, changeHash, nonce)` for this approval. */
  contractChallenge: Hex;
  /** `inboxKeyOf(agentId)`; zero when none is set. */
  currentInboxKey: Hex;
}

const ZERO32: Hex = `0x${"00".repeat(32)}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Why `approval` must not be sent, each as `CODE: detail`; empty means send. Checks the chain, the registry, the
 * nonce (a stale approval says to approve again), the agent's passkey, the sender, the registry's own hashes, an
 * inbox key that is already set, then the approval's internal consistency and its assertion (`approvalSelfProblems`).
 */
export async function approvalProblems(approval: Approval, chain: ApprovalChainState): Promise<string[]> {
  const problems: string[] = [];
  const agent = approval.agentId;
  if (approval.chainId !== chain.chainId) problems.push(`WRONG_CHAIN: the approval is for chain ${approval.chainId}, the RPC is on ${chain.chainId}`);
  if (getAddress(approval.registry) !== getAddress(chain.registry)) {
    problems.push(`WRONG_REGISTRY: the approval names ${approval.registry}, the current MandateRegistry is ${chain.registry}`);
  }
  if (BigInt(approval.nonce) !== chain.nonce) {
    problems.push(
      `STALE_NONCE: the approval was signed at nonce ${approval.nonce}, but agent ${agent}'s nonce is ${chain.nonce} ` +
        "(another change or a revoke landed since): approve again at https://attest8004.vercel.app/approve",
    );
  }
  if (same(chain.qx, ZERO32) && same(chain.qy, ZERO32)) {
    problems.push(`PASSKEY_MISMATCH: agent ${agent} has no passkey yet; run set-passkey first`);
  } else if (!same(approval.passkey.qx, chain.qx) || !same(approval.passkey.qy, chain.qy)) {
    problems.push(`PASSKEY_MISMATCH: the approval was checked against another key than agent ${agent}'s passkey`);
  }
  if (getAddress(chain.sender) !== getAddress(chain.owner)) {
    problems.push(`NOT_OWNER: the sender ${chain.sender} doesn't own agent ${agent} (its owner is ${chain.owner})`);
  }
  if (chain.contractChangeHash !== null && !same(chain.contractChangeHash, approval.changeHash)) {
    problems.push(`CHANGE_HASH_MISMATCH: the registry hashes this change to ${chain.contractChangeHash}, the approval says ${approval.changeHash}`);
  }
  const change = approvalChange(approval);
  if (change.kind === "setInboxKey" && BigInt(change.x25519Pub) !== 0n && same(change.x25519Pub, chain.currentInboxKey)) {
    problems.push(`INBOX_KEY_UNCHANGED: agent ${agent}'s inbox key is already ${chain.currentInboxKey}; nothing to send`);
  }
  if (!same(chain.contractChallenge, approval.challenge)) {
    problems.push(`CHALLENGE_MISMATCH: the registry's challenge is ${chain.contractChallenge}, the approval signed ${approval.challenge}`);
  }
  for (const code of await approvalSelfProblems(approval)) {
    if (!problems.some((p) => p.startsWith(`${code}:`))) problems.push(`${code}: ${SELF_DETAIL[code]}`);
  }
  return problems;
}

const SELF_DETAIL: Record<string, string> = {
  CHANGE_HASH_MISMATCH: "the approval's changeHash isn't its own change's hash",
  INBOX_KEY_ZERO: "the inbox key is zero, which the registry refuses (ZeroInboxKey)",
  CHALLENGE_MISMATCH: "the approval's challenge doesn't recompute from its own fields",
  RP_ID_HASH: "the assertion is for another site than attest8004.vercel.app",
  USER_NOT_PRESENT: "the authenticator didn't report user presence",
  USER_NOT_VERIFIED: "the authenticator didn't report user verification",
  BACKUP_STATE: "the authenticator's backup flags are inconsistent",
  TYPE: 'clientDataJSON has no "type":"webauthn.get" at typeIndex',
  CHALLENGE: "clientDataJSON doesn't carry the approval's challenge at challengeIndex",
  HIGH_S: "s is above n/2, which the contract rejects",
  SIGNATURE: "the signature doesn't verify against the approval's passkey",
};
