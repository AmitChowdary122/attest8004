// mandate-v1's permission-change rule, checked by submit-approval after a mandate lands (SPEC §4.5): no permission
// event for the agent may come after the mandate's own MandateSet log inside the 6,000-block window, or every action
// scores PERMISSION_CHANGED_AFTER_MANDATE until it leaves the window. The log helpers came from the retired
// set-mandate script; P6 adds the MandateRegistry's PasskeySet and PasskeyRotated.
import { agentKeySetEvent, blockWindows, identityRegistryAbi, mandateRegistryAbi } from "@attest8004/sdk";
import { getAbiItem, type AbiEvent, type Address, type PublicClient } from "viem";

/** Where the permission events live: the Identity Registry, the forwarder and the MandateRegistry valid now. */
export interface PermissionSources {
  publicClient: PublicClient;
  identityRegistry: Address;
  forwarder: Address;
  mandateRegistry: Address;
}

export interface FoundLog {
  label: string;
  blockNumber: bigint;
  logIndex: number;
}

const transferEvent = getAbiItem({ abi: identityRegistryAbi, name: "Transfer" }) as AbiEvent;
const approvalEvent = getAbiItem({ abi: identityRegistryAbi, name: "Approval" }) as AbiEvent;
const approvalForAllEvent = getAbiItem({ abi: identityRegistryAbi, name: "ApprovalForAll" }) as AbiEvent;
const mandateSetEvent = getAbiItem({ abi: mandateRegistryAbi, name: "MandateSet" }) as AbiEvent;
const mandateRevokedEvent = getAbiItem({ abi: mandateRegistryAbi, name: "MandateRevoked" }) as AbiEvent;
const passkeySetEvent = getAbiItem({ abi: mandateRegistryAbi, name: "PasskeySet" }) as AbiEvent;
const passkeyRotatedEvent = getAbiItem({ abi: mandateRegistryAbi, name: "PasskeyRotated" }) as AbiEvent;

/** `(block, logIndex)` ordering, as mandate-v1's own permission check compares them. */
export function isAfter(log: FoundLog, baseline: FoundLog): boolean {
  if (log.blockNumber !== baseline.blockNumber) return log.blockNumber > baseline.blockNumber;
  return log.logIndex > baseline.logIndex;
}

/** The MandateSet log that produced the stored record at `setAtBlock`: the baseline everything else is compared against. */
export async function mandateSetLogAt(sources: PermissionSources, agentId: bigint, block: bigint): Promise<FoundLog> {
  const logs = await sources.publicClient.getLogs({
    address: sources.mandateRegistry,
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
 * Every permission-relevant log for `agentId` in `[from, to]`, from the same sources mandate-v1 reads: the Identity
 * Registry's Transfer/Approval (this agent) and ApprovalForAll (this owner), the forwarder's AgentKeySet, and the
 * MandateRegistry's MandateSet, MandateRevoked, PasskeySet and PasskeyRotated (this agent). Scanned in `blockWindows`
 * (Monad's 100-block `eth_getLogs` limit).
 */
export async function permissionLogsIn(sources: PermissionSources, agentId: bigint, owner: Address, from: bigint, to: bigint): Promise<FoundLog[]> {
  if (from > to) return [];
  const { publicClient, identityRegistry, forwarder, mandateRegistry } = sources;
  const found: FoundLog[] = [];
  for (const window of blockWindows(from, to)) {
    const perEvent = await Promise.all([
      publicClient.getLogs({ address: identityRegistry, event: transferEvent, args: { tokenId: agentId }, ...window }),
      publicClient.getLogs({ address: identityRegistry, event: approvalEvent, args: { tokenId: agentId }, ...window }),
      publicClient.getLogs({ address: identityRegistry, event: approvalForAllEvent, args: { owner }, ...window }),
      publicClient.getLogs({ address: forwarder, event: agentKeySetEvent, args: { agentId }, ...window }),
      publicClient.getLogs({ address: mandateRegistry, event: mandateSetEvent, args: { agentId }, ...window }),
      publicClient.getLogs({ address: mandateRegistry, event: mandateRevokedEvent, args: { agentId }, ...window }),
      publicClient.getLogs({ address: mandateRegistry, event: passkeySetEvent, args: { agentId }, ...window }),
      publicClient.getLogs({ address: mandateRegistry, event: passkeyRotatedEvent, args: { agentId }, ...window }),
    ]);
    const labels = ["Transfer", "Approval", "ApprovalForAll", "AgentKeySet", "MandateSet", "MandateRevoked", "PasskeySet", "PasskeyRotated"];
    for (const [i, logs] of perEvent.entries()) {
      for (const log of logs) found.push({ label: labels[i] ?? "Unknown", blockNumber: log.blockNumber, logIndex: log.logIndex });
    }
  }
  return found;
}

/**
 * The error when a permission event for the agent landed after the stored mandate's own `MandateSet` log within
 * `mandate-v1`'s permission window, so every action would fail `PERMISSION_CHANGED_AFTER_MANDATE` until the last
 * such event leaves the window.
 */
export function permissionChangedMessage(o: {
  violations: ReadonlyArray<FoundLog>;
  setAtBlock: bigint;
  baselineLogIndex: number;
  windowBlocks: bigint;
}): string {
  const last = o.violations.reduce((a, b) => (isAfter(b, a) ? b : a));
  const until = last.blockNumber + o.windowBlocks;
  return (
    `mandate-v1 would score PERMISSION_CHANGED_AFTER_MANDATE until block ${until}: found ` +
    `${o.violations.map((v) => `${v.label} at block ${v.blockNumber} (logIndex ${v.logIndex})`).join(", ")}, ` +
    `after this mandate's own MandateSet at block ${o.setAtBlock} (logIndex ${o.baselineLogIndex}). ` +
    "If the owner meant those changes, approve the same mandate again at https://attest8004.vercel.app/approve and submit it " +
    "with `pnpm --filter @attest8004/scripts submit-approval <file>` (its new MandateSet log becomes the baseline), " +
    `or wait until block ${until}.`
  );
}

/**
 * mandate-v1's rule for the mandate stored at `setAtBlock`, bounded to `windowBlocks` of logs however old the mandate
 * is: throws {@link permissionChangedMessage} if any permission event came after its MandateSet log in the window.
 */
export async function checkPermissionWindow(
  sources: PermissionSources,
  o: { agentId: bigint; owner: Address; setAtBlock: bigint; windowBlocks: bigint },
): Promise<{ scanFrom: bigint; head: bigint; baseline: FoundLog; windows: number }> {
  const head = await sources.publicClient.getBlockNumber();
  const windowFloor = head > o.windowBlocks - 1n ? head - o.windowBlocks + 1n : 0n;
  const scanFrom = o.setAtBlock > windowFloor ? o.setAtBlock : windowFloor;
  const baseline = await mandateSetLogAt(sources, o.agentId, o.setAtBlock);
  const logs = await permissionLogsIn(sources, o.agentId, o.owner, scanFrom, head);
  const violations = logs.filter((log) => isAfter(log, baseline));
  if (violations.length > 0) {
    throw new Error(permissionChangedMessage({ violations, setAtBlock: o.setAtBlock, baselineLogIndex: baseline.logIndex, windowBlocks: o.windowBlocks }));
  }
  return { scanFrom, head, baseline, windows: blockWindows(scanFrom, head).length };
}
