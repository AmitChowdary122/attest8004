import { deploymentsFor, identityRegistryAbi, reputationRegistryAbi } from "@attest8004/sdk";
import {
  concurrencyLimit,
  mandateAddressesAt,
  mandateContractsFor,
  viemMandateReader,
  type MandateAddresses,
  type MandateContracts,
  type VerifyReader,
} from "@attest8004/validator-mandate";
import { decodeFunctionResult, encodeFunctionData, getAddress, toHex, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import type { CallFrame, TraceResult } from "./trace.ts";

/**
 * The contracts `risk-v1` reads: `mandate-v1`'s, with the MandateRegistry history, plus the canonical
 * ERC-8004 ReputationRegistry.
 */
export type RiskContracts = MandateContracts & { reputationRegistry: Address };

/**
 * The contracts `risk-v1` reads at one block: `mandate-v1`'s four (the MandateRegistry valid there),
 * plus the ReputationRegistry. Its evidence records these (`params.contracts`).
 */
export interface RiskAddresses extends MandateAddresses {
  reputationRegistry: Address;
}

/**
 * The contracts `risk-v1` reads on `chainId` (the SDK's `DEPLOYMENTS`): `mandate-v1`'s, the whole
 * MandateRegistry history included, plus `reputationRegistry`. Throws for a chain with none (same as
 * `mandateContractsFor`).
 */
export function riskContractsFor(chainId: number): RiskContracts {
  const mandate = mandateContractsFor(chainId);
  const { reputationRegistry } = deploymentsFor(chainId);
  return { ...mandate, reputationRegistry };
}

/**
 * The addresses at block `block` (`mandate-v1`'s `mandateAddressesAt`, plus the ReputationRegistry):
 * what a verdict pinned there records. Throws `MandateRegistryNotDeployedError` before the first
 * MandateRegistry.
 */
export function riskAddressesAt(contracts: RiskContracts, block: bigint): RiskAddresses {
  return { ...mandateAddressesAt(contracts, block), reputationRegistry: contracts.reputationRegistry };
}

/**
 * Everything `risk-v1` reads from the chain beyond `mandate-v1`'s own reads (which it also has, via
 * `VerifyReader` — `verify` needs `responseLog`). Every method reads exactly the pinned block `at`
 * given; a transient RPC failure (HTTP 429, a timeout, an answer with no hex result) always throws, so
 * it can never turn into a tool output or a verdict.
 */
export interface RiskReader extends VerifyReader {
  /**
   * `debug_traceCall` with `{tracer: "callTracer"}` of `call` at `at`: `{from, to, value, data, gas}`,
   * sent as `[{from, to, value: "0x…", data, gas: "0x…"}, "0x<at>", {tracer: "callTracer"}]`. Resolves
   * to `{ok: false, error: "INSUFFICIENT_FUNDS"}` only for JSON-RPC `-32003`; every other RPC or
   * transport failure throws. A revert inside the call is not a `trace()` failure: it comes back as a
   * normal frame with its own `error`/`output` (see {@link import("./trace.ts").flattenTrace}).
   */
  trace(call: { from: Address; to: Address; value: bigint; data: Hex; gas: bigint }, at: bigint): Promise<TraceResult>;
  /** `eth_getCode(address, at)`: `"0x"` for an address with no code. */
  code(address: Address, at: bigint): Promise<Hex>;
  /** `eth_getBalance(address, at)`. */
  balance(address: Address, at: bigint): Promise<bigint>;
  /** `eth_getTransactionCount(address, at)`. */
  nonce(address: Address, at: bigint): Promise<bigint>;
  /** The Identity Registry's `ownerOf(agentId)` at `at`; `null` only for a revert (e.g. no such agent). */
  agentOwner(agentId: bigint, at: bigint): Promise<Address | null>;
  /**
   * The Identity Registry's `balanceOf(address)` at `at`: how many agents it owns. `null` only for a
   * revert (e.g. `balanceOf(address(0))`'s `ERC721InvalidOwner` — address zero can enter scope from
   * any trace frame) — every other failure still throws.
   */
  agentsOwned(address: Address, at: bigint): Promise<bigint | null>;
  /** The ReputationRegistry's `getClients(agentId)` at `at`. */
  reputationClients(agentId: bigint, at: bigint): Promise<Address[]>;
  /**
   * The ReputationRegistry's `getSummary(agentId, clients, "", "")` at `at`. Callers must not pass an
   * empty `clients`: the contract reverts (`"clientAddresses required"`), and this throws like any
   * other revert here (it is `erc8004_reputation`'s job to skip the call when there are no clients).
   */
  reputationSummary(agentId: bigint, clients: Address[], at: bigint): Promise<{ count: bigint; value: bigint; decimals: number }>;
}

/** The error for a raw request answered with no usable hex result: an RPC failure, never chain state. */
const MALFORMED_ANSWER = "risk-v1 reader: RPC answered with no hex result: a malformed RPC answer, not chain state";

/** The error for a `debug_traceCall` answer that isn't a callTracer frame. */
const MALFORMED_TRACE_ANSWER = "risk-v1 reader: debug_traceCall answered with no callTracer frame: a malformed RPC answer";

/** A hex string of whole bytes (`eth_call`/`eth_getCode`'s DATA encoding; `"0x"` included). */
function isCallResult(value: unknown): value is Hex {
  return typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
}

/** Any hex string (`eth_getBalance`/`eth_getTransactionCount`'s QUANTITY encoding allows odd length). */
function isHexResult(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

/** A minimal, defensive check that a `debug_traceCall` answer is a callTracer frame, not malformed JSON. */
function isCallFrame(value: unknown): value is CallFrame {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string" && typeof (value as { from?: unknown }).from === "string";
}

/**
 * Walks the `cause` chain of an error viem's transport threw (same walk as `mandate-v1`'s
 * `callOutcome`), looking for a JSON-RPC error whose `code` matches `wanted`. Only a code the node
 * itself sent counts (never an HTTP status or viem's catch-all "unknown RPC error", code -1).
 */
function hasRpcErrorCode(error: unknown, wanted: number): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 16 && typeof current === "object" && current !== null; depth++) {
    const e = current as { code?: unknown; cause?: unknown };
    if (typeof e.code === "number" && e.code === wanted) return true;
    current = e.cause;
  }
  return false;
}

