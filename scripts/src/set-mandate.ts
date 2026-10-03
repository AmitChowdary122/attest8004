/**
 * Sets the end-to-end spending mandate for demo agent 1984 on Monad testnet (SPEC §4.2): the
 * targets, selectors and per-tx/per-day MON caps mandate-v1 checks before scoring an action.
 *
 *   1. Computes the mandate's hash with the MandateRegistry's own pure `mandateHashOf` (eth_call)
 *      and skips sending if the stored mandate's hash already equals it.
 *   2. Otherwise calls setMandate(1984, mandate) from the deployer (the agent's current owner),
 *      with a literal gas limit.
 *   3. Reads getMandate(1984) back and checks every field and that owner == deployer, then checks
 *      setAtBlock is after the most recent Identity Registry Approval (for each demo agent) and
 *      ApprovalForAll(deployer, forwarder) it can find — so the least-privilege switch
 *      (setup-demo-agents.ts) predates the mandate.
 *
 * Run: pnpm --filter @attest8004/scripts set-mandate   (Node loads ../.env into the environment)
 *
 * Re-runnable: step 2 is skipped once the stored hash matches the constants below. Needs
 * DEPLOYER_PRIVATE_KEY. Every transaction has a literal gas limit and goes through the SDK's
 * estimate guard.
 */
import { getAbiItem, getAddress, parseEther, type AbiEvent, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEPLOYMENTS,
  MAX_LOG_BLOCK_RANGE,
  identityRegistryAbi,
  mandateRegistryAbi,
  writeWithGasGuard,
} from "@attest8004/sdk";
import { assertChain, chain, check, printTx, publicClient, requireEnv, walletFor } from "./common.ts";

/**
 * Explicit gas limit: Monad testnet eth_estimateGas on 3 Oct 2026 x 1.2, rounded up to 1k.
 * setMandate(1984, mandate) with exactly the constants below estimated 254,362.
 */
const GAS = { setMandate: 306_000n } as const;

/** How far back to search for the setup-demo-agents.ts approvals (about 8.5 h at ~0.305 s/block). */
const LOOKBACK_BLOCKS = 100_000n;

const deployment = DEPLOYMENTS[chain.id];
const [AGENT_ID, OTHER_AGENT_ID] = deployment.demoAgents as readonly [bigint, bigint];
const identityRegistry = getAddress(deployment.identityRegistry);
const mandateRegistry = getAddress(deployment.mandateRegistry);
const forwarder = getAddress(deployment.agentRequestForwarder);
const owner = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY") as Hex);
const ownerWallet = walletFor(owner);

/** The e2e mandate for agent 1984: plain MON transfers to the deployer only, capped and time-limited. */
const MANDATE = {
  allowedTargets: [owner.address] as Address[],
  allowedSelectors: ["0x00000000" as Hex],
  maxValuePerTx: parseEther("0.002"),
  maxValuePerDay: parseEther("0.005"),
  validUntil: 1_793_404_800n, // 2026-10-31T00:00:00Z
};

const approvalEvent = getAbiItem({ abi: identityRegistryAbi, name: "Approval" }) as AbiEvent;
const approvalForAllEvent = getAbiItem({ abi: identityRegistryAbi, name: "ApprovalForAll" }) as AbiEvent;

/**
 * Scans backward from the head in MAX_LOG_BLOCK_RANGE windows (Monad's eth_getLogs limit) for the
 * most recent log matching `event`/`args` on the Identity Registry, up to `maxBlocksBack`.
 * Backward, because the approvals this checks for are recent (the same setup run), so the first
 * window usually matches; returns undefined if nothing is found within the lookback.
 */
async function latestLogBlock(event: AbiEvent, args: Record<string, unknown>, maxBlocksBack: bigint): Promise<bigint | undefined> {
  const head = await publicClient.getBlockNumber();
  const floor = head > maxBlocksBack ? head - maxBlocksBack : 0n;
  for (let to = head; ; ) {
    const from = to - MAX_LOG_BLOCK_RANGE + 1n > floor ? to - MAX_LOG_BLOCK_RANGE + 1n : floor;
    const logs = await publicClient.getLogs({ address: identityRegistry, event, args, fromBlock: from, toBlock: to });
    if (logs.length > 0) return logs[logs.length - 1]?.blockNumber;
    if (from <= floor) return undefined;
    to = from - 1n;
  }
}

