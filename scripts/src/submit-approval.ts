/**
 * Submits a passkey-signed mandate approval to the current MandateRegistry (v2, SPEC §4.2) from the agent's owner: the
 * second factor of a mandate change, after the passkey's assertion on https://attest8004.vercel.app/approve.
 *
 *   1. Reads the approval file (`attest8004.approval.v1`, the page's "Download approval" or "Copy approval").
 *   2. Re-checks everything it claims before sending (`approvalProblems`): the chain and the current registry; the
 *      nonce (a stale approval says to approve again); the agent's passkey; the deployer owns the agent; the registry's
 *      own mandateHashOf and challengeFor; the rpIdHash, UP/UV flags, challenge and P-256 signature, verified locally.
 *   3. Prints the new mandate and the current one in plain words, the owner's own check of what the passkey signed
 *      (a WebAuthn prompt shows no content). Without --confirm it stops there.
 *   4. With `--confirm <first 8 hex digits of the changeHash>`, sends setMandate(agentId, mandate, auth) from the
 *      deployer with an explicit gas limit (the SDK's estimate guard).
 *   5. Reads the mandate back field by field, checks the nonce moved by one, and runs mandate-v1's own permission-window
 *      rule for the new mandate (no permission event after its MandateSet in the last 6,000 blocks).
 *
 * Run: pnpm --filter @attest8004/scripts submit-approval <approval.json> [--confirm 0x12345678]
 * A relative path is resolved against the directory you ran pnpm in. Needs DEPLOYER_PRIVATE_KEY (.env). After a new
 * mandate lands, wait 6,000 blocks (about 31 minutes) before the e2e: its preflight refuses to start sooner.
 */
import { readFileSync } from "node:fs";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEPLOYMENTS,
  approvalSchema,
  authArgs,
  describeMandate,
  currentMandateRegistry,
  identityRegistryAbi,
  mandateFromJson,
  mandateRegistryAbi,
  writeWithGasGuard,
} from "@attest8004/sdk";
import { MANDATE_V1 } from "@attest8004/validator-mandate";
import { assertChain, chain, check, printTx, publicClient, requireEnv, walletFor } from "./common.ts";
import { approvalProblems, confirmationCode, confirms, parseArgs, resolveInputPath, setMandateGasCap } from "./approval-plan.ts";
import { checkPermissionWindow } from "./permission-window.ts";


