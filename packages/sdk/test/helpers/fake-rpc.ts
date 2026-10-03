import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  getAddress,
  keccak256,
  parseTransaction,
  toHex,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerializable,
  type WalletClient,
} from "viem";
import { monadTestnet } from "viem/chains";

/** An eth_call revert as an EIP-1193 provider reports it (code 3 with the revert data). */
export class RevertError extends Error {
  readonly code = 3;
  readonly data: Hex;

  constructor(data: Hex) {
    super("execution reverted");
    this.data = data;
  }
}

/** Builds a revert for `errorName` in `abi`, for a call handler to return. */
export function revert(abi: Abi, errorName: string, args: readonly unknown[] = []): RevertError {
  return new RevertError(encodeErrorResult({ abi, errorName, args } as never));
}

export interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  logIndex?: number;
  transactionHash?: Hex;
}

type CallHandler = (args: readonly unknown[], from: Address | undefined) => unknown;

/**
 * A scripted JSON-RPC node behind viem's `custom` transport. It answers what the SDK's clients ask
 * (calls, logs, estimates, blocks, raw transactions, receipts) and records every request, so tests
 * can assert on exactly what would have reached a real node.
 */
export class FakeRpc {
  readonly calls: Array<{ method: string; params: unknown[] }> = [];
  readonly sent: Array<TransactionSerializable & { from?: Address; hash: Hex }> = [];
  readonly logs: RpcLog[] = [];
  blockNumber = 1_000n;
  finalizedNumber: bigint | undefined;
  timestamp = 1_790_000_000n;
  estimate = 100_000n;
  receiptStatus: "0x1" | "0x0" = "0x1";
  /** Logs to put in the receipt of a sent transaction. */
  receiptLogs: (tx: TransactionSerializable) => RpcLog[] = () => [];
  /** A block's timestamp when it is fetched by number (default: `timestamp` for every block). */
  blockTimestamp: ((number: bigint) => bigint) | undefined;
  /**
   * Runs before the scripted handling of every request: throw to fail it (an HTTP 429, a timeout,
   * an RPC error), return a value to answer it, or return undefined to fall through.
   */
  intercept: ((method: string, params: unknown[]) => unknown) | undefined;
  /** Milliseconds every request waits before it is answered (default 0), to observe concurrency. */
  delayMs = 0;
  /** The most requests that were in flight at once. */
  peakInFlight = 0;
  private inFlight = 0;
  private readonly handlers = new Map<string, { abi: Abi; fn: string; handler: CallHandler }>();

  /** Answers eth_call to `to` for `fn` (decoded with `abi`). Return a RevertError to revert. */
  onCall(to: Address, abi: Abi, fn: string, handler: CallHandler): this {
    this.handlers.set(`${getAddress(to)}:${fn}`, { abi, fn, handler });
    return this;
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  /** `retryCount` is viem's transport retry count (its default is 3; 0 surfaces a failure at once). */
  clients(account: Account, options: { retryCount?: number } = {}): { publicClient: PublicClient; walletClient: WalletClient } {
    const transport = custom(
      { request: ({ method, params }) => this.handle(method, (params ?? []) as unknown[]) },
      { retryCount: options.retryCount },
    );
    return {
      publicClient: createPublicClient({ chain: monadTestnet, transport, pollingInterval: 5 }) as PublicClient,
      walletClient: createWalletClient({ account, chain: monadTestnet, transport, pollingInterval: 5 }),
    };
  }

  private async handle(method: string, params: unknown[]): Promise<unknown> {
    this.calls.push({ method, params });
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return await this.answer(method, params);
    } finally {
      this.inFlight--;
    }
  }