async function main(): Promise<void> {
  await assertChain();
  console.log(`MandateRegistry ${mandateRegistry} (chain ${chain.id})`);
  console.log(`owner           ${owner.address} (deployer)`);

  const mandateHash = await publicClient.readContract({
    address: mandateRegistry,
    abi: mandateRegistryAbi,
    functionName: "mandateHashOf",
    args: [MANDATE],
  });
  console.log(`mandate hash    ${mandateHash}`);

  // 1. Skip sending if the stored mandate already matches.
  const [, storedHash] = await publicClient.readContract({
    address: mandateRegistry,
    abi: mandateRegistryAbi,
    functionName: "getMandate",
    args: [AGENT_ID],
  });
  if (storedHash === mandateHash) {
    console.log(`\nagent ${AGENT_ID} already has this mandate; nothing to send`);
  } else {
    // 2. setMandate from the deployer.
    const sent = await writeWithGasGuard({
      publicClient,
      walletClient: ownerWallet,
      address: mandateRegistry,
      abi: mandateRegistryAbi,
      functionName: "setMandate",
      args: [AGENT_ID, MANDATE],
      gasLimit: GAS.setMandate,
      label: `setMandate ${AGENT_ID}`,
    });
    printTx(`setMandate ${AGENT_ID}`, sent);
  }

  // 3. Read back and check every field.
  const [mandate, hash, recordOwner, setAtBlock] = await publicClient.readContract({
    address: mandateRegistry,
    abi: mandateRegistryAbi,
    functionName: "getMandate",
    args: [AGENT_ID],
  });
  check(`agent ${AGENT_ID}'s stored mandate hash matches the constants`, hash === mandateHash, hash);
  check(
    "allowedTargets is exactly the deployer",
    mandate.allowedTargets.length === 1 && mandate.allowedTargets[0] === owner.address,
    JSON.stringify(mandate.allowedTargets),
  );
  check(
    "allowedSelectors is exactly 0x00000000",
    mandate.allowedSelectors.length === 1 && mandate.allowedSelectors[0] === "0x00000000",
    JSON.stringify(mandate.allowedSelectors),
  );
  check("maxValuePerTx is 0.002 MON", mandate.maxValuePerTx === MANDATE.maxValuePerTx, mandate.maxValuePerTx.toString());
  check("maxValuePerDay is 0.005 MON", mandate.maxValuePerDay === MANDATE.maxValuePerDay, mandate.maxValuePerDay.toString());
  check("validUntil is 2026-10-31T00:00:00Z", mandate.validUntil === MANDATE.validUntil, mandate.validUntil.toString());
  check("owner is the deployer", recordOwner === owner.address, recordOwner);

  // The mandate must be set after the least-privilege switch: find the most recent per-token
  // Approval for each demo agent and the blanket ApprovalForAll change on the Identity Registry.
  const [approval1984, approval1985, approvalForAll] = await Promise.all([
    latestLogBlock(approvalEvent, { tokenId: AGENT_ID }, LOOKBACK_BLOCKS),
    latestLogBlock(approvalEvent, { tokenId: OTHER_AGENT_ID }, LOOKBACK_BLOCKS),
    latestLogBlock(approvalForAllEvent, { owner: owner.address, operator: forwarder }, LOOKBACK_BLOCKS),
  ]);
  console.log(
    `\nsetAtBlock ${setAtBlock}; approvals found: agent ${AGENT_ID} Approval at ${approval1984 ?? "none"}, ` +
      `agent ${OTHER_AGENT_ID} Approval at ${approval1985 ?? "none"}, ` +
      `ApprovalForAll(deployer, forwarder) at ${approvalForAll ?? "none"}`,
  );
  const approvalBlocks = [approval1984, approval1985, approvalForAll].filter((b): b is bigint => b !== undefined);
  if (approvalBlocks.length === 0) {
    throw new Error(`no Approval/ApprovalForAll log found for the forwarder within ${LOOKBACK_BLOCKS} blocks of the head`);
  }
  const latestApproval = approvalBlocks.reduce((a, b) => (b > a ? b : a));
  check(
    `setAtBlock (${setAtBlock}) is after the latest permission change (${latestApproval})`,
    setAtBlock > latestApproval,
    `${setAtBlock} vs ${latestApproval}`,
  );

  console.log("\nset-mandate OK");
}

// viem's shortMessage leaves out request details such as the RPC URL.
main().catch((error: unknown) => {
  const short = (error as { shortMessage?: string }).shortMessage;
  console.error(short ?? (error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
