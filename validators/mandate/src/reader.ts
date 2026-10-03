import {
  agentKeySetEvent,
  attestGateAbi,
  blockWindows,
  identityRegistryAbi,
  mandateRegistryAbi,
  MAX_LOG_BLOCK_RANGE,
  validationRegistryAbi,
  validationRequestEvent,
  validationResponseEvent,
  type ValidationStatus,
} from "@attest8004/sdk";
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAbiItem,
  getAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { blocksWithTimestamp } from "./blocks.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import { MANDATE_V1 } from "./params.ts";
import type { MandateRecord, PermissionEvent, PinnedBlock, Simulation } from "./types.ts";

/** The contracts `mandate-v1` reads. */
export interface MandateAddresses {
  validationRegistry: Address;
  identityRegistry: Address;
  forwarder: Address;
  mandateRegistry: Address;
}

/**
 * Everything `mandate-v1` reads from the chain. Every state read takes `at`, the pinned block `P`,
 * and reads exactly that block; every log read ends at or before the block it is given. A transient
 * RPC failure (HTTP 429, a timeout, history the node no longer serves) always throws, so it can
 * never turn into a verdict. `viemMandateReader` is the real one.
 */
export interface MandateReader {
  chainId(): Promise<number>;
  /** The finalized head. */
  finalized(): Promise<PinnedBlock>;
  block(number: bigint): Promise<PinnedBlock>;
  /** `MandateRegistry.getMandate(agentId)` at `at`; `null` when its `mandateHash` is zero (never set, or revoked). */
  mandate(agentId: bigint, at: bigint): Promise<MandateRecord | null>;
  ownerOf(agentId: bigint, at: bigint): Promise<Address>;
  /** `getAgentValidations(agentId)` at `at`, in the registry's order. */
  agentValidations(agentId: bigint, at: bigint): Promise<Hex[]>;
  status(requestHash: Hex, at: bigint): Promise<ValidationStatus>;
  /**
   * `gate.consumed(actionHash)` at `at`, with a gas cap of `MANDATE_V1.consumedCallGas`. `null` only
   * when the call itself fails deterministically: it reverts, or runs out of gas within the cap.
   */
  consumed(gate: Address, actionHash: Hex, at: bigint): Promise<boolean | null>;
  /**
   * The permission-change events in `[fromBlock, toBlock]`: the Identity Registry's `Transfer` and
   * `Approval` of token `agentId` and `ApprovalForAll` by `owner`, the forwarder's `AgentKeySet` for
   * `agentId`, and the MandateRegistry's `MandateSet`/`MandateRevoked` for `agentId`, sorted by
   * `(block, logIndex)`.
   */
  permissionLogs(
    fromBlock: bigint,
    toBlock: bigint,
    filter: { agentId: bigint; owner: Address },
  ): Promise<Omit<PermissionEvent, "afterMandate">[]>;
  /**
   * An `eth_call` of `call` at `at` with its explicit `gas`. Only a revert (JSON-RPC code 3), too
   * little balance (`insufficient funds`) or running out of gas are outcomes; any other failure throws.
   */
  simulate(call: { from: Address; to: Address; value: bigint; data: Hex; gas: bigint }, at: bigint): Promise<Simulation>;
  /**
   * The `responseURI` of the `ValidationResponse` for `requestHash` that set its `lastUpdate` to
   * `timestamp`: the last such log in the blocks at or before `notAfter` that carry that timestamp.
   * `null` when none is found.
   */
  responseEvidence(requestHash: Hex, timestamp: bigint, notAfter: bigint): Promise<string | null>;
  /** The `requestURI` of the `ValidationRequest` for `requestHash` in block `block`; `null` when none is found. */
  requestUri(requestHash: Hex, block: bigint): Promise<string | null>;
}

const transferEvent = getAbiItem({ abi: identityRegistryAbi, name: "Transfer" });
const approvalEvent = getAbiItem({ abi: identityRegistryAbi, name: "Approval" });
const approvalForAllEvent = getAbiItem({ abi: identityRegistryAbi, name: "ApprovalForAll" });
const mandateSetEvent = getAbiItem({ abi: mandateRegistryAbi, name: "MandateSet" });
const mandateRevokedEvent = getAbiItem({ abi: mandateRegistryAbi, name: "MandateRevoked" });

const PERMISSION_EVENTS = [
  transferEvent,
  approvalEvent,
  approvalForAllEvent,
  agentKeySetEvent,
  mandateSetEvent,
  mandateRevokedEvent,
] as const;

