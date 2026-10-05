import { getAddress, keccak256, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GasLimitTooLowError,
  agentRequestForwarderAbi,
  sendWithGasGuard,
  writeWithGasGuard,
  type GasLimit,
} from "../src/index.ts";
import { FakeRpc, revert } from "./helpers/fake-rpc.ts";

const FORWARDER = getAddress("0x1451f3c36545b191d3642f759d59f21dcfd657b2");
const VALIDATOR = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const HASH: Hex = keccak256(toHex("request"));
const account = privateKeyToAccount(generatePrivateKey());

describe("writeWithGasGuard", () => {
  let rpc: FakeRpc;
  const write = (gasLimit: GasLimit) => {
    const { publicClient, walletClient } = rpc.clients(account);
    return writeWithGasGuard({
      publicClient,
      walletClient,
      address: FORWARDER,
      abi: agentRequestForwarderAbi,
      functionName: "request",
      args: [VALIDATOR, 7n, "data:application/json,{}", HASH],
      gasLimit,
      label: "forwarder.request",
    });
  };

  beforeEach(() => {
    rpc = new FakeRpc().onCall(FORWARDER, agentRequestForwarderAbi, "request", () => undefined);
  });

  it("sends with exactly the explicit limit, not the estimate", async () => {
    rpc.estimate = 90_000n;
    const result = await write(120_000n);
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.sent[0]?.gas).toBe(120_000n);
    expect(rpc.sent[0]?.to).toBe(FORWARDER);
    expect(result).toMatchObject({ estimate: 90_000n, gasLimit: 120_000n, hash: rpc.sent[0]?.hash });
    expect(result.receipt.status).toBe("success");
  });

  // viem calls eth_fillTransaction when fees or the nonce are missing, and takes the node's `gas`
  // from the result. The guard sets them itself so no node can replace the explicit limit.
  it("never asks the node to fill the transaction", async () => {
    await write(120_000n);
    expect(rpc.methods()).not.toContain("eth_fillTransaction");
    expect(rpc.sent[0]?.gas).toBe(120_000n);
    expect(rpc.sent[0]?.maxFeePerGas).toBeGreaterThan(0n);
  });

  it("throws GasLimitTooLowError and never sends when the estimate is above the limit", async () => {
    rpc.estimate = 130_000n;
    const error = await write(120_000n).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GasLimitTooLowError);
    expect(error).toMatchObject({ label: "forwarder.request", estimate: 130_000n, limit: 120_000n });
    expect(rpc.methods()).not.toContain("eth_sendRawTransaction");
  });

  it("surfaces the revert name from the simulation and never sends", async () => {
    rpc.onCall(FORWARDER, agentRequestForwarderAbi, "request", () =>
      revert(agentRequestForwarderAbi, "NotAgentKey", [7n, account.address]),
    );
    await expect(write(120_000n)).rejects.toThrow(/NotAgentKey/);
    expect(rpc.methods()).not.toContain("eth_sendRawTransaction");
  });

  it("throws when the receipt says the transaction reverted", async () => {
    rpc.receiptStatus = "0x0";
    await expect(write(120_000n)).rejects.toThrow(/forwarder\.request: transaction 0x[0-9a-f]{64} reverted/);
  });
});

describe("writeWithGasGuard: evidence-sized gas limit policy", () => {
  let rpc: FakeRpc;
  const write = (gasLimit: GasLimit) => {
    const { publicClient, walletClient } = rpc.clients(account);
    return writeWithGasGuard({
      publicClient,
      walletClient,
      address: FORWARDER,
      abi: agentRequestForwarderAbi,
      functionName: "request",
      args: [VALIDATOR, 7n, "data:application/json,{}", HASH],
      gasLimit,
      label: "forwarder.request",
    });
  };

  beforeEach(() => {
    rpc = new FakeRpc().onCall(FORWARDER, agentRequestForwarderAbi, "request", () => undefined);
  });

  it("sizes the limit at the estimate plus headroom, rounded up", async () => {
    rpc.estimate = 100_000n;
    const result = await write({ headroomPercent: 20, max: 400_000n });
    expect(rpc.sent[0]?.gas).toBe(120_000n);
    expect(result.gasLimit).toBe(120_000n);
    expect(result.estimate).toBe(100_000n);
  });

  it("caps the sized limit at max", async () => {
    rpc.estimate = 380_000n;
    const result = await write({ headroomPercent: 20, max: 400_000n });
    expect(rpc.sent[0]?.gas).toBe(400_000n);
    expect(result.gasLimit).toBe(400_000n);
  });

  it("throws GasLimitTooLowError before sending when the estimate is already above max", async () => {
    rpc.estimate = 401_000n;
    const error = await write({ headroomPercent: 20, max: 400_000n }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GasLimitTooLowError);
    expect(error).toMatchObject({ label: "forwarder.request", estimate: 401_000n, limit: 400_000n });
    expect(rpc.methods()).not.toContain("eth_sendRawTransaction");
  });

  it("rejects a headroomPercent that isn't a non-negative integer, before sending", async () => {
    rpc.estimate = 100_000n;
    await expect(write({ headroomPercent: -1, max: 400_000n })).rejects.toThrow(/headroomPercent/);
    await expect(write({ headroomPercent: 1.5, max: 400_000n })).rejects.toThrow(/headroomPercent/);
    expect(rpc.methods()).not.toContain("eth_sendRawTransaction");
  });
});

