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
import { broadcastPrepared, feesAndNonce, prepareGuardedWrite, signPrepared, successfulReceipt, type PreparedWrite } from "./gas.ts";
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

/**
 * A request's `requestHash` is already in the registry under another agent or validator (P12, AUD-01). The registry
 * keys requests by hash alone, and a landed request reveals every other validator's hash for the same action, so
 * anyone who owns an agent can claim one first. Nothing can be done for this action: re-salt it and request again.
 */
export class RequestSquattedError extends Error {
  readonly requestHash: Hex;
  readonly validator: Address;
  /** The agent the registry records for the hash. */
  readonly claimedBy: bigint;

  constructor(requestHash: Hex, validator: Address, claimedBy: bigint) {
    super(
      `requestHash ${requestHash} for validator ${validator} is already claimed by agent ${claimedBy}: possibly squatted; ` +
        "re-salt the action and retry",
    );
    this.name = "RequestSquattedError";
    this.requestHash = requestHash;
    this.validator = validator;
    this.claimedBy = claimedBy;
  }
}

/**
 * A send at nonce n was rejected after the requests at later nonces had already gone out (P12 re-check, N1): they may
 * still land, unpaired, once nonce n is filled. The action is spent: re-salt it before requesting again.
 */
export class RequestSendError extends Error {
  readonly rejected: { validator: Address; requestHash: Hex; nonce: number };
  readonly alreadySent: { validator: Address; requestHash: Hex; nonce: number; txHash: Hash }[];

  constructor(cause: unknown, rejected: RequestSendError["rejected"], alreadySent: RequestSendError["alreadySent"]) {
    const why = cause instanceof BaseError ? cause.shortMessage : cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    super(
      `the request to ${rejected.validator} (nonce ${rejected.nonce}) was rejected (${why}); the request(s) to ` +
        `${alreadySent.map((s) => `${s.validator} (nonce ${s.nonce})`).join(", ")} were already sent and may still land unpaired: ` +
        "re-salt the action before requesting again",
      { cause },
    );
    this.name = "RequestSendError";
    this.rejected = rejected;
    this.alreadySent = alreadySent;
  }
}

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
  /**
   * How long `requestValidation` waits between preparing an action's requests and sending them (default 1,000 ms), so
   * a rate-limited transport's window (the scripts' 10 a second) has room to send them back to back (P12, AUD-01).
   */
  broadcastSettleMs?: number;
}

/** Between two of an action's raw request transactions: enough for nonce n to reach the node first, well under a block. */
const BROADCAST_STAGGER_MS = 20;

/** SPEC §4.4: request validations for an action, wait for verdicts, and check the gate would pass. */
export class Attest8004Client {
  private readonly options: Attest8004ClientOptions;
  private readonly gas: Record<keyof typeof DEFAULT_GAS, bigint>;

  constructor(options: Attest8004ClientOptions) {
    this.options = options;
    this.gas = { ...DEFAULT_GAS, ...options.gas };
  }