  private async answer(method: string, params: unknown[]): Promise<unknown> {
    const intercepted = this.intercept?.(method, params);
    if (intercepted !== undefined) return intercepted;
    switch (method) {
      case "eth_chainId":
        return toHex(monadTestnet.id);
      case "eth_blockNumber":
        return toHex(this.blockNumber);
      case "eth_getBlockByNumber": {
        const tag = params[0];
        const number =
          tag === "finalized"
            ? (this.finalizedNumber ?? this.blockNumber)
            : typeof tag === "string" && tag.startsWith("0x")
              ? BigInt(tag)
              : this.blockNumber;
        return {
          number: toHex(number),
          hash: keccak256(toHex(number)),
          parentHash: keccak256(toHex(number - 1n)),
          timestamp: toHex(this.blockTimestamp?.(number) ?? this.timestamp),
          baseFeePerGas: toHex(100_000_000_000n),
          gasLimit: toHex(150_000_000n),
          gasUsed: "0x0",
          transactions: [],
        };
      }
      case "eth_getTransactionCount":
        return "0x0";
      case "eth_maxPriorityFeePerGas":
        return toHex(2_000_000_000n);
      case "eth_estimateGas":
        return toHex(this.estimate);
      case "eth_call":
        return this.call(params[0] as { to: Address; data: Hex; from?: Address });
      case "eth_getLogs":
        return this.getLogs(
          params[0] as { address?: Address | Address[]; topics?: (Hex | Hex[] | null)[]; fromBlock: Hex; toBlock: Hex },
        );
      case "eth_sendRawTransaction": {
        const raw = params[0] as Hex;
        const hash = keccak256(raw);
        const tx = parseTransaction(raw);
        this.sent.push({ ...tx, ...(tx.to ? { to: getAddress(tx.to) } : {}), hash });
        return hash;
      }
      case "eth_getTransactionReceipt": {
        const hash = params[0] as Hex;
        const tx = this.sent.find((t) => t.hash === hash);
        if (!tx) return null;
        return {
          transactionHash: hash,
          transactionIndex: "0x0",
          blockHash: keccak256(toHex(this.blockNumber)),
          blockNumber: toHex(this.blockNumber),
          from: "0x0000000000000000000000000000000000000001",
          to: tx.to ?? null,
          cumulativeGasUsed: toHex(tx.gas ?? 0n),
          gasUsed: toHex(tx.gas ?? 0n),
          effectiveGasPrice: toHex(102_000_000_000n),
          contractAddress: null,
          logs: this.receiptLogs(tx).map((log, i) => this.formatLog(log, i)),
          logsBloom: `0x${"00".repeat(256)}`,
          status: this.receiptStatus,
          type: "0x2",
        };
      }
      default:
        throw new Error(`FakeRpc: unexpected method ${method}`);
    }
  }

  private call({ to, data, from }: { to: Address; data: Hex; from?: Address }): Hex {
    for (const [key, { abi, fn, handler }] of this.handlers) {
      if (!key.startsWith(`${getAddress(to)}:`)) continue;
      let decoded: { functionName: string; args?: readonly unknown[] };
      try {
        decoded = decodeFunctionData({ abi, data });
      } catch {
        continue;
      }
      if (decoded.functionName !== fn) continue;
      const result = handler(decoded.args ?? [], from);
      if (result instanceof RevertError) throw result;
      const item = abi.find((x) => x.type === "function" && x.name === fn);
      if (item?.type === "function" && item.outputs.length === 0) return "0x";
      return encodeFunctionResult({ abi, functionName: fn, result } as never);
    }
    throw new Error(`FakeRpc: no eth_call handler for ${to} ${data.slice(0, 10)}`);
  }

  /** An address or topic given as a list matches any of its entries, as in eth_getLogs. */
  private getLogs(filter: { address?: Address | Address[]; topics?: (Hex | Hex[] | null)[]; fromBlock: Hex; toBlock: Hex }) {
    const from = BigInt(filter.fromBlock);
    const to = BigInt(filter.toBlock);
    const addresses = filter.address === undefined ? undefined : [filter.address].flat().map((a) => getAddress(a));
    return this.logs
      .filter((log) => !addresses || addresses.includes(getAddress(log.address)))
      .filter((log) => log.blockNumber >= from && log.blockNumber <= to)
      .filter((log) =>
        (filter.topics ?? []).every(
          (t, i) =>
            t === null ||
            t === undefined ||
            [t].flat().some((option) => log.topics[i]?.toLowerCase() === option.toLowerCase()),
        ),
      )
      .map((log, i) => this.formatLog(log, i));
  }

  private formatLog(log: RpcLog, i: number) {
    return {
      address: log.address,
      topics: log.topics,
      data: log.data,
      blockNumber: toHex(log.blockNumber),
      blockHash: keccak256(toHex(log.blockNumber)),
      transactionHash: log.transactionHash ?? keccak256(toHex(log.blockNumber * 1000n + BigInt(i))),
      transactionIndex: "0x0",
      logIndex: toHex(log.logIndex ?? i),
      removed: false,
    };
  }
}
