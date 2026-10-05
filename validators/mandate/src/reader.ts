import {
  agentKeySetEvent,
  attestGateAbi,
  blocksWithTimestamp,
  blockWindows,
  deploymentsFor,
  identityRegistryAbi,
  mandateRegistryAbi,
  mandateRegistryAt,
  MAX_LOG_BLOCK_RANGE,
  validationRegistryAbi,
  validationRequestEvent,
  validationResponseEvent,
  type MandateRegistryEpoch,
  type ValidationStatus,
} from "@attest8004/sdk";
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAbiItem,
  getAddress,
  toHex,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { concurrencyLimit, mapWithConcurrency, type Limiter } from "./concurrency.ts";
import { MANDATE_V1 } from "./params.ts";
import type { MandateRecord, PermissionEvent, PinnedBlock, Simulation } from "./types.ts";

/**
 * The contracts `mandate-v1` reads, with the MandateRegistry's whole history (ARCHITECTURE §6): a read
 * at block `b` goes to the registry valid at `b`, and {@link mandateAddressesAt} gives the addresses at
 * one block.
 */
export interface MandateContracts {
  validationRegistry: Address;
  identityRegistry: Address;
  forwarder: Address;
  /** Ascending by `fromBlock`, as the SDK's `Deployment.mandateRegistries`. Never empty. */
  mandateRegistries: readonly MandateRegistryEpoch[];
}

/** The contracts `mandate-v1` reads at one block: the one MandateRegistry valid there. Its evidence records these. */
export interface MandateAddresses {
  validationRegistry: Address;
  identityRegistry: Address;
  forwarder: Address;
  mandateRegistry: Address;
}

/**
 * The contracts `mandate-v1` reads on `chainId`, from the SDK's recorded deployment (`DEPLOYMENTS`),
 * the whole MandateRegistry history included: what the service runs with and what `verify` recomputes
 * with. Throws for a chain with none.
 */
export function mandateContractsFor(chainId: number): MandateContracts {
  const deployment = deploymentsFor(chainId);
  return {
    validationRegistry: deployment.validationRegistry,
    identityRegistry: deployment.identityRegistry,
    forwarder: deployment.agentRequestForwarder,
    mandateRegistries: deployment.mandateRegistries,
  };
}

/**
 * The addresses at block `block`: the MandateRegistry valid there (the SDK's `mandateRegistryAt`) and
 * the other three. A verdict pinned at `P` reads and records `mandateAddressesAt(contracts, P)`. Throws
 * `MandateRegistryNotDeployedError` before the first registry.
 */
export function mandateAddressesAt(contracts: MandateContracts, block: bigint): MandateAddresses {
  return {
    validationRegistry: contracts.validationRegistry,
    identityRegistry: contracts.identityRegistry,
    forwarder: contracts.forwarder,
    mandateRegistry: mandateRegistryAt(contracts, block).address,
  };
}

/**
 * The first block any MandateRegistry in `contracts` is valid at: the earliest block `mandate-v1` ever
 * pins (there is no mandate to read before it), and the floor `verify` checks a pin against. Throws for
 * an empty history.
 */
export function firstMandateRegistryBlock(contracts: MandateContracts): bigint {
  const first = contracts.mandateRegistries[0];
  if (first === undefined) throw new Error("no MandateRegistry recorded: the history is empty");
  return first.fromBlock;
}

/** A `ValidationResponse` log: its `responseURI`, and where it is. */
export interface ResponseLog {
  uri: string;
  block: bigint;
  logIndex: number;
}

/**
 * Everything `mandate-v1` reads from the chain. Every state read takes `at`, the pinned block `P`,
 * and reads exactly that block; every log read ends at or before the block it is given. A transient
 * RPC failure (HTTP 429, a timeout, history the node no longer serves, a call answered with no hex
 * result) always throws, so it can never turn into a verdict. `viemMandateReader` is the real one;
 * callers may call its methods concurrently, and it bounds the requests it sends itself.
 */
