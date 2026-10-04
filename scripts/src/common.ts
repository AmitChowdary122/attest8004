// Shared plumbing for the P3+ scripts: environment, clients, checks and transaction lines.
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  type Account,
  type Address,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { monadTestnet } from "viem/chains";
import { rateLimitedFetch } from "./rpc-rate-limit.ts";

export const chain = monadTestnet;

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (expected in .env)`);
  return value;
}

export function requireAddress(name: string): Address {
  return getAddress(requireEnv(name));
}

const rpcUrl = requireEnv("MONAD_TESTNET_RPC_URL");
// One limiter for every client in the process (the e2e's own reads and its in-process validators share it): the
// public RPC refuses more than 15 requests a second per IP (-32011), so stay at 10 and retry a refusal.
const fetchFn = rateLimitedFetch({ requestsPerSecond: 10, retries: 6, retryDelayMs: 1_000 });
export const publicClient: PublicClient = createPublicClient({ chain, transport: http(rpcUrl, { fetchFn }) });
export const walletFor = (account: Account): WalletClient =>
  createWalletClient({ account, chain, transport: http(rpcUrl, { fetchFn }) });

export async function assertChain(): Promise<void> {
  const id = await publicClient.getChainId();
  if (id !== chain.id) throw new Error(`RPC is on chain ${id}, expected ${chain.id}`);
}

export function check(label: string, ok: boolean, detail: string): void {
  if (!ok) throw new Error(`check failed: ${label} (${detail})`);
  console.log(`  ok  ${label}`);
}

export function printTx(
  label: string,
  sent: { hash: Hash; receipt: TransactionReceipt; estimate: bigint; gasLimit: bigint },
): void {
  console.log(
    `${label.padEnd(22)} ${sent.hash}  block ${sent.receipt.blockNumber}, gas limit ${sent.gasLimit} (estimate ${sent.estimate})`,
  );
}

export const mon = (wei: bigint): string => `${formatEther(wei)} MON`;
