import { encodeFunctionData, type Abi, type Address, type Hash, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from "viem";

/** The node's current estimate is above the explicit limit, so nothing was sent. */
export class GasLimitTooLowError extends Error {
  readonly label: string;
  readonly estimate: bigint;
  readonly limit: bigint;

  constructor(label: string, estimate: bigint, limit: bigint) {
    super(`${label}: estimate ${estimate} is above the explicit gas limit ${limit}; raise the limit`);
    this.name = "GasLimitTooLowError";
    this.label = label;
    this.estimate = estimate;
    this.limit = limit;
  }
}

/**
 * A transaction's gas limit: either a literal, or an evidence-sized policy whose limit is computed
 * from a fresh estimate — `min(max, ceil(estimate * (100 + headroomPercent) / 100))` — because an
 * evidence-carrying response's size (and so its gas) varies with the validator's own findings.
 */
export type GasLimit = bigint | { headroomPercent: number; max: bigint };

export interface GasGuardedWrite {
  publicClient: PublicClient;
  /** Must carry the sending account. */
  walletClient: WalletClient;
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** The gas limit sent with the transaction. Monad charges for the limit, not the gas used. */
  gasLimit: GasLimit;
  /** Names the transaction in errors. */
  label: string;
  /**
   * Stops the write if aborted before the transaction is broadcast (checked right before sending); once it is sent,
   * it can't be recalled. A caller that gives up waiting aborts it, so a late send can't take the key's next nonce.
   */
  signal?: AbortSignal;
}

/**
 * Sends a contract call with an explicit gas limit, the way every Attest8004 transaction is sent:
 * simulate it (so a revert surfaces by name and nothing is sent), ask the node for an estimate,
 * resolve `gasLimit` against that estimate (refusing to send if it is above the limit, or above a
 * policy's `max`), send with `gas: <the resolved limit>`, and wait for a successful receipt. Monad
 * charges the full limit even for a reverted transaction, hence the checks first. Fees and the nonce
 * are set here too: otherwise viem asks the node to fill them with eth_fillTransaction and takes the
 * node's `gas` from the result.
 */
export async function writeWithGasGuard(write: GasGuardedWrite): Promise<{
  hash: Hash;
  receipt: TransactionReceipt;
  estimate: bigint;
  gasLimit: bigint;
}> {
  const prepared = await prepareGuardedWrite(write);
  const fees = await feesAndNonce(write.publicClient, prepared.from);
  const hash = await broadcastPrepared(write.walletClient, prepared, fees, write.signal);
  return { hash, receipt: await successfulReceipt(write.publicClient, hash, write.label), estimate: prepared.estimate, gasLimit: prepared.gasLimit };
}

/** A write that passed its simulation and estimate, with its resolved limit: ready to broadcast at any nonce. */
export interface PreparedWrite {
  call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] };
  from: Address;
  estimate: bigint;
  gasLimit: bigint;
  label: string;
}

/**
 * The checks `writeWithGasGuard` makes before sending: simulate (a revert surfaces by name, nothing is sent), estimate,
 * resolve the limit. Split out so a caller can prepare several writes, then broadcast them back to back on consecutive
 * nonces before awaiting any receipt (P12, AUD-01: `Attest8004Client.requestValidation`).
 */
export async function prepareGuardedWrite(write: Omit<GasGuardedWrite, "signal">): Promise<PreparedWrite> {
  const { publicClient, walletClient, address, abi, functionName, args, gasLimit, label } = write;
  const account = walletClient.account;
  if (!account) throw new Error(`${label}: the wallet client has no account`);
  // viem's call types are generic over the ABI; this helper takes any ABI, so the call is untyped
  // here. The simulation and estimate use the bare address: given a local account, viem would
  // prepare a whole transaction for them, asking the node to fill it.
  const call = { address, abi, functionName, args };
  await publicClient.simulateContract({ ...call, account: account.address } as never);
  const estimate = await publicClient.estimateContractGas({ ...call, account: account.address } as never);
  return { call, from: account.address, estimate, gasLimit: resolveGasLimit(gasLimit, estimate, label), label };
}

/** Broadcasts a prepared write with explicit fees and nonce (so viem fills nothing from the node); returns its hash. */
export async function broadcastPrepared(
  walletClient: WalletClient,
  prepared: PreparedWrite,
  fees: { chainId: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; nonce: number },
  signal?: AbortSignal,
): Promise<Hash> {
  const account = walletClient.account;
  if (!account) throw new Error(`${prepared.label}: the wallet client has no account`);
  if (signal?.aborted) throw new Error(`${prepared.label}: aborted before sending`);
  return walletClient.writeContract({
    ...prepared.call,
    account,
    chain: walletClient.chain,
    gas: prepared.gasLimit,
    ...fees,
  } as never);
}

