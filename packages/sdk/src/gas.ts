import type { Abi, Address, Hash, PublicClient, TransactionReceipt, WalletClient } from "viem";

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

export interface GasGuardedWrite {
  publicClient: PublicClient;
  /** Must carry the sending account. */
  walletClient: WalletClient;
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** The literal gas limit sent with the transaction. Monad charges for the limit, not the gas used. */
  gasLimit: bigint;
  /** Names the transaction in errors. */
  label: string;
}

/**
 * Sends a contract call with an explicit gas limit, the way every Attest8004 transaction is sent:
 * simulate it (so a revert surfaces by name and nothing is sent), ask the node for an estimate and
 * refuse to send if it is above `gasLimit`, send with `gas: gasLimit`, and wait for a successful
 * receipt. Monad charges the full limit even for a reverted transaction, hence the checks first.
 * Fees and the nonce are set here too: otherwise viem asks the node to fill them with
 * eth_fillTransaction and takes the node's `gas` from the result.
 */
export async function writeWithGasGuard(write: GasGuardedWrite): Promise<{
  hash: Hash;
  receipt: TransactionReceipt;
  estimate: bigint;
  gasLimit: bigint;
}> {
  const { publicClient, walletClient, address, abi, functionName, args, gasLimit, label } = write;
  const account = walletClient.account;
  if (!account) throw new Error(`${label}: the wallet client has no account`);
  // viem's call types are generic over the ABI; this helper takes any ABI, so the call is untyped
  // here. The simulation and estimate use the bare address: given a local account, viem would
  // prepare a whole transaction for them, asking the node to fill it.
  const call = { address, abi, functionName, args };

  await publicClient.simulateContract({ ...call, account: account.address } as never);
  const estimate = await publicClient.estimateContractGas({ ...call, account: account.address } as never);
  if (estimate > gasLimit) throw new GasLimitTooLowError(label, estimate, gasLimit);

  const hash = await walletClient.writeContract({
    ...call,
    account,
    chain: walletClient.chain,
    gas: gasLimit,
    ...(await feesAndNonce(publicClient, account.address)),
  } as never);
  return { hash, receipt: await successfulReceipt(publicClient, hash, label), estimate, gasLimit };
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

// With the chain id, nonce, fees and gas all set, viem fills nothing from the node.
async function feesAndNonce(publicClient: PublicClient, address: Address) {
  const [chainId, { maxFeePerGas, maxPriorityFeePerGas }, nonce] = await Promise.all([
    publicClient.getChainId(),
    publicClient.estimateFeesPerGas(),
    publicClient.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  return { chainId, maxFeePerGas, maxPriorityFeePerGas, nonce };
}

async function successfulReceipt(publicClient: PublicClient, hash: Hash, label: string) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label}: transaction ${hash} reverted`);
  return receipt;
}