describe("sendWithGasGuard (plain value transfers)", () => {
  it("sends value with exactly the explicit limit, and refuses when the estimate is above it", async () => {
    const rpc = new FakeRpc();
    const { publicClient, walletClient } = rpc.clients(account);
    rpc.estimate = 21_212n;
    await sendWithGasGuard({ publicClient, walletClient, to: VALIDATOR, value: 5n, gasLimit: 26_000n, label: "fund" });
    expect(rpc.sent[0]).toMatchObject({ to: VALIDATOR, value: 5n, gas: 26_000n });
    expect(rpc.methods()).not.toContain("eth_fillTransaction");

    rpc.estimate = 30_000n;
    await expect(
      sendWithGasGuard({ publicClient, walletClient, to: VALIDATOR, value: 5n, gasLimit: 26_000n, label: "fund" }),
    ).rejects.toBeInstanceOf(GasLimitTooLowError);
    expect(rpc.sent).toHaveLength(1);
  });
});

describe("writeWithGasGuard: a replaced send, and an abort before sending (P7 review I1)", () => {
  /** viem stand-ins: `onWait` sees waitForTransactionReceipt's parameters (to call onReplaced); writes are recorded. */
  function stubClients(onWait: (params: { onReplaced?: (r: unknown) => void }) => void = () => {}) {
    const sent: unknown[] = [];
    const publicClient = {
      simulateContract: async () => ({}),
      estimateContractGas: async () => 50_000n,
      getChainId: async () => 10143,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
      getTransactionCount: async () => 9,
      waitForTransactionReceipt: async (params: { onReplaced?: (r: unknown) => void }) => {
        onWait(params);
        return { status: "success", blockNumber: 5n };
      },
    };
    const walletClient = {
      account,
      chain: { id: 10143 },
      writeContract: async (call: unknown) => {
        sent.push(call);
        return keccak256(toHex("ours"));
      },
    };
    return { publicClient: publicClient as never, walletClient: walletClient as never, sent };
  }
  const call = { address: FORWARDER, abi: agentRequestForwarderAbi, functionName: "request", args: [VALIDATOR, 7n, "data:,", HASH], gasLimit: 60_000n, label: "forwarder.request" } as const;

  it("a transaction replaced by another (not repriced) is a failed send, even with a successful receipt", async () => {
    const stub = stubClients((params) => params.onReplaced?.({ reason: "replaced", transaction: { hash: keccak256(toHex("theirs")) } }));
    await expect(writeWithGasGuard({ ...stub, ...call })).rejects.toThrow(/was replaced by 0x/);
  });

  it("a cancelled transaction is a failed send too; a repriced one still counts as sent", async () => {
    const cancelled = stubClients((params) => params.onReplaced?.({ reason: "cancelled", transaction: { hash: keccak256(toHex("x")) } }));
    await expect(writeWithGasGuard({ ...cancelled, ...call })).rejects.toThrow(/was cancelled/);
    const repriced = stubClients((params) => params.onReplaced?.({ reason: "repriced", transaction: { hash: keccak256(toHex("y")) } }));
    await expect(writeWithGasGuard({ ...repriced, ...call })).resolves.toMatchObject({ gasLimit: 60_000n });
  });

  it("an aborted signal stops the write before anything is broadcast", async () => {
    const stub = stubClients();
    const controller = new AbortController();
    controller.abort();
    await expect(writeWithGasGuard({ ...stub, ...call, signal: controller.signal })).rejects.toThrow(/aborted before sending/);
    expect(stub.sent).toHaveLength(0);
  });
});