const deployment = DEPLOYMENTS[chain.id];
const registry = getAddress(currentMandateRegistry(deployment).address);
const identityRegistry = getAddress(deployment.identityRegistry);
const owner = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY") as Hex);
const ZERO32: Hex = `0x${"00".repeat(32)}`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ["confirm"]);
  const file = resolveInputPath(args.file, process.env);
  await assertChain();
  console.log(`MandateRegistry ${registry} (chain ${chain.id})`);
  console.log(`owner           ${owner.address} (deployer)`);
  console.log(`approval        ${file}`);

  // 1. The file.
  const approval = approvalSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const agentId = BigInt(approval.agentId);
  const mandate = mandateFromJson(approval.change.mandate);
  console.log(`agent           ${agentId}, nonce ${approval.nonce}, changeHash ${approval.changeHash}`);

  // 2. Re-check against the chain.
  const onRegistry = { address: registry, abi: mandateRegistryAbi } as const;
  const [nonce, [qx, qy], agentOwner, contractMandateHash] = await Promise.all([
    publicClient.readContract({ ...onRegistry, functionName: "nonceOf", args: [agentId] }),
    publicClient.readContract({ ...onRegistry, functionName: "passkeyOf", args: [agentId] }),
    publicClient.readContract({ address: identityRegistry, abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId] }),
    publicClient.readContract({ ...onRegistry, functionName: "mandateHashOf", args: [mandate] }),
  ]);
  const contractChallenge = await publicClient.readContract({
    ...onRegistry,
    functionName: "challengeFor",
    args: [agentId, approval.changeHash, BigInt(approval.nonce)],
  });
  const problems = await approvalProblems(approval, {
    chainId: chain.id,
    registry,
    nonce,
    qx,
    qy,
    owner: getAddress(agentOwner),
    sender: owner.address,
    contractMandateHash,
    contractChallenge,
  });
  if (problems.length > 0) throw new Error(`refusing to send:\n  ${problems.join("\n  ")}`);
  console.log("  ok  the approval matches the chain, and its assertion verifies locally against the agent's passkey");

  // 3. Show what the owner's transaction would set, next to what is set now.
  const labels: Record<string, string> = {
    [owner.address]: "the agent's owner (the deployer)",
    [getAddress(deployment.demoPassThrough)]: "DemoPassThrough: forwards every payment to a sink nobody controls",
    [getAddress(deployment.demoAgentVault)]: "DemoAgentVault",
  };
  const [current, currentHash] = await publicClient.readContract({ ...onRegistry, functionName: "getMandate", args: [agentId] });
  console.log(`\nthe new mandate for agent ${agentId} (changeHash ${approval.changeHash}):`);
  for (const line of describeMandate(mandate, labels)) console.log(`  ${line}`);
  if (currentHash === ZERO32) {
    console.log("it replaces: no mandate");
  } else {
    console.log(`it replaces (mandateHash ${currentHash}):`);
    const currentMandate = { ...current, allowedTargets: [...current.allowedTargets], allowedSelectors: [...current.allowedSelectors] };
    for (const line of describeMandate(currentMandate, labels)) console.log(`  ${line}`);
  }
  if (!confirms(args.flags.confirm, approval.changeHash)) {
    console.log(`\nnot sent. If that is the mandate you approved, re-run with --confirm ${confirmationCode(approval.changeHash)}`);
    return;
  }

  // 4. Send.
  const sent = await writeWithGasGuard({
    publicClient,
    walletClient: walletFor(owner),
    address: registry,
    abi: mandateRegistryAbi,
    functionName: "setMandate",
    args: [agentId, mandate, authArgs(approval.auth)],
    // The limit sent is the live estimate × 1.2, never above the cap (how the cap was measured: setMandateGasCap).
    gasLimit: { headroomPercent: 20, max: setMandateGasCap(mandate) },
    label: `setMandate ${agentId}`,
  });
  printTx(`setMandate ${agentId}`, sent);

  // 5. Read back.
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
  check("the caps and validUntil read back exactly", stored.maxValuePerTx === mandate.maxValuePerTx && stored.maxValuePerDay === mandate.maxValuePerDay && stored.validUntil === mandate.validUntil, "");
  check("the record's owner is the deployer", getAddress(recordOwner) === owner.address, recordOwner);
  const nonceAfter = await publicClient.readContract({ ...onRegistry, functionName: "nonceOf", args: [agentId] });
  check(`nonceOf(${agentId}) moved from ${nonce} to ${nonce + 1n}`, nonceAfter === nonce + 1n, nonceAfter.toString());

  const window = await checkPermissionWindow(
    { publicClient, identityRegistry, forwarder: getAddress(deployment.agentRequestForwarder), mandateRegistry: registry },
    { agentId, owner: owner.address, setAtBlock, windowBlocks: MANDATE_V1.permissionWindowBlocks },
  );
  console.log(
    `setAtBlock ${setAtBlock} (logIndex ${window.baseline.logIndex}); scanned blocks ${window.scanFrom}..${window.head} ` +
      `(${window.windows} window(s)): no permission event after this mandate's MandateSet`,
  );
  console.log(`\nthe e2e may start from block ${setAtBlock + MANDATE_V1.permissionWindowBlocks} (6,000 blocks, about 31 minutes, after setAtBlock)`);
  console.log("\nsubmit-approval OK");
}

// viem's shortMessage leaves out request details such as the RPC URL.
main().catch((error: unknown) => {
  const short = (error as { shortMessage?: string }).shortMessage;
  console.error(short ?? (error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