/**
 * A `RiskReader` over viem: `mandate-v1`'s own reader (`viemMandateReader`, so `risk-v1` reuses its
 * state reads, logs and `responseLog` unchanged, the MandateRegistry resolved by block from
 * `contracts`' history) plus the reads `risk-v1`'s tools need. **One RPC
 * budget**: both share one limiter of `concurrency` requests (default 8), so the two together never
 * send more than that many requests to the RPC at once (`mandate-v1`'s own "one RPC budget" doc
 * applies here unchanged). **Raw requests only**: `trace`/`code`/`balance`/`nonce` and the ERC-8004
 * reads below go straight through `publicClient.request`, never a viem action, mirroring
 * `viemMandateReader`'s own `ethCall`: only a well-formed hex answer is chain state, so a transport
 * failure or a malformed answer (`result: null`, an odd-length `eth_call`/`eth_getCode` answer, a
 * `debug_traceCall` answer with no callTracer frame) always throws instead of becoming a tool output.
 */
export function viemRiskReader(options: { publicClient: PublicClient; contracts: RiskContracts; concurrency?: number }): RiskReader {
  const { publicClient, contracts, concurrency = 8 } = options;
  const limited = concurrencyLimit(concurrency);
  const mandateReader = viemMandateReader({ publicClient, contracts, limit: limited });
  const identityRegistry = getAddress(contracts.identityRegistry);
  const reputationRegistry = getAddress(contracts.reputationRegistry);

  /** One raw `eth_call` at block `at` (never viem's `call`/`readContract`; see the module doc). */
  const ethCall = async (call: { to: Address; data: Hex; from?: Address; value?: bigint; gas?: bigint }, at: bigint): Promise<Hex> => {
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
    if (!isCallResult(result)) throw new Error(MALFORMED_ANSWER);
    return result;
  };

  /**
   * One raw request at block `at`, checked with `isValid` (`isCallResult` for `eth_getCode`'s
   * whole-bytes DATA encoding; the looser `isHexResult` for `eth_getBalance`/`eth_getTransactionCount`'s
   * QUANTITY encoding, which allows odd length). Fix round 1, finding 7: `eth_getCode` used the loose
   * check, so an odd-length answer decoded as a fractional `codeSize` and `"0x0"` silently read as
   * "has code" instead of throwing.
   */
  const rawHex = async (method: string, address: Address, at: bigint, isValid: (value: unknown) => value is Hex): Promise<Hex> => {
    const result: unknown = await limited(() => publicClient.request({ method, params: [getAddress(address), toHex(at)] } as never));
    if (!isValid(result)) throw new Error(MALFORMED_ANSWER);
    return result;
  };

  return {
    ...mandateReader,

    async trace(call, at) {
      let result: unknown;
      try {
        result = await limited(() =>
          publicClient.request({
            method: "debug_traceCall",
            params: [
              { from: getAddress(call.from), to: getAddress(call.to), value: toHex(call.value), data: call.data, gas: toHex(call.gas) },
              toHex(at),
              { tracer: "callTracer" },
            ],
          } as never),
        );
      } catch (error) {
        if (hasRpcErrorCode(error, -32003)) return { ok: false, error: "INSUFFICIENT_FUNDS" };
        throw error;
      }
      if (!isCallFrame(result)) throw new Error(MALFORMED_TRACE_ANSWER);
      return { ok: true, frame: result };
    },

    code: (address, at) => rawHex("eth_getCode", address, at, isCallResult),
    balance: async (address, at) => BigInt(await rawHex("eth_getBalance", address, at, isHexResult)),
    nonce: async (address, at) => BigInt(await rawHex("eth_getTransactionCount", address, at, isHexResult)),

    async agentOwner(agentId, at) {
      try {
        const data = await ethCall(
          { to: identityRegistry, data: encodeFunctionData({ abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId] }) },
          at,
        );
        return getAddress(decodeFunctionResult({ abi: identityRegistryAbi, functionName: "ownerOf", data }));
      } catch (error) {
        if (hasRpcErrorCode(error, 3)) return null;
        throw error;
      }
    },

    async agentsOwned(address, at) {
      try {
        const data = await ethCall(
          { to: identityRegistry, data: encodeFunctionData({ abi: identityRegistryAbi, functionName: "balanceOf", args: [address] }) },
          at,
        );
        return decodeFunctionResult({ abi: identityRegistryAbi, functionName: "balanceOf", data });
      } catch (error) {
        if (hasRpcErrorCode(error, 3)) return null;
        throw error;
      }
    },

    async reputationClients(agentId, at) {
      const data = await ethCall(
        { to: reputationRegistry, data: encodeFunctionData({ abi: reputationRegistryAbi, functionName: "getClients", args: [agentId] }) },
        at,
      );
      const clients = decodeFunctionResult({ abi: reputationRegistryAbi, functionName: "getClients", data });
      return clients.map((a) => getAddress(a));
    },

    async reputationSummary(agentId, clients, at) {
      const data = await ethCall(
        {
          to: reputationRegistry,
          data: encodeFunctionData({ abi: reputationRegistryAbi, functionName: "getSummary", args: [agentId, clients, "", ""] }),
        },
        at,
      );
      const [count, value, decimals] = decodeFunctionResult({ abi: reputationRegistryAbi, functionName: "getSummary", data });
      return { count, value, decimals };
    },
  };
}