/** A `MandateReader` over viem, reading the given contracts. */
export function viemMandateReader(options: {
  publicClient: PublicClient;
  addresses: MandateAddresses;
  /** How many `eth_getLogs` windows run at once (default 8). */
  concurrency?: number;
}): MandateReader {
  const { publicClient, concurrency = 8 } = options;
  const validationRegistry = getAddress(options.addresses.validationRegistry);
  const identityRegistry = getAddress(options.addresses.identityRegistry);
  const forwarder = getAddress(options.addresses.forwarder);
  const mandateRegistry = getAddress(options.addresses.mandateRegistry);

  const emitterOf = (address: Address): PermissionEvent["emitter"] | null => {
    const normalized = getAddress(address);
    if (normalized === identityRegistry) return "IdentityRegistry";
    if (normalized === forwarder) return "AgentRequestForwarder";
    if (normalized === mandateRegistry) return "MandateRegistry";
    return null;
  };

  const block = async (blockNumber: bigint): Promise<PinnedBlock> => {
    const b = await publicClient.getBlock({ blockNumber });
    return { number: b.number, hash: b.hash, timestamp: b.timestamp };
  };

  return {
    chainId: () => publicClient.getChainId(),

    async finalized() {
      const b = await publicClient.getBlock({ blockTag: "finalized" });
      return { number: b.number, hash: b.hash, timestamp: b.timestamp };
    },

    block,

    async mandate(agentId, at) {
      const [mandate, mandateHash, owner, setAtBlock] = await publicClient.readContract({
        address: mandateRegistry,
        abi: mandateRegistryAbi,
        functionName: "getMandate",
        args: [agentId],
        blockNumber: at,
      });
      if (mandateHash === zeroHash) return null;
      return {
        allowedTargets: mandate.allowedTargets.map((target) => getAddress(target)),
        allowedSelectors: [...mandate.allowedSelectors],
        maxValuePerTx: mandate.maxValuePerTx,
        maxValuePerDay: mandate.maxValuePerDay,
        validUntil: mandate.validUntil,
        mandateHash,
        owner: getAddress(owner),
        setAtBlock,
      };
    },

    async ownerOf(agentId, at) {
      const owner = await publicClient.readContract({
        address: identityRegistry,
        abi: identityRegistryAbi,
        functionName: "ownerOf",
        args: [agentId],
        blockNumber: at,
      });
      return getAddress(owner);
    },

    async agentValidations(agentId, at) {
      const hashes = await publicClient.readContract({
        address: validationRegistry,
        abi: validationRegistryAbi,
        functionName: "getAgentValidations",
        args: [agentId],
        blockNumber: at,
      });
      return [...hashes];
    },

    async status(requestHash, at) {
      const [validator, agentId, response, responseHash, tag, lastUpdate] = await publicClient.readContract({
        address: validationRegistry,
        abi: validationRegistryAbi,
        functionName: "getValidationStatus",
        args: [requestHash],
        blockNumber: at,
      });
      return { validator: getAddress(validator), agentId, response, responseHash, tag, lastUpdate };
    },

    async consumed(gate, actionHash, at) {
      let data: Hex | undefined;
      try {
        ({ data } = await publicClient.call({
          to: gate,
          data: encodeFunctionData({ abi: attestGateAbi, functionName: "consumed", args: [actionHash] }),
          gas: MANDATE_V1.consumedCallGas,
          blockNumber: at,
        }));
      } catch (error) {
        const outcome = callOutcome(error);
        if (outcome?.error === "REVERTED" || outcome?.error === "OUT_OF_GAS") return null;
        throw error;
      }
      // A call that succeeded but returned no bool (no `consumed()` at that address) throws here.
      return decodeFunctionResult({ abi: attestGateAbi, functionName: "consumed", data: data ?? "0x" });
    },

    async permissionLogs(fromBlock, toBlock, filter) {
      const windows = blockWindows(fromBlock, toBlock, MAX_LOG_BLOCK_RANGE);
      const perWindow = await mapWithConcurrency(windows, concurrency, (window) =>
        publicClient.getLogs({
          address: [identityRegistry, forwarder, mandateRegistry],
          events: PERMISSION_EVENTS,
          fromBlock: window.fromBlock,
          toBlock: window.toBlock,
        }),
      );
      const owner = getAddress(filter.owner);
      const events: Omit<PermissionEvent, "afterMandate">[] = [];
      for (const log of perWindow.flat()) {
        const emitter = emitterOf(log.address);
        let relevant = false;
        switch (log.eventName) {
          case "Transfer":
          case "Approval":
            relevant = emitter === "IdentityRegistry" && log.args.tokenId === filter.agentId;
            break;
          case "ApprovalForAll":
            relevant = emitter === "IdentityRegistry" && log.args.owner !== undefined && getAddress(log.args.owner) === owner;
            break;
          case "AgentKeySet":
            relevant = emitter === "AgentRequestForwarder" && log.args.agentId === filter.agentId;
            break;
          case "MandateSet":
          case "MandateRevoked":
            relevant = emitter === "MandateRegistry" && log.args.agentId === filter.agentId;
            break;
        }
        if (!relevant || emitter === null) continue;
        events.push({
          block: log.blockNumber,
          logIndex: log.logIndex,
          txHash: log.transactionHash,
          emitter,
          event: log.eventName,
        });
      }
      return events.sort(byBlockThenLogIndex);
    },

    async simulate({ from, to, value, data, gas }, at) {
      try {
        await publicClient.call({ account: from, to, value, data, gas, blockNumber: at });
        return { ok: true };
      } catch (error) {
        const outcome = callOutcome(error);
        if (outcome === null) throw error;
        return { ok: false, ...outcome };
      }
    },

    async responseEvidence(requestHash, timestamp, notAfter) {
      const range = await blocksWithTimestamp(async (n) => (await block(n)).timestamp, timestamp, notAfter);
      if (range === null) return null;
      let last: { block: bigint; logIndex: number; uri: string } | null = null;
      for (const window of blockWindows(range.fromBlock, range.toBlock, MAX_LOG_BLOCK_RANGE)) {
        const logs = await publicClient.getLogs({
          address: validationRegistry,
          event: validationResponseEvent,
          args: { requestHash },
          fromBlock: window.fromBlock,
          toBlock: window.toBlock,
        });
        for (const log of logs) {
          const uri = log.args.responseURI;
          if (uri === undefined || !sameHash(log.args.requestHash, requestHash)) continue;
          const here = { block: log.blockNumber, logIndex: log.logIndex, uri };
          if (last === null || byBlockThenLogIndex(last, here) < 0) last = here;
        }
      }
      return last?.uri ?? null;
    },

    async requestUri(requestHash, blockNumber) {
      const logs = await publicClient.getLogs({
        address: validationRegistry,
        event: validationRequestEvent,
        args: { requestHash },
        fromBlock: blockNumber,
        toBlock: blockNumber,
      });
      const matching = logs
        .filter((log) => log.args.requestURI !== undefined && sameHash(log.args.requestHash, requestHash))
        .map((log) => ({ block: log.blockNumber, logIndex: log.logIndex, uri: log.args.requestURI as string }))
        .sort(byBlockThenLogIndex);
      return matching.at(-1)?.uri ?? null;
    },
  };
}

