import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  pad,
  toHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GasLimitTooLowError,
  validationRegistryAbi,
  validationRequestEvent,
  viemValidatorChain,
} from "../src/index.ts";
import { FakeRpc, type RpcLog } from "./helpers/fake-rpc.ts";

const REGISTRY = getAddress("0xc4a4d0ceb3971cbe7a2536494ac106f2cd9f9a8f");
const OTHER_VALIDATOR = getAddress("0x00000000000000000000000000000000000000b0");
const account = privateKeyToAccount(generatePrivateKey());
const HASH: Hex = keccak256(toHex("request"));

function requestLog(validator: Address, blockNumber: bigint, requestHash: Hex, logIndex = 0): RpcLog {
  return {
    address: REGISTRY,
    topics: encodeEventTopics({
      abi: [validationRequestEvent],
      eventName: "ValidationRequest",
      args: { validatorAddress: validator, agentId: 7n, requestHash },
    }) as Hex[],
    data: encodeAbiParameters([{ type: "string" }], ["data:application/json,{}"]),
    blockNumber,
    logIndex,
  };
}

let rpc: FakeRpc;
beforeEach(() => {
  rpc = new FakeRpc();
});

function chain(gasLimit = 102_000n) {
  const { publicClient, walletClient } = rpc.clients(account);
  return viemValidatorChain({ publicClient, walletClient, validationRegistry: REGISTRY, gasLimit });
}

describe("viemValidatorChain", () => {
  it("is the wallet's address", () => {
    expect(chain().address).toBe(account.address);
  });

  it("reads ValidationRequest logs for this validator only, in the exact block range, sorted", async () => {
    const h2 = keccak256(toHex("second"));
    rpc.logs.push(requestLog(account.address, 1_050n, h2, 1));
    rpc.logs.push(requestLog(account.address, 1_050n, HASH, 0));
    rpc.logs.push(requestLog(OTHER_VALIDATOR, 1_060n, keccak256(toHex("other"))));

    const events = await chain().requestLogs(1_000n, 1_099n);

    const getLogs = rpc.calls.filter((c) => c.method === "eth_getLogs");
    expect(getLogs).toHaveLength(1);
    const filter = getLogs[0]?.params[0] as { address: Address; topics: (Hex | null)[]; fromBlock: Hex; toBlock: Hex };
    expect(getAddress(filter.address)).toBe(REGISTRY);
    expect(filter.topics[1]?.toLowerCase()).toBe(pad(account.address.toLowerCase() as Hex));
    expect([BigInt(filter.fromBlock), BigInt(filter.toBlock)]).toEqual([1_000n, 1_099n]);
    expect(events.map((e) => e.requestHash)).toEqual([HASH, h2]);
    expect(events[0]).toMatchObject({
      validator: account.address,
      agentId: 7n,
      requestURI: "data:application/json,{}",
      blockNumber: 1_050n,
      logIndex: 0,
    });
  });

  it("uses the finalized block as the head", async () => {
    rpc.blockNumber = 1_005n;
    rpc.finalizedNumber = 1_000n;
    rpc.timestamp = 1_790_000_123n;
    expect(await chain().head()).toEqual({ number: 1_000n, timestamp: 1_790_000_123n });
    expect(rpc.calls.find((c) => c.method === "eth_getBlockByNumber")?.params[0]).toBe("finalized");
  });

  it("reads the registry status", async () => {
    rpc.onCall(REGISTRY, validationRegistryAbi, "getValidationStatus", () => [account.address, 7n, 0, zeroHash, "", 5n]);
    expect(await chain().status(HASH)).toEqual({
      validator: account.address,
      agentId: 7n,
      response: 0,
      responseHash: zeroHash,
      tag: "",
      lastUpdate: 5n,
    });
  });

  it("responds with exactly the explicit gas limit, and returns the receipt's block and the sent gas", async () => {
    rpc.onCall(REGISTRY, validationRegistryAbi, "validationResponse", () => undefined);
    rpc.estimate = 84_514n;
    rpc.blockNumber = 1_234n;
    const evidenceHash = keccak256(toHex("evidence"));
    const result = await chain().respond({
      requestHash: HASH,
      response: 100,
      responseURI: "data:application/json,{}",
      responseHash: evidenceHash,
      tag: "mandate-v1",
    });
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.sent[0]).toMatchObject({ to: REGISTRY, gas: 102_000n, hash: result.txHash });
    expect(result).toEqual({ txHash: rpc.sent[0]?.hash, blockNumber: 1_234n, gasLimit: 102_000n });
    const { functionName, args } = decodeFunctionData({ abi: validationRegistryAbi, data: rpc.sent[0]?.data ?? "0x" });
    expect(functionName).toBe("validationResponse");
    expect(args).toEqual([HASH, 100, "data:application/json,{}", evidenceHash, "mandate-v1"]);
  });

  it("refuses to respond when the estimate is above the limit", async () => {
    rpc.onCall(REGISTRY, validationRegistryAbi, "validationResponse", () => undefined);
    rpc.estimate = 103_000n;
    await expect(
      chain().respond({ requestHash: HASH, response: 100, responseURI: "", responseHash: zeroHash, tag: "t" }),
    ).rejects.toBeInstanceOf(GasLimitTooLowError);
    expect(rpc.methods()).not.toContain("eth_sendRawTransaction");
  });
});