/**
 * Resolves a `GasLimit` against a fresh estimate. A literal keeps today's behavior: the limit
 * itself, refusing if the estimate is above it. A policy sizes the limit to the estimate plus
 * headroom (rounded up, bigint arithmetic throughout), capped at `max`, and refuses up front if the
 * estimate alone is already above `max` — so nothing is sent for a response too large to pay for.
 */
function resolveGasLimit(gasLimit: GasLimit, estimate: bigint, label: string): bigint {
  if (typeof gasLimit === "bigint") {
    if (estimate > gasLimit) throw new GasLimitTooLowError(label, estimate, gasLimit);
    return gasLimit;
  }
  const { headroomPercent, max } = gasLimit;
  if (!Number.isInteger(headroomPercent) || headroomPercent < 0) {
    throw new RangeError(`${label}: headroomPercent must be a non-negative integer, got ${headroomPercent}`);
  }
  if (estimate > max) throw new GasLimitTooLowError(label, estimate, max);
  const sized = (estimate * (100n + BigInt(headroomPercent)) + 99n) / 100n;
  return sized < max ? sized : max;
}

/** A plain value transfer with the same explicit-limit guard as `writeWithGasGuard`. */
export async function sendWithGasGuard(send: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  to: Address;
  value: bigint;
  gasLimit: bigint;
  label: string;
}): Promise<{ hash: Hash; receipt: TransactionReceipt; estimate: bigint; gasLimit: bigint }> {
  const { publicClient, walletClient, to, value, gasLimit, label } = send;
  const account = walletClient.account;
  if (!account) throw new Error(`${label}: the wallet client has no account`);
  const estimate = await publicClient.estimateGas({ account: account.address, to, value });
  if (estimate > gasLimit) throw new GasLimitTooLowError(label, estimate, gasLimit);
  const hash = await walletClient.sendTransaction({
    account,
    chain: walletClient.chain,
    to,
    value,
    gas: gasLimit,
    ...(await feesAndNonce(publicClient, account.address)),
  });
  return { hash, receipt: await successfulReceipt(publicClient, hash, label), estimate, gasLimit };
}

/**
 * Signs a prepared write locally, with explicit fees and nonce, when the wallet's account is a local one (a private
 * key): no RPC call at all, so several can be signed first and sent back to back. Null for any other account (a
 * JSON-RPC wallet signs only as it sends).
 */
export async function signPrepared(
  walletClient: WalletClient,
  prepared: PreparedWrite,
  fees: { chainId: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; nonce: number },
): Promise<Hex | null> {
  const account = walletClient.account;
  if (account?.type !== "local" || account.signTransaction === undefined) return null;
  return account.signTransaction({
    type: "eip1559",
    chainId: fees.chainId,
    nonce: fees.nonce,
    to: prepared.call.address,
    data: encodeFunctionData(prepared.call as never),
    value: 0n,
    gas: prepared.gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
}

// With the chain id, nonce, fees and gas all set, viem fills nothing from the node.
export async function feesAndNonce(publicClient: PublicClient, address: Address) {
  const [chainId, { maxFeePerGas, maxPriorityFeePerGas }, nonce] = await Promise.all([
    publicClient.getChainId(),
    publicClient.estimateFeesPerGas(),
    publicClient.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  return { chainId, maxFeePerGas, maxPriorityFeePerGas, nonce };
}

/**
 * Waits for `hash`'s receipt and requires success. A transaction replaced by another one at the same nonce (viem
 * then returns the replacement's receipt) is a failed send unless it was only repriced: otherwise another
 * transaction's success, such as a late send from the same key, would be taken for this one's.
 */
export async function successfulReceipt(publicClient: PublicClient, hash: Hash, label: string) {
  let replaced: { reason: string; by: Hash } | undefined;
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    onReplaced: (replacement) => {
      replaced = { reason: replacement.reason, by: replacement.transaction.hash };
    },
  });
  if (replaced !== undefined && replaced.reason !== "repriced") {
    throw new Error(`${label}: transaction ${hash} was ${replaced.reason} by ${replaced.by}`);
  }
  if (receipt.status !== "success") throw new Error(`${label}: transaction ${hash} reverted`);
  return receipt;
}