function byBlockThenLogIndex(a: { block: bigint; logIndex: number }, b: { block: bigint; logIndex: number }): number {
  if (a.block !== b.block) return a.block < b.block ? -1 : 1;
  return a.logIndex - b.logIndex;
}

function sameHash(a: Hex | undefined, b: Hex): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** A failed `eth_call`'s deterministic outcome, or `null` when the failure says nothing about the call. */
type CallOutcome = { error: "REVERTED"; revertSelector: Hex | null } | { error: "INSUFFICIENT_FUNDS" | "OUT_OF_GAS"; revertSelector: null };

/**
 * Classifies a failed `eth_call` by the node's JSON-RPC error, found by walking viem's `cause` chain:
 *
 * - code 3 (execution reverted) → `REVERTED`, with the first 4 bytes of the revert data (or `null`);
 * - a message matching `/insufficient funds/i` (Monad: `-32003 "Insufficient funds for gas * price
 *   + value"`) → `INSUFFICIENT_FUNDS`;
 * - a message matching `/out of gas/i` → `OUT_OF_GAS`;
 * - anything else → `null`, and the caller rethrows.
 *
 * Only errors that carry the node's own JSON-RPC code are read: an HTTP status, a timeout or viem's
 * catch-all "unknown RPC error" (code -1) is a transport failure, never an outcome, whatever its text.
 */
function callOutcome(error: unknown): CallOutcome | null {
  const rpcErrors: Array<{ code: number; message: string; data: unknown }> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 16 && typeof current === "object" && current !== null; depth++) {
    const e = current as { code?: unknown; message?: unknown; data?: unknown; cause?: unknown };
    if (typeof e.code === "number" && e.code !== -1) {
      rpcErrors.push({ code: e.code, message: typeof e.message === "string" ? e.message : "", data: e.data });
    }
    current = e.cause;
  }

  const reverted = rpcErrors.findIndex((e) => e.code === 3);
  if (reverted >= 0) return { error: "REVERTED", revertSelector: revertSelectorOf(rpcErrors.slice(reverted)) };
  if (rpcErrors.some((e) => /insufficient funds/i.test(e.message))) return { error: "INSUFFICIENT_FUNDS", revertSelector: null };
  if (rpcErrors.some((e) => /out of gas/i.test(e.message))) return { error: "OUT_OF_GAS", revertSelector: null };
  return null;
}

/** The first 4 bytes of the first revert data found (a hex string, or `{ data: hex }`), lower-cased. */
function revertSelectorOf(errors: Array<{ data: unknown }>): Hex | null {
  for (const { data: raw } of errors) {
    const data = typeof raw === "object" && raw !== null && "data" in raw ? (raw as { data: unknown }).data : raw;
    if (typeof data === "string" && /^0x[0-9a-fA-F]*$/.test(data)) {
      return data.length >= 10 ? (data.slice(0, 10).toLowerCase() as Hex) : null;
    }
  }
  return null;
}