/** How far back the service checks that its RPC serves state: `RISK_V1.ageProbeBlocks`' deepest probe. */
const HISTORY_CHECK_BLOCKS = 2_000_000n;

/**
 * The `risk-v1` service's RPC checks before it polls (final review A4): one `debug_traceCall` of a
 * trivial call (the zero address to itself, value 0, gas 21,000) at `latest` with
 * `{tracer: "callTracer"}`, which must answer a callTracer frame (`simulate_action` needs it); then one
 * `eth_getCode` of the Identity Registry at the head minus 2,000,000 blocks (block 0 for a younger
 * chain), which must answer whole-byte hex, empty included (the deepest age probe of
 * `counterparty_onchain`, and `verify`'s re-runs, read that far back). Either failing throws our own
 * fixed text, with no `cause`: never the RPC's URL, which can carry a key, nor its error. A failure to
 * read the head itself propagates as viem's error, as the service's other startup reads do. Resolves
 * with the block the history check read.
 */
export async function checkRpcServesRiskV1(publicClient: PublicClient, identityRegistry: Address): Promise<{ historyBlock: bigint }> {
  let frame: unknown;
  try {
    frame = await publicClient.request({
      method: "debug_traceCall",
      params: [{ from: zeroAddress, to: zeroAddress, value: "0x0", gas: toHex(21_000n) }, "latest", { tracer: "callTracer" }],
    } as never);
  } catch {
    frame = undefined;
  }
  if (!isCallFrame(frame)) throw new Error("the RPC must serve debug_traceCall (callTracer)");

  const head = BigInt(await publicClient.request({ method: "eth_blockNumber" }));
  const historyBlock = head > HISTORY_CHECK_BLOCKS ? head - HISTORY_CHECK_BLOCKS : 0n;
  let code: unknown;
  try {
    code = await publicClient.request({ method: "eth_getCode", params: [getAddress(identityRegistry), toHex(historyBlock)] } as never);
  } catch {
    code = undefined;
  }
  if (!isCallResult(code)) throw new Error("the RPC must serve state 2,000,000 blocks back");
  return { historyBlock };
}
