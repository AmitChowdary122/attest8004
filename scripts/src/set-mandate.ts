/**
 * Sets the end-to-end spending mandate for demo agent 1984 on Monad testnet (SPEC §4.2): the
 * targets, selectors and per-tx/per-day MON caps mandate-v1 checks before scoring an action.
 *
 *   1. Computes the mandate's hash with the MandateRegistry's own pure `mandateHashOf` (eth_call)
 *      and skips sending if the stored mandate's hash already equals it, unless --force is given:
 *      that sets the same mandate again, so it gets a new MandateSet log (and setAtBlock), the
 *      baseline mandate-v1 orders permission events against (after an owner-intended permission
 *      change, say).
 *   2. Otherwise calls setMandate(1984, mandate) from the deployer (the agent's current owner),
 *      with a literal gas limit.
 *   3. Reads getMandate(1984) back and checks every field and that owner == deployer, then checks
 *      the same thing mandate-v1 itself would check before trusting this mandate: no permission
 *      event for agent 1984 — an Identity Registry Transfer/Approval/ApprovalForAll, the
 *      forwarder's AgentKeySet, or another MandateRegistry MandateSet/MandateRevoked — landed
 *      after this mandate's own MandateSet log within mandate-v1's permission-change window
 *      (PERMISSION_WINDOW_BLOCKS). Bounded: at most PERMISSION_WINDOW_BLOCKS of `eth_getLogs`
 *      windows, regardless of how long ago the mandate was set, so this stays cheap and never
 *      throws a false failure just because time has passed since the least-privilege switch.
 *
 * Run: pnpm --filter @attest8004/scripts set-mandate [-- --force]   (Node loads ../.env into the environment)
 *
 * Re-runnable: step 2 is skipped once the stored hash matches the constants below (unless --force).
 * Step 3's permission-window check runs either way. Needs DEPLOYER_PRIVATE_KEY. Every transaction has a
 * literal gas limit and goes through the SDK's estimate guard.
 */
import { getAbiItem, getAddress, parseEther, type AbiEvent, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEPLOYMENTS,
  agentKeySetEvent,
  blockWindows,
  identityRegistryAbi,
  mandateRegistryAbi,
  writeWithGasGuard,
} from "@attest8004/sdk";
import { assertChain, chain, check, printTx, publicClient, requireEnv, walletFor } from "./common.ts";
import { permissionChangedMessage, shouldSendMandate } from "./set-mandate-plan.ts";

/**
 * Explicit gas limit: Monad testnet eth_estimateGas on 3 Oct 2026 x 1.2, rounded up to 1k.
 * setMandate(1984, mandate) with exactly the constants below estimated 254,362.
 */
const GAS = { setMandate: 306_000n } as const;

/**
 * mandate-v1's own permission-change window (constraints N = 6,000 blocks, about 30 min): it fails
 * an action if a permission-changing event landed in the last this-many blocks and the mandate
 * wasn't set after it. This check reproduces exactly that rule for the mandate just read back, so
 * it's bounded to this many blocks of `eth_getLogs`, however old `setAtBlock` is.
 */
const PERMISSION_WINDOW_BLOCKS = 6_000n;

const deployment = DEPLOYMENTS[chain.id];
const [AGENT_ID] = deployment.demoAgents as readonly [bigint, bigint];
const identityRegistry = getAddress(deployment.identityRegistry);
const mandateRegistry = getAddress(deployment.mandateRegistry);
const forwarder = getAddress(deployment.agentRequestForwarder);
const owner = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY") as Hex);
const ownerWallet = walletFor(owner);
/** --force: send setMandate even when the stored mandate already matches, for a new MandateSet baseline. */
const force = process.argv.includes("--force");

/** The e2e mandate for agent 1984: plain MON transfers to the deployer only, capped and time-limited. */
const MANDATE = {
  allowedTargets: [owner.address] as Address[],
  allowedSelectors: ["0x00000000" as Hex],
  maxValuePerTx: parseEther("0.002"),
  maxValuePerDay: parseEther("0.005"),
  validUntil: 1_793_404_800n, // 2026-10-31T00:00:00Z
};

const transferEvent = getAbiItem({ abi: identityRegistryAbi, name: "Transfer" }) as AbiEvent;
const approvalEvent = getAbiItem({ abi: identityRegistryAbi, name: "Approval" }) as AbiEvent;
const approvalForAllEvent = getAbiItem({ abi: identityRegistryAbi, name: "ApprovalForAll" }) as AbiEvent;
const mandateSetEvent = getAbiItem({ abi: mandateRegistryAbi, name: "MandateSet" }) as AbiEvent;
const mandateRevokedEvent = getAbiItem({ abi: mandateRegistryAbi, name: "MandateRevoked" }) as AbiEvent;

interface Found {
  label: string;
  blockNumber: bigint;
  logIndex: number;
}

/** `(block, logIndex)` ordering, as mandate-v1's own permission check compares them. */
function isAfter(log: Found, baseline: Found): boolean {
  if (log.blockNumber !== baseline.blockNumber) return log.blockNumber > baseline.blockNumber;
  return log.logIndex > baseline.logIndex;
}

