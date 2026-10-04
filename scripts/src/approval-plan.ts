// submit-approval's and set-passkey's decisions (scripts/src/submit-approval.ts, set-passkey.ts), kept free of env and
// RPC so they can be unit tested. Everything an approval file claims is re-checked against the chain before a send.
import { isAbsolute, resolve } from "node:path";
import { approvalSelfProblems, type Approval } from "@attest8004/sdk";
import { getAddress, type Address, type Hex } from "viem";

/**
 * A file argument as the person meant it: pnpm runs a package script in the package's own directory (`scripts/`),
 * so a relative path resolves against `INIT_CWD`, the directory pnpm was started in.
 */
export function resolveInputPath(arg: string, env: NodeJS.ProcessEnv): string {
  return isAbsolute(arg) ? arg : resolve(env.INIT_CWD ?? process.cwd(), arg);
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
  /** The registry's own `mandateHashOf(mandate)` and `challengeFor(agentId, changeHash, nonce)` for this approval. */
  contractMandateHash: Hex;
  contractChallenge: Hex;
}

const ZERO32: Hex = `0x${"00".repeat(32)}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Why `approval` must not be sent, each as `CODE: detail`; empty means send. Checks the chain, the registry, the
 * nonce (a stale approval says to approve again), the agent's passkey, the sender, the registry's own hashes, then
 * the approval's internal consistency and its assertion (`approvalSelfProblems`).
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
  if (!same(chain.contractMandateHash, approval.changeHash)) {
    problems.push(`CHANGE_HASH_MISMATCH: the registry hashes this mandate to ${chain.contractMandateHash}, the approval says ${approval.changeHash}`);
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
  CHANGE_HASH_MISMATCH: "the approval's changeHash isn't its own mandate's hash",
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