  /**
   * One `validationRequest` per validator, each with its own request JSON v1 (as a data: URI) and requestHash, with an
   * explicit gas limit. Through the forwarder when one is set (the wallet is then the agent's registered hot key), else
   * straight to the registry (the wallet is then the agent's owner or operator).
   *
   * **All at once (P12, AUD-01).** A landed request carries the whole action, so every other validator's requestHash
   * for it can be computed from that log and claimed first by anyone who owns an agent. So every request is simulated
   * and estimated first (nothing is sent if one would revert), then all are broadcast back to back on consecutive
   * nonces before any receipt is awaited: in practice they land in one block. A hash that someone else already holds,
   * found before sending or after a request reverted, is {@link RequestSquattedError}: re-salt the action and retry.
   * Requests that still land in different blocks are fine as long as each succeeded (`blockNumber` per request).
   */
  async requestValidation(args: {
    gate: Address;
    validators: readonly Address[];
    action: Action;
  }): Promise<RequestedValidation[]> {
    const { publicClient, walletClient, forwarder, validationRegistry } = this.options;
    if (!walletClient?.account) throw new Error("requestValidation needs a walletClient with an account");
    const chainId = await publicClient.getChainId();
    const requests = args.validators.map((validator) => {
      const request = buildRequestJson({ chainId, gate: args.gate, validator, action: args.action });
      return { request, requestHash: requestHashOfJson(request), uri: encodeJsonDataUri(request).uri };
    });

    const prepared: PreparedWrite[] = [];
    for (const r of requests) {
      try {
        prepared.push(
          await prepareGuardedWrite({
            publicClient,
            walletClient,
            ...(forwarder
              ? { address: forwarder, abi: agentRequestForwarderAbi, functionName: "request" }
              : { address: validationRegistry, abi: validationRegistryAbi, functionName: "validationRequest" }),
            args: [r.request.validator, args.action.agentId, r.uri, r.requestHash],
            gasLimit: forwarder ? this.gas.forwarderRequest : this.gas.validationRequest,
            label: forwarder ? "forwarder.request" : "validationRequest",
          }),
        );
      } catch (error) {
        throw (await this.squatted(r.requestHash, r.request.validator, args.action.agentId)) ?? error;
      }
    }

    const { nonce, ...fees } = await feesAndNonce(publicClient, walletClient.account.address);
    const signed = await Promise.all(prepared.map((p, i) => signPrepared(walletClient, p, { ...fees, nonce: nonce + i })));
    let hashes: Hash[];
    if (signed.every((raw): raw is Hex => raw !== null)) {
      // Signed locally: after the settle, each raw transaction goes out BROADCAST_STAGGER_MS after the one before,
      // without waiting for the node's answer, so they reach it in nonce order within a few tens of milliseconds.
      const settle = this.options.broadcastSettleMs ?? 1_000;
      if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle));
      const sends = await Promise.allSettled(
        signed.map(async (raw, i) => {
          if (i > 0) await new Promise((resolve) => setTimeout(resolve, i * BROADCAST_STAGGER_MS));
          return publicClient.sendRawTransaction({ serializedTransaction: raw });
        }),
      );
      const firstRejected = sends.findIndex((s) => s.status === "rejected");
      if (firstRejected !== -1) {
        const rejection = sends[firstRejected] as PromiseRejectedResult;
        const at = (i: number) => ({ validator: requests[i]?.request.validator as Address, requestHash: requests[i]?.requestHash as Hex, nonce: nonce + i });
        const alreadySent = sends.flatMap((s, i) => (i > firstRejected && s.status === "fulfilled" ? [{ ...at(i), txHash: s.value }] : []));
        // Nothing went out after the rejected one: an ordinary failure, as before.
        if (alreadySent.length === 0) throw rejection.reason;
        throw new RequestSendError(rejection.reason, at(firstRejected), alreadySent);
      }
      hashes = sends.map((s) => (s as PromiseFulfilledResult<Hash>).value);
    } else {
      hashes = [];
      for (const [i, p] of prepared.entries()) hashes.push(await broadcastPrepared(walletClient, p, { ...fees, nonce: nonce + i }));
    }
    const receipts = await Promise.allSettled(hashes.map((hash, i) => successfulReceipt(publicClient, hash, prepared[i]?.label ?? "request")));

    const requested: RequestedValidation[] = [];
    for (const [i, outcome] of receipts.entries()) {
      const r = requests[i];
      const hash = hashes[i];
      if (r === undefined || hash === undefined) continue;
      if (outcome.status === "rejected") {
        throw (await this.squatted(r.requestHash, r.request.validator, args.action.agentId)) ?? outcome.reason;
      }
      requested.push({
        validator: r.request.validator,
        requestHash: r.requestHash,
        requestURI: r.uri,
        request: r.request,
        txHash: hash,
        blockNumber: outcome.value.blockNumber,
      });
    }
    return requested;
  }

  /** {@link RequestSquattedError} when the registry holds `requestHash` for another agent or validator; else null. */
  private async squatted(requestHash: Hex, validator: Address, agentId: bigint): Promise<RequestSquattedError | null> {
    let held: readonly [Address, bigint, ...unknown[]];
    try {
      held = (await this.options.publicClient.readContract({
        address: this.options.validationRegistry,
        abi: validationRegistryAbi,
        functionName: "getValidationStatus",
        args: [requestHash],
      })) as unknown as readonly [Address, bigint, ...unknown[]];
    } catch {
      return null;
    }
    const [heldValidator, heldAgent] = held;
    return heldAgent !== agentId || getAddress(heldValidator) !== getAddress(validator) ? new RequestSquattedError(requestHash, validator, heldAgent) : null;
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