export interface MandateReader {
  chainId(): Promise<number>;
  /** The finalized head. */
  finalized(): Promise<PinnedBlock>;
  block(number: bigint): Promise<PinnedBlock>;
  /**
   * `MandateRegistry.getMandate(agentId)` at `at`, on the registry valid at `at`; `null` when its
   * `mandateHash` is zero (never set, or revoked).
   */
  mandate(agentId: bigint, at: bigint): Promise<MandateRecord | null>;
  ownerOf(agentId: bigint, at: bigint): Promise<Address>;
  /** `getAgentValidations(agentId)` at `at`, in the registry's order. */
  agentValidations(agentId: bigint, at: bigint): Promise<Hex[]>;
  status(requestHash: Hex, at: bigint): Promise<ValidationStatus>;
  /**
   * `gate.consumed(actionHash)` at `at`, with a gas cap of `MANDATE_V1.consumedCallGas`. `null` when
   * the pinned call gives no bool, which is chain state, not an RPC failure: it reverts, runs out of
   * gas within the cap, or succeeds with hex data that doesn't decode as a bool (a gate with no code
   * returns `"0x"`). The collector counts `null` toward spend (fail closed). A transport or RPC
   * error still throws, and so does an answer with no hex result (`null`, missing, or not hex).
   */
  consumed(gate: Address, actionHash: Hex, at: bigint): Promise<boolean | null>;
  /**
   * The permission-change events in `[fromBlock, toBlock]`: the Identity Registry's `Transfer` and
   * `Approval` of token `agentId` and `ApprovalForAll` by `owner`, the forwarder's `AgentKeySet` for
   * `agentId`, and the MandateRegistry's `MandateSet`/`MandateRevoked`/`PasskeySet`/`PasskeyRotated`
   * for `agentId`, sorted by `(block, logIndex)`. The MandateRegistry read is the one valid at
   * `toBlock` only: a window straddling a registry switch reads the new registry alone (the current
   * mandate on it was set after the switch, so the old registry's events, all before it, couldn't
   * change a verdict; and whatever the old one emits after the switch governs nothing).
   */
  permissionLogs(
    fromBlock: bigint,
    toBlock: bigint,
    filter: { agentId: bigint; owner: Address },
  ): Promise<Omit<PermissionEvent, "afterMandate">[]>;
  /**
   * An `eth_call` of `call` at `at` with its explicit `gas`. It is `ok` only when the node answers
   * with hex data (`"0x"` included). Only a revert (JSON-RPC code 3), too little balance
   * (`insufficient funds`) or running out of gas are failed outcomes; any other failure throws, and
   * so does an answer with no hex result.
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

/**
 * What `verifyRequest` reads: a {@link MandateReader} that can also say which block a response landed
 * in, so `verify` can check that the evidence's pinned block is no later than its own response.
 */
export interface VerifyReader extends MandateReader {
  /** The log {@link MandateReader.responseEvidence} finds, with its block and log index; `null` when none is found. */
  responseLog(requestHash: Hex, timestamp: bigint, notAfter: bigint): Promise<ResponseLog | null>;
}

const transferEvent = getAbiItem({ abi: identityRegistryAbi, name: "Transfer" });
const approvalEvent = getAbiItem({ abi: identityRegistryAbi, name: "Approval" });
const approvalForAllEvent = getAbiItem({ abi: identityRegistryAbi, name: "ApprovalForAll" });
const mandateSetEvent = getAbiItem({ abi: mandateRegistryAbi, name: "MandateSet" });
const mandateRevokedEvent = getAbiItem({ abi: mandateRegistryAbi, name: "MandateRevoked" });
const passkeySetEvent = getAbiItem({ abi: mandateRegistryAbi, name: "PasskeySet" });
const passkeyRotatedEvent = getAbiItem({ abi: mandateRegistryAbi, name: "PasskeyRotated" });

/**
 * Every event that changes who may act for an agent or what it may do. The MandateRegistry's
 * `InboxKeySet` isn't one: it moves no funds and grants no rights. Only a v2 registry emits the passkey
 * events, so they can appear only in evidence pinned on one, under the same `mandate-v1` tag.
 */
const PERMISSION_EVENTS = [
  transferEvent,
  approvalEvent,
  approvalForAllEvent,
  agentKeySetEvent,
  mandateSetEvent,
  mandateRevokedEvent,
  passkeySetEvent,
  passkeyRotatedEvent,
] as const;

/**
 * A `MandateReader` over viem, reading the given contracts. It is also the `VerifyReader` `verify`
 * runs on: `responseEvidence` is `responseLog`'s URI.
 *
 * - **The registry valid at the block.** `mandate()` reads the MandateRegistry valid at `at`, and
 *   `permissionLogs()` the one valid at `toBlock` (`P`), from `contracts.mandateRegistries`. A block
 *   before the first registry throws `MandateRegistryNotDeployedError` before any request.
 * - **One RPC budget.** Every JSON-RPC request this reader sends, from any method and any number of
 *   concurrent callers (the collector reads spend and permission logs side by side), goes through
 *   one first-in, first-out limiter of `concurrency` requests (default 8), so a rate-limited public
 *   RPC never sees more than that many at once. Pass `limit` (e.g. a {@link concurrencyLimit} shared
 *   with another reader) to use that limiter instead of making one from `concurrency`, so several
 *   readers can share one RPC budget; `concurrency` is then ignored.
 * - **Raw `eth_call`, so CCIP-Read never runs.** Every state read, `consumed()` and `simulate()` is a
 *   plain `eth_call` request at `P`, never viem's `call`/`readContract`. Those follow an EIP-3668
 *   `OffchainLookup` revert: they fetch the URLs the revert names and call the contract back at
 *   `latest`, without `from`, `value` or `gas`. That would make an outcome depend on an HTTP server
 *   and on `latest` instead of `P` (so `verify` could disagree), turn a revert into a success, and let
 *   whoever controls a call target make this process send requests to URLs of their choosing.
 * - **Only a hex answer is chain state.** viem's transports resolve an `eth_call` answered with
 *   `result: null`, with neither `result` nor `error`, or (over HTTP) with an empty 200 body, as
 *   that missing value instead of throwing. Every raw `eth_call` here throws unless the answer is a
 *   `0x` hex string of whole bytes, so a broken answer is an RPC failure (retried; `verify` exits 2),
 *   never a successful simulation, an unknown `consumed()` or a decoded registry value.
 */
export function viemMandateReader(options: {
  publicClient: PublicClient;
  contracts: MandateContracts;
  /** The most JSON-RPC requests in flight at once, across every method (default 8). Ignored when `limit` is given. */
  concurrency?: number;
  /** A limiter to use instead of making one from `concurrency`, e.g. to share one RPC budget across several readers. */
  limit?: Limiter;
}): VerifyReader {
  const { publicClient, concurrency = 8 } = options;
  const limited = options.limit ?? concurrencyLimit(concurrency);
  const { contracts } = options;
  const validationRegistry = getAddress(contracts.validationRegistry);
  const identityRegistry = getAddress(contracts.identityRegistry);
  const forwarder = getAddress(contracts.forwarder);
  /** The MandateRegistry valid at block `at` (throws before the first one). */
  const mandateRegistryAtBlock = (at: bigint): Address => getAddress(mandateRegistryAt(contracts, at).address);

  const emitterOf = (address: Address, mandateRegistry: Address): PermissionEvent["emitter"] | null => {
    const normalized = getAddress(address);
    if (normalized === identityRegistry) return "IdentityRegistry";
    if (normalized === forwarder) return "AgentRequestForwarder";
    if (normalized === mandateRegistry) return "MandateRegistry";
    return null;
  };

  const block = async (blockNumber: bigint): Promise<PinnedBlock> => {
    const b = await limited(() => publicClient.getBlock({ blockNumber }));
    return { number: b.number, hash: b.hash, timestamp: b.timestamp };
  };

  /**
   * One raw `eth_call` at block `at` (see above: never viem's `call`). Errors are the node's,
   * unwrapped. An answer with no hex result throws here (see above), before any caller reads it.
   */
  const ethCall = async (
    call: { to: Address; data: Hex; from?: Address; value?: bigint; gas?: bigint },
    at: bigint,
  ): Promise<Hex> => {
    const result: unknown = await limited(() =>
      publicClient.request({
        method: "eth_call",
        params: [
          {
            to: call.to,
            data: call.data,
            ...(call.from !== undefined ? { from: call.from } : {}),
            ...(call.value !== undefined ? { value: toHex(call.value) } : {}),
            ...(call.gas !== undefined ? { gas: toHex(call.gas) } : {}),
          },
          toHex(at),
        ],
      }),
    );
    if (!isCallResult(result)) throw new Error(MALFORMED_CALL_ANSWER);
    return result;
  };

  const responseLog = async (requestHash: Hex, timestamp: bigint, notAfter: bigint): Promise<ResponseLog | null> => {
    const range = await blocksWithTimestamp(async (n) => (await block(n)).timestamp, timestamp, notAfter);
    if (range === null) return null;
    let last: ResponseLog | null = null;
    for (const window of blockWindows(range.fromBlock, range.toBlock, MAX_LOG_BLOCK_RANGE)) {
      const logs = await limited(() =>
        publicClient.getLogs({
          address: validationRegistry,
          event: validationResponseEvent,
          args: { requestHash },
          fromBlock: window.fromBlock,
          toBlock: window.toBlock,
        }),
      );
      for (const log of logs) {
        const uri = log.args.responseURI;
        if (uri === undefined || !sameHash(log.args.requestHash, requestHash)) continue;
        const here = { uri, block: log.blockNumber, logIndex: log.logIndex };
        if (last === null || byBlockThenLogIndex(last, here) < 0) last = here;
      }
    }
    return last;
  };

  return {
    chainId: () => limited(() => publicClient.getChainId()),

    async finalized() {
      const b = await limited(() => publicClient.getBlock({ blockTag: "finalized" }));
      return { number: b.number, hash: b.hash, timestamp: b.timestamp };
    },

    block,

    async mandate(agentId, at) {
      const data = await ethCall(
        {
          to: mandateRegistryAtBlock(at),
          data: encodeFunctionData({ abi: mandateRegistryAbi, functionName: "getMandate", args: [agentId] }),
        },
        at,
      );
      const [mandate, mandateHash, owner, setAtBlock] = decodeFunctionResult({
        abi: mandateRegistryAbi,
        functionName: "getMandate",
        data,
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
      const data = await ethCall(
        { to: identityRegistry, data: encodeFunctionData({ abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId] }) },
        at,
      );
      return getAddress(decodeFunctionResult({ abi: identityRegistryAbi, functionName: "ownerOf", data }));
    },

    async agentValidations(agentId, at) {
      const data = await ethCall(
        {
          to: validationRegistry,
          data: encodeFunctionData({ abi: validationRegistryAbi, functionName: "getAgentValidations", args: [agentId] }),
        },
        at,
      );
      return [...decodeFunctionResult({ abi: validationRegistryAbi, functionName: "getAgentValidations", data })];
    },

    async status(requestHash, at) {
      const data = await ethCall(
        {
          to: validationRegistry,
          data: encodeFunctionData({ abi: validationRegistryAbi, functionName: "getValidationStatus", args: [requestHash] }),
        },
        at,
      );
      const [validator, agentId, response, responseHash, tag, lastUpdate] = decodeFunctionResult({
        abi: validationRegistryAbi,
        functionName: "getValidationStatus",
        data,
      });
      return { validator: getAddress(validator), agentId, response, responseHash, tag, lastUpdate };
    },

    async consumed(gate, actionHash, at) {
      let data: Hex;
      try {
        data = await ethCall(
          {
            to: gate,
            data: encodeFunctionData({ abi: attestGateAbi, functionName: "consumed", args: [actionHash] }),
            gas: MANDATE_V1.consumedCallGas,
          },
          at,
        );
      } catch (error) {
        const outcome = callOutcome(error);
        if (outcome?.error === "REVERTED" || outcome?.error === "OUT_OF_GAS") return null;
        throw error;
      }
      // `ethCall` only returns well-formed hex. A call that succeeded but returned no bool (no code at
      // that address, or no `consumed()`) is chain state at P, so it is unknown rather than a failure:
      // verify must reach the same answer.
      try {
        return decodeFunctionResult({ abi: attestGateAbi, functionName: "consumed", data });
      } catch {
        return null;
      }
    },

    async permissionLogs(fromBlock, toBlock, filter) {
      const mandateRegistry = mandateRegistryAtBlock(toBlock);
      const windows = blockWindows(fromBlock, toBlock, MAX_LOG_BLOCK_RANGE);
      // The limiter bounds the requests; mapping at the same width also stops new windows after a failure.
      const perWindow = await mapWithConcurrency(windows, concurrency, (window) =>
        limited(() =>
          publicClient.getLogs({
            address: [identityRegistry, forwarder, mandateRegistry],
            events: PERMISSION_EVENTS,
            fromBlock: window.fromBlock,
            toBlock: window.toBlock,
          }),
        ),
      );
      const owner = getAddress(filter.owner);
      const events: Omit<PermissionEvent, "afterMandate">[] = [];
      for (const log of perWindow.flat()) {
        const emitter = emitterOf(log.address, mandateRegistry);
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
          case "PasskeySet":
          case "PasskeyRotated":
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
        await ethCall({ from, to, value, data, gas }, at);
        return { ok: true };
      } catch (error) {
        const outcome = callOutcome(error);
        if (outcome === null) throw error;
        return { ok: false, ...outcome };
      }
    },

    async responseEvidence(requestHash, timestamp, notAfter) {
      return (await responseLog(requestHash, timestamp, notAfter))?.uri ?? null;
    },

    responseLog,

    async requestUri(requestHash, blockNumber) {
      const logs = await limited(() =>
        publicClient.getLogs({
          address: validationRegistry,
          event: validationRequestEvent,
          args: { requestHash },
          fromBlock: blockNumber,
          toBlock: blockNumber,
        }),
      );
      const matching = logs
        .filter((log) => log.args.requestURI !== undefined && sameHash(log.args.requestHash, requestHash))
        .map((log) => ({ block: log.blockNumber, logIndex: log.logIndex, uri: log.args.requestURI as string }))
        .sort(byBlockThenLogIndex);
      return matching.at(-1)?.uri ?? null;
    },
  };
}

/**
 * The error for an `eth_call` answer that carries no hex result. It has no JSON-RPC code, so no
 * caller classifies it as a revert or another outcome: it is an RPC failure, retried like any other.
 */
const MALFORMED_CALL_ANSWER = "eth_call answered with no hex result: a malformed RPC answer, not chain state";

/**
 * Whether an `eth_call` answer is call data: a string of `0x` and whole bytes (`"0x"` included, the
 * answer for an address with no code). That is the only shape a node returns for a call that ran.
 */
function isCallResult(value: unknown): value is Hex {
  return typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
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
 * Classifies a failed raw `eth_call` by the node's JSON-RPC error, found by walking the `cause` chain
 * of the error viem's transport threw:
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
