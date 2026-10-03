import { getAddress, keccak256, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { GasLimitTooLowError, agentRequestForwarderAbi, sendWithGasGuard, writeWithGasGuard } from "../src/index.ts";
import { FakeRpc, revert } from "./helpers/fake-rpc.ts";

const FORWARDER = getAddress("0x1451f3c36545b191d3642f759d59f21dcfd657b2");
const VALIDATOR = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const HASH: Hex = keccak256(toHex("request"));
const account = privateKeyToAccount(generatePrivateKey());

describe("writeWithGasGuard", () => {
  let rpc: FakeRpc;
  const write = (gasLimit: bigint) => {
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
