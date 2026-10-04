import {
  BaseError,
  ContractFunctionRevertedError,
  getAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { agentRequestForwarderAbi, attestGateAbi, validationRegistryAbi, validationResponseEvent } from "./abi.ts";
import { computeActionHash, computeRequestHash, type Action } from "./action.ts";
import { writeWithGasGuard } from "./gas.ts";
import { blockWindows } from "./logs.ts";
import { buildRequestJson, encodeJsonDataUri, requestHashOfJson, type RequestJsonV1 } from "./request.ts";

/**
 * Explicit gas limits for request transactions (Monad charges for the limit), from Monad testnet
 * eth_estimateGas x 1.2, rounded up to 1k. `validationRequest`: 202,643 for a request JSON v1
 * data: URI (P2, 3 Oct 2026). `forwarderRequest`: 251,331 to 262,217 for the first request of demo
 * agents 1984 and 1985 (3 Oct 2026); an agent's first request is its most expensive. Every send
 * re-checks the node's estimate against the limit first, and refuses to send if it is above.
 */
export const DEFAULT_GAS = {
  forwarderRequest: 315_000n,
  validationRequest: 244_000n,
} as const;

export interface RequestedValidation {
  validator: Address;
  requestHash: Hex;
  requestURI: string;
  request: RequestJsonV1;
  txHash: Hash;
  blockNumber: bigint;
}

export interface Verdict {
  validator: Address;
  agentId: bigint;
  requestHash: Hex;
  response: number;
  responseURI: string;
  responseHash: Hex;
  tag: string;
  blockNumber: bigint;
  txHash: Hash;
}

/**
 * `getValidationStatus` with `tag` declared `bytes` instead of `string` (the same ABI encoding —
 * a length-prefixed byte string either way). Decoding `tag` as `string` would run it through
 * viem's `bytesToString`, which uses `TextDecoder` and so silently strips a leading UTF-8 BOM and
 * replaces invalid UTF-8 with U+FFFD. `AttestGate._checkVerdict` has no such step: it hashes the
 * stored bytes directly (`keccak256(bytes(tag))`, and `bytes(tag)` on a Solidity `string` is
 * exactly its stored bytes, never reinterpreted). Reading `tag` as raw bytes here keeps
 * `isValidated` byte-exact with that: hashing a decoded-then-re-encoded JS string instead could
 * accept a tag onchain that doesn't actually hash to the requirement's `tagHash`.
 */
const validationStatusRawTagAbi = parseAbi([
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, bytes tag, uint256 lastUpdate)",
  "error UnknownRequest(bytes32 requestHash)",
]);

export interface Attest8004ClientOptions {
  publicClient: PublicClient;
  /** Needed only to send requests. With a forwarder, its account is the agent's hot key. */
  walletClient?: WalletClient;
  validationRegistry: Address;
  /** When set, requests go through `AgentRequestForwarder.request` instead of the registry. */
  forwarder?: Address;
  gas?: Partial<Record<keyof typeof DEFAULT_GAS, bigint>>;
}

/** SPEC §4.4: request validations for an action, wait for verdicts, and check the gate would pass. */
export class Attest8004Client {
  private readonly options: Attest8004ClientOptions;
  private readonly gas: Record<keyof typeof DEFAULT_GAS, bigint>;

  constructor(options: Attest8004ClientOptions) {
    this.options = options;
    this.gas = { ...DEFAULT_GAS, ...options.gas };
  }

  /**
   * One `validationRequest` per validator, each with its own request JSON v1 (as a data: URI) and
   * requestHash, sent in order with an explicit gas limit. Through the forwarder when one is set
   * (the wallet is then the agent's registered hot key), else straight to the registry (the wallet
   * is then the agent's owner or operator).
   */
  async requestValidation(args: {
    gate: Address;
    validators: readonly Address[];
    action: Action;
  }): Promise<RequestedValidation[]> {
    const { publicClient, walletClient, forwarder, validationRegistry } = this.options;
    if (!walletClient?.account) throw new Error("requestValidation needs a walletClient with an account");
    const chainId = await publicClient.getChainId();
    const requested: RequestedValidation[] = [];
    for (const validator of args.validators) {
      const request = buildRequestJson({ chainId, gate: args.gate, validator, action: args.action });
      const requestHash = requestHashOfJson(request);
      const { uri } = encodeJsonDataUri(request);
      const sent = await writeWithGasGuard({
        publicClient,
        walletClient,
        ...(forwarder
          ? { address: forwarder, abi: agentRequestForwarderAbi, functionName: "request" }
          : { address: validationRegistry, abi: validationRegistryAbi, functionName: "validationRequest" }),
        args: [request.validator, args.action.agentId, uri, requestHash],
        gasLimit: forwarder ? this.gas.forwarderRequest : this.gas.validationRequest,
        label: forwarder ? "forwarder.request" : "validationRequest",
      });
      requested.push({
        validator: request.validator,
        requestHash,
        requestURI: uri,
        request,
        txHash: sent.hash,
        blockNumber: sent.receipt.blockNumber,
      });
    }
    return requested;
  }

