/**
 * The chain half of submitting a passkey approval (SPEC §4.2), shared by submit-approval and `pnpm demo` (P9): the
 * chain state `approvalProblems` checks an approval against, and the owner's `setMandate` send with its read-back
 * checks and mandate-v1's permission-window rule. Nothing here prints or reads the environment.
 */
import {
  approvalChange,
  authArgs,
  identityRegistryAbi,
  mandateRegistryAbi,
  writeWithGasGuard,
  type Approval,
  type Mandate,
} from "@attest8004/sdk";
import { MANDATE_V1 } from "@attest8004/validator-mandate";
import { getAddress, type Address, type Hash, type PublicClient, type TransactionReceipt, type WalletClient } from "viem";
import { setMandateGasCap, type ApprovalChainState } from "./approval-plan.ts";
import { checkPermissionWindow } from "./permission-window.ts";

/**
 * common.ts's `check`, here so this module never needs the RPC URL at import (tests load it without .env): it throws
 * the same message, and reports each passing check to `onPass` (submit-approval prints it as `  ok  <label>`).
 */
export function makeCheck(onPass?: (label: string) => void): (label: string, ok: boolean, detail: string) => void {
  return (label, ok, detail) => {
    if (!ok) throw new Error(`check failed: ${label} (${detail})`);
    onPass?.(label);
  };
}

/**
 * Everything `approvalProblems` checks `approval` against, read now: the agent's nonce, passkey, owner and inbox key,
 * the registry's own hash of the change (`mandateHashOf`, mandates only) and its `challengeFor` the approval's change
 * hash at the approval's own nonce.
 */
export async function readApprovalChainState(o: {
  publicClient: PublicClient;
  chainId: number;
  registry: Address;
  identityRegistry: Address;
  approval: Approval;
  sender: Address;
}): Promise<ApprovalChainState> {
  const { publicClient, registry, approval } = o;
  const onRegistry = { address: registry, abi: mandateRegistryAbi } as const;
  const agentId = BigInt(approval.agentId);
  const change = approvalChange(approval);
  const [nonce, [qx, qy], agentOwner, currentInboxKey, contractChangeHash] = await Promise.all([
    publicClient.readContract({ ...onRegistry, functionName: "nonceOf", args: [agentId] }),
    publicClient.readContract({ ...onRegistry, functionName: "passkeyOf", args: [agentId] }),
    publicClient.readContract({ address: o.identityRegistry, abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId] }),
    publicClient.readContract({ ...onRegistry, functionName: "inboxKeyOf", args: [agentId] }),
    change.kind === "setMandate"
      ? publicClient.readContract({ ...onRegistry, functionName: "mandateHashOf", args: [change.mandate] })
      : Promise.resolve(null),
  ]);
  const contractChallenge = await publicClient.readContract({
    ...onRegistry,
    functionName: "challengeFor",
    args: [agentId, approval.changeHash, BigInt(approval.nonce)],
  });
  return {
    chainId: o.chainId,
    registry,
    nonce,
    qx,
    qy,
    owner: getAddress(agentOwner),
    sender: o.sender,
    contractChangeHash,
    contractChallenge,
    currentInboxKey,
  };
}

/** A sent transaction as the SDK's gas guard reports it. */
export interface SentTx {
  hash: Hash;
  receipt: TransactionReceipt;
  estimate: bigint;
  gasLimit: bigint;
}

/**
 * Sends `setMandate(agentId, mandate, auth)` from the owner with an explicit limit (the live estimate × 1.2, never above
 * `setMandateGasCap`), calls `onSent` at once (so a caller can print the link before any check runs), then reads the
 * mandate back: the stored hash is the approved changeHash, the targets, selectors, caps and validUntil are exact, the
 * record's owner is the sender, the nonce moved from `nonce` by one, and no permission event came after its MandateSet
 * in mandate-v1's 6,000-block window. Any failed check throws, after the send.
 */
export async function sendMandateApproval(o: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  owner: Address;
  registry: Address;
  identityRegistry: Address;
  forwarder: Address;
  approval: Approval;
  mandate: Mandate;
  nonce: bigint;
  onSent?: (sent: SentTx) => void;
  /** Hears each read-back check that passed, in order. */
  onCheck?: (label: string) => void;
}): Promise<SentTx & { setAtBlock: bigint; window: Awaited<ReturnType<typeof checkPermissionWindow>> }> {
  const check = makeCheck(o.onCheck);
  const { publicClient, registry, approval, mandate, nonce, owner } = o;
  const onRegistry = { address: registry, abi: mandateRegistryAbi } as const;
  const agentId = BigInt(approval.agentId);

  const sent = await writeWithGasGuard({
    publicClient,
    walletClient: o.walletClient,
    address: registry,
    abi: mandateRegistryAbi,
    functionName: "setMandate",
    args: [agentId, mandate, authArgs(approval.auth)],
    // The limit sent is the live estimate × 1.2, never above the cap (how the cap was measured: setMandateGasCap).
    gasLimit: { headroomPercent: 20, max: setMandateGasCap(mandate) },
    label: `setMandate ${agentId}`,
  });
  o.onSent?.(sent);

  const [stored, storedHash, recordOwner, setAtBlock] = await publicClient.readContract({ ...onRegistry, functionName: "getMandate", args: [agentId] });
  check("the stored mandate hash is the approved changeHash", storedHash.toLowerCase() === approval.changeHash.toLowerCase(), storedHash);
  check(
    "allowedTargets read back exactly",
    JSON.stringify(stored.allowedTargets.map((t) => getAddress(t))) === JSON.stringify(mandate.allowedTargets),
    JSON.stringify(stored.allowedTargets),
  );
  check(
    "allowedSelectors read back exactly",
    JSON.stringify(stored.allowedSelectors.map((s) => s.toLowerCase())) === JSON.stringify(mandate.allowedSelectors),
    JSON.stringify(stored.allowedSelectors),
  );
  check(
    "the caps and validUntil read back exactly",
    stored.maxValuePerTx === mandate.maxValuePerTx && stored.maxValuePerDay === mandate.maxValuePerDay && stored.validUntil === mandate.validUntil,
    "",
  );
  check("the record's owner is the deployer", getAddress(recordOwner) === owner, recordOwner);
  const nonceAfter = await publicClient.readContract({ ...onRegistry, functionName: "nonceOf", args: [agentId] });
  check(`nonceOf(${agentId}) moved from ${nonce} to ${nonce + 1n}`, nonceAfter === nonce + 1n, nonceAfter.toString());

  const window = await checkPermissionWindow(
    { publicClient, identityRegistry: o.identityRegistry, forwarder: o.forwarder, mandateRegistry: registry },
    { agentId, owner, setAtBlock, windowBlocks: MANDATE_V1.permissionWindowBlocks },
  );
  return { ...sent, setAtBlock, window };
}