/** The MandateSet log that produced the stored record at `setAtBlock`: the baseline everything else is compared against. */
async function mandateSetLogAt(agentId: bigint, block: bigint): Promise<Found> {
  const logs = await publicClient.getLogs({
    address: mandateRegistry,
    event: mandateSetEvent,
    args: { agentId },
    fromBlock: block,
    toBlock: block,
  });
  const latest = logs.reduce<(typeof logs)[number] | undefined>((a, b) => (!a || b.logIndex > a.logIndex ? b : a), undefined);
  if (!latest) throw new Error(`no MandateSet log for agent ${agentId} found at block ${block} (its own setAtBlock)`);
  return { label: "MandateSet", blockNumber: latest.blockNumber, logIndex: latest.logIndex };
}

/**
 * Every permission-relevant log for `agentId` in `[from, to]`: the same sources mandate-v1's own
 * permission-change check reads (constraints.md) — the Identity Registry's Transfer/Approval (this
 * agentId) and ApprovalForAll (this owner, any operator), the forwarder's AgentKeySet (this
 * agentId), and the MandateRegistry's MandateSet/MandateRevoked (this agentId). Scanned in
 * `blockWindows` (Monad's 100-block `eth_getLogs` limit).
 */
async function permissionLogsIn(agentId: bigint, ownerAddress: Address, from: bigint, to: bigint): Promise<Found[]> {
  if (from > to) return [];
  const found: Found[] = [];
  for (const window of blockWindows(from, to)) {
    const sources = await Promise.all([
      publicClient.getLogs({ address: identityRegistry, event: transferEvent, args: { tokenId: agentId }, ...window }),
      publicClient.getLogs({ address: identityRegistry, event: approvalEvent, args: { tokenId: agentId }, ...window }),
      publicClient.getLogs({ address: identityRegistry, event: approvalForAllEvent, args: { owner: ownerAddress }, ...window }),
      publicClient.getLogs({ address: forwarder, event: agentKeySetEvent, args: { agentId }, ...window }),
      publicClient.getLogs({ address: mandateRegistry, event: mandateSetEvent, args: { agentId }, ...window }),
      publicClient.getLogs({ address: mandateRegistry, event: mandateRevokedEvent, args: { agentId }, ...window }),
    ]);
    const labels = ["Transfer", "Approval", "ApprovalForAll", "AgentKeySet", "MandateSet", "MandateRevoked"] as const;
    for (const [i, logs] of sources.entries()) {
      const label = labels[i] ?? "Unknown";
      for (const log of logs) found.push({ label, blockNumber: log.blockNumber, logIndex: log.logIndex });
    }
  }
  return found;
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

  // 1. Skip sending if the stored mandate already matches (unless --force).
  const [, storedHash] = await publicClient.readContract({
    address: mandateRegistry,
    abi: mandateRegistryAbi,
    functionName: "getMandate",
    args: [AGENT_ID],
  });
  if (!shouldSendMandate({ storedHash, mandateHash, force })) {
    console.log(`\nagent ${AGENT_ID} already has this mandate; nothing to send (--force sets it again, for a new MandateSet baseline)`);
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

  // mandate-v1's own rule: fail if a permission event for this agent landed within the last
  // PERMISSION_WINDOW_BLOCKS and this mandate wasn't set after it. Reproduce that exactly, bounded
  // to PERMISSION_WINDOW_BLOCKS of logs regardless of how long ago setAtBlock was (runs on both the
  // set and the skip path above).
  const head = await publicClient.getBlockNumber();
  const windowFloor = head > PERMISSION_WINDOW_BLOCKS - 1n ? head - PERMISSION_WINDOW_BLOCKS + 1n : 0n;
  const scanFrom = setAtBlock > windowFloor ? setAtBlock : windowFloor;
  const baseline = await mandateSetLogAt(AGENT_ID, setAtBlock);
  const logs = await permissionLogsIn(AGENT_ID, owner.address, scanFrom, head);
  const windows = blockWindows(scanFrom, head).length;
  console.log(
    `\nsetAtBlock ${setAtBlock} (logIndex ${baseline.logIndex}); scanned blocks ${scanFrom}..${head} ` +
      `(${head - scanFrom + 1n} blocks, ${windows} window(s)) for permission events on agent ${AGENT_ID}`,
  );
  const violations = logs.filter((log) => isAfter(log, baseline));
  if (violations.length > 0) {
    throw new Error(
      permissionChangedMessage({ violations, setAtBlock, baselineLogIndex: baseline.logIndex, windowBlocks: PERMISSION_WINDOW_BLOCKS }),
    );
  }
  check(`no permission event for agent ${AGENT_ID} landed after setAtBlock within the last ${PERMISSION_WINDOW_BLOCKS} blocks`, true, "none found");

  console.log("\nset-mandate OK");
}

// viem's shortMessage leaves out request details such as the RPC URL.
main().catch((error: unknown) => {
  const short = (error as { shortMessage?: string }).shortMessage;
  console.error(short ?? (error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