  /**
   * Waits for the first `ValidationResponse` for `requestHash`, scanning from `fromBlock` (the
   * request's block) in windows the RPC accepts. A response of 0 is a verdict, not "pending".
   */
  async awaitVerdict(args: {
    requestHash: Hex;
    fromBlock: bigint;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<Verdict> {
    const { publicClient, validationRegistry } = this.options;
    const { requestHash, timeoutMs = 120_000, pollIntervalMs = 1_000 } = args;
    const giveUpAt = Date.now() + timeoutMs;
    let next = args.fromBlock;
    for (;;) {
      const head = await publicClient.getBlockNumber({ cacheTime: 0 });
      for (const window of blockWindows(next, head)) {
        const [log] = await publicClient.getLogs({
          address: validationRegistry,
          event: validationResponseEvent,
          args: { requestHash },
          ...window,
        });
        if (log) {
          const { validatorAddress, agentId, response, responseURI, responseHash, tag } = log.args;
          return {
            validator: getAddress(validatorAddress as Address),
            agentId: agentId as bigint,
            requestHash,
            response: response as number,
            responseURI: responseURI as string,
            responseHash: responseHash as Hex,
            tag: tag as string,
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
          };
        }
        next = window.toBlock + 1n;
      }
      if (Date.now() >= giveUpAt) throw new Error(`no ValidationResponse for ${requestHash} within ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  /**
   * Whether `gate` would accept `action` now, checked the way AttestGate checks it: the deadline
   * against the latest block, the action not yet consumed, and for every requirement the gate
   * reports, a stored verdict naming that validator and this agent, with at least the minimum
   * score and a tag that hashes to the requirement's `tagHash`. A request that doesn't exist
   * reads as false; an RPC failure throws.
   *
   * It reads the tag-aware `requirements()` (`attestGateAbi`: `{validator, minScore, tagHash}`).
   * Against a pre-P5 gate, whose `Requirement` has two fields (`{validator, minScore}`, such as the P2
   * and P3 vaults), decoding fails and this rejects with viem's decoding error (with viem 2.57,
   * `PositionOutOfBoundsError`, or `IntegerOutOfRangeError` once a misread field is out of range,
   * wrapped in a `ContractFunctionExecutionError`): read as three words per requirement where the gate
   * returns two, the decoder always runs past the data. That is safe — it never returns a wrong
   * `true` — but such gates need their own ABI, as `scripts/src/gated-execute.ts` has.
   */
  async isValidated(args: { gate: Address; action: Action }): Promise<boolean> {
    const { publicClient } = this.options;
    const { gate, action } = args;
    const chainId = await publicClient.getChainId();
    const read = <const F extends "validationRegistry" | "requirements">(functionName: F) =>
      publicClient.readContract({ address: gate, abi: attestGateAbi, functionName });
    const [block, registry, requirements, consumed] = await Promise.all([
      publicClient.getBlock({ blockTag: "latest" }),
      read("validationRegistry"),
      read("requirements"),
      publicClient.readContract({
        address: gate,
        abi: attestGateAbi,
        functionName: "consumed",
        args: [computeActionHash({ chainId, gate, action })],
      }),
    ]);
    if (block.timestamp > action.deadline || consumed) return false;

    for (const { validator, minScore, tagHash } of requirements) {
      const requestHash = computeRequestHash({ chainId, gate, validator, action });
      let status: readonly [Address, bigint, number, Hex, Hex, bigint];
      try {
        status = await publicClient.readContract({
          address: registry,
          abi: validationStatusRawTagAbi,
          functionName: "getValidationStatus",
          args: [requestHash],
        });
      } catch (error) {
        if (isRevert(error)) return false;
        throw error;
      }
      const [storedValidator, storedAgentId, response, , tagBytes] = status;
      if (getAddress(storedValidator) !== getAddress(validator)) return false;
      if (storedAgentId !== action.agentId || response < minScore) return false;
      if (keccak256(tagBytes) !== tagHash) return false;
    }
    return true;
  }
}

function isRevert(error: unknown): boolean {
  return error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError) !== null;
}
