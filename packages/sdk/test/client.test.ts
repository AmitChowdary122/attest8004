import {
  BaseError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  parseAbi,
  toHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Attest8004Client,
  DEFAULT_GAS,
  agentRequestForwarderAbi,
  attestGateAbi,
  buildAction,
  computeActionHash,
  computeRequestHash,
  parseRequestUri,
  requestHashOfJson,
  validationRegistryAbi,
  validationResponseEvent,
} from "../src/index.ts";
import { FakeRpc, revert, type RpcLog } from "./helpers/fake-rpc.ts";

const REGISTRY = getAddress("0xc4a4d0ceb3971cbe7a2536494ac106f2cd9f9a8f");
const FORWARDER = getAddress("0x1451f3c36545b191d3642f759d59f21dcfd657b2");
const GATE = getAddress("0x7a5ec388ccbfd3b255cfa94fc2062c0807f2c4cd");
const VALIDATOR_A = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const VALIDATOR_B = getAddress("0x00000000000000000000000000000000000000b0");
const VALIDATOR_C = getAddress("0x00000000000000000000000000000000000000c0");
const account = privateKeyToAccount(generatePrivateKey());
const CHAIN_ID = 10143;

let rpc: FakeRpc;
beforeEach(() => {
  rpc = new FakeRpc();
});

const action = buildAction({
  agentId: 7n,
  target: getAddress("0x3efeb3cf2fb54a7d99abe90aab786ce5a831a8cf"),
  value: 1_000_000_000_000_000n,
  deadline: 1_790_000_600n,
  salt: `0x${"42".repeat(32)}`,
});
const rhA = computeRequestHash({ chainId: CHAIN_ID, gate: GATE, validator: VALIDATOR_A, action });
const rhB = computeRequestHash({ chainId: CHAIN_ID, gate: GATE, validator: VALIDATOR_B, action });

function responseLog(args: { requestHash: Hex; response: number; blockNumber: bigint; tag?: string }): RpcLog {
  return {
    address: REGISTRY,
    topics: encodeEventTopics({
      abi: [validationResponseEvent],
      eventName: "ValidationResponse",
      args: { validatorAddress: VALIDATOR_A, agentId: action.agentId, requestHash: args.requestHash },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint8" }, { type: "string" }, { type: "bytes32" }, { type: "string" }],
      [args.response, "data:application/json,{}", keccak256(toHex("evidence")), args.tag ?? "mandate-v1"],
    ),
    blockNumber: args.blockNumber,
  };
}

describe("Attest8004Client.requestValidation", () => {
  it("sends forwarder.request with the request JSON data: URI and the SDK requestHash, one tx per validator", async () => {
    rpc.onCall(FORWARDER, agentRequestForwarderAbi, "request", () => undefined);
    const { publicClient, walletClient } = rpc.clients(account);
    const client = new Attest8004Client({
      publicClient,
      walletClient,
      validationRegistry: REGISTRY,
      forwarder: FORWARDER,
      gas: { forwarderRequest: 300_000n },
    });

    const validators = [VALIDATOR_A, VALIDATOR_B];
    const requested = await client.requestValidation({ gate: GATE, validators, action });

    expect(rpc.sent).toHaveLength(2);
    validators.forEach((validator, i) => {
      const tx = rpc.sent[i];
      expect(tx?.to).toBe(FORWARDER);
      expect(tx?.gas).toBe(300_000n);
      const { functionName, args } = decodeFunctionData({ abi: agentRequestForwarderAbi, data: tx?.data ?? "0x" });
      expect(functionName).toBe("request");
      const [sentValidator, agentId, uri, requestHash] = args as [Address, bigint, string, Hex];
      expect(sentValidator).toBe(validator);
      expect(agentId).toBe(7n);
      expect(requestHash).toBe(computeRequestHash({ chainId: CHAIN_ID, gate: GATE, validator, action }));
      const parsed = parseRequestUri(uri);
      if (!parsed.ok) throw new Error(parsed.detail);
      expect(parsed.json.validator).toBe(validator);
      expect(requestHashOfJson(parsed.json)).toBe(requestHash);
      expect(requested[i]).toMatchObject({
        validator,
        requestHash,
        requestURI: uri,
        txHash: tx?.hash,
        blockNumber: rpc.blockNumber,
      });
    });
  });

  it("calls validationRequest on the registry when no forwarder is set", async () => {
    rpc.onCall(REGISTRY, validationRegistryAbi, "validationRequest", () => undefined);
    const { publicClient, walletClient } = rpc.clients(account);
    const client = new Attest8004Client({ publicClient, walletClient, validationRegistry: REGISTRY });

    await client.requestValidation({ gate: GATE, validators: [VALIDATOR_A], action });

    expect(rpc.sent).toHaveLength(1);
    expect(rpc.sent[0]?.to).toBe(REGISTRY);
    expect(rpc.sent[0]?.gas).toBe(DEFAULT_GAS.validationRequest);
    const { functionName, args } = decodeFunctionData({ abi: validationRegistryAbi, data: rpc.sent[0]?.data ?? "0x" });
    expect(functionName).toBe("validationRequest");
    expect(args?.[3]).toBe(rhA);
  });

  it("needs a wallet client", async () => {
    const { publicClient } = rpc.clients(account);
    const client = new Attest8004Client({ publicClient, validationRegistry: REGISTRY });
    await expect(client.requestValidation({ gate: GATE, validators: [VALIDATOR_A], action })).rejects.toThrow(
      /walletClient/,
    );
  });
});

describe("Attest8004Client.awaitVerdict", () => {
  it("scans in windows of at most 100 blocks and returns the first ValidationResponse, even a response of 0", async () => {
    rpc.blockNumber = 1_250n;
    rpc.logs.push(responseLog({ requestHash: rhB, response: 100, blockNumber: 1_050n }));
    rpc.logs.push(responseLog({ requestHash: rhA, response: 0, blockNumber: 1_210n, tag: "mandate-v1" }));
    rpc.logs.push(responseLog({ requestHash: rhA, response: 100, blockNumber: 1_230n }));
    const { publicClient } = rpc.clients(account);
    const client = new Attest8004Client({ publicClient, validationRegistry: REGISTRY });

    const verdict = await client.awaitVerdict({ requestHash: rhA, fromBlock: 1_000n, timeoutMs: 1_000, pollIntervalMs: 5 });

    expect(verdict).toMatchObject({
      requestHash: rhA,
      validator: VALIDATOR_A,
      agentId: 7n,
      response: 0,
      tag: "mandate-v1",
      blockNumber: 1_210n,
    });
    const getLogs = rpc.calls.filter((c) => c.method === "eth_getLogs");
    expect(getLogs.length).toBeGreaterThanOrEqual(3);
    for (const { params } of getLogs) {
      const { fromBlock, toBlock } = params[0] as { fromBlock: Hex; toBlock: Hex };
      expect(BigInt(toBlock) - BigInt(fromBlock)).toBeLessThanOrEqual(99n);
    }
  });

  it("times out when no response arrives", async () => {
    const { publicClient } = rpc.clients(account);
    const client = new Attest8004Client({ publicClient, validationRegistry: REGISTRY });
    await expect(
      client.awaitVerdict({ requestHash: rhA, fromBlock: 990n, timeoutMs: 30, pollIntervalMs: 5 }),
    ).rejects.toThrow(/no ValidationResponse/);
  });
});

describe("Attest8004Client.isValidated (mirrors AttestGate)", () => {
  type Status = readonly [Address, bigint, number, Hex, string, bigint];
  let statuses: Map<Hex, Status>;
  let consumed: boolean;

  beforeEach(() => {
    rpc.timestamp = 1_790_000_000n;
    consumed = false;
    statuses = new Map<Hex, Status>([
      [rhA, [VALIDATOR_A, 7n, 100, keccak256(toHex("a")), "mandate-v1", 1n]],
      [rhB, [VALIDATOR_B, 7n, 70, keccak256(toHex("b")), "risk-v1", 1n]],
    ]);
    rpc
      .onCall(GATE, attestGateAbi, "validationRegistry", () => REGISTRY)
      .onCall(GATE, attestGateAbi, "requirements", () => [
        { validator: VALIDATOR_A, minScore: 100, tagHash: keccak256(toHex("mandate-v1")) },
        { validator: VALIDATOR_B, minScore: 70, tagHash: keccak256(toHex("risk-v1")) },
      ])
      .onCall(GATE, attestGateAbi, "consumed", ([hash]) => {
        expect(hash).toBe(computeActionHash({ chainId: CHAIN_ID, gate: GATE, action }));
        return consumed;
      })
      .onCall(REGISTRY, validationRegistryAbi, "getValidationStatus", ([hash]) => {
        const status = statuses.get(hash as Hex);
        return status ?? revert(validationRegistryAbi, "UnknownRequest", [hash]);
      });
  });

  const isValidated = () => {
    const { publicClient } = rpc.clients(account);
    return new Attest8004Client({ publicClient, validationRegistry: REGISTRY }).isValidated({ gate: GATE, action });
  };

  it("is true when every requirement passes", async () => {
    expect(await isValidated()).toBe(true);
  });

  it("is false while a request is pending (response 0)", async () => {
    statuses.set(rhB, [VALIDATOR_B, 7n, 0, zeroHash, "", 1n]);
    expect(await isValidated()).toBe(false);
  });

  it("is false below a minimum score", async () => {
    statuses.set(rhB, [VALIDATOR_B, 7n, 69, keccak256(toHex("b")), "risk-v1", 1n]);
    expect(await isValidated()).toBe(false);
  });

  it("is false when the stored validator is another one", async () => {
    statuses.set(rhA, [VALIDATOR_C, 7n, 100, keccak256(toHex("c")), "x", 1n]);
    expect(await isValidated()).toBe(false);
  });

  it("is false when a requirement's verdict carries another tag", async () => {
    statuses.set(rhA, [VALIDATOR_A, 7n, 100, keccak256(toHex("a")), "other", 1n]);
    expect(await isValidated()).toBe(false);
  });

  /**
   * The tag is compared as raw bytes, never as a decoded JS string: decoding through
   * `TextDecoder` (what an ABI `string` output does) silently strips a leading BOM and replaces
   * invalid UTF-8, so a decode-then-rehash would pass a tag that doesn't hash to what the
   * contract actually stored and checked onchain (`AttestGate._checkVerdict` hashes `bytes(tag)`
   * directly, with no decode step).
   */
  it("is false when a verdict's tag carries a leading BOM that naive UTF-8 decoding would strip", async () => {
    // Raw bytes as posted onchain: EF BB BF ("﻿") + "mandate-v1". Decoding this as a string
    // and re-encoding it loses the BOM, which would make it hash equal to plain "mandate-v1".
    statuses.set(rhA, [VALIDATOR_A, 7n, 100, keccak256(toHex("a")), "﻿mandate-v1", 1n]);
    expect(await isValidated()).toBe(false);
  });

  it("is false when a verdict's tag isn't valid UTF-8", async () => {
    // getValidationStatus with `tag` declared `bytes` (same wire encoding as `string`), so we can
    // post a raw byte sequence no JS string can hold losslessly: "mandate-v1" plus one dangling
    // UTF-8 continuation byte (0x80), which TextDecoder would turn into "mandate-v1�".
    const rawTagAbi = parseAbi([
      "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, bytes tag, uint256 lastUpdate)",
    ]);
    const invalidTag = `${toHex("mandate-v1")}80` as Hex;
    rpc.onCall(REGISTRY, rawTagAbi, "getValidationStatus", () => [
      VALIDATOR_A,
      7n,
      100,
      keccak256(toHex("a")),
      invalidTag,
      1n,
    ]);
    expect(await isValidated()).toBe(false);
  });

  it("is false when another agent claimed the hash", async () => {
    statuses.set(rhA, [VALIDATOR_A, 8n, 100, keccak256(toHex("a")), "mandate-v1", 1n]);
    expect(await isValidated()).toBe(false);
  });

  it("is false when a validator has no request (UnknownRequest)", async () => {
    statuses.delete(rhB);
    expect(await isValidated()).toBe(false);
  });

  it("is false once the action is consumed", async () => {
    consumed = true;
    expect(await isValidated()).toBe(false);
  });

  it("is false after the deadline", async () => {
    rpc.timestamp = action.deadline + 1n;
    expect(await isValidated()).toBe(false);
  });

  it("rethrows an RPC failure instead of reporting false", async () => {
    rpc.onCall(REGISTRY, validationRegistryAbi, "getValidationStatus", () => {
      throw new Error("node unavailable");
    });
    await expect(isValidated()).rejects.toThrow();
  });

  it("against a pre-P5 gate (a two-field Requirement, as the P2 and P3 vaults return) rejects with a viem decoding error, never a wrong true", async () => {
    const preTagGateAbi = parseAbi([
      "struct Requirement { address validator; uint8 minScore; }",
      "function requirements() view returns (Requirement[])",
    ]);
    // Read as three words per requirement where the gate returns two, the decoder always runs past the
    // data (or meets an out-of-range field first): one to four requirements, large or small addresses.
    for (const requirements of [
      [{ validator: VALIDATOR_A, minScore: 100 }],
      [{ validator: VALIDATOR_B, minScore: 70 }],
      [
        { validator: VALIDATOR_A, minScore: 100 },
        { validator: VALIDATOR_B, minScore: 70 },
      ],
      [
        { validator: VALIDATOR_A, minScore: 100 },
        { validator: VALIDATOR_B, minScore: 70 },
        { validator: VALIDATOR_C, minScore: 1 },
      ],
      [
        { validator: VALIDATOR_B, minScore: 70 },
        { validator: VALIDATOR_C, minScore: 1 },
        { validator: VALIDATOR_B, minScore: 1 },
        { validator: VALIDATOR_C, minScore: 1 },
      ],
    ]) {
      rpc.onCall(GATE, preTagGateAbi, "requirements", () => requirements);
      const error = await isValidated().then(
        (value) => value,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(BaseError);
      // viem doesn't export PositionOutOfBoundsError from its root, so both are matched by name.
      const decoding = (error as BaseError).walk((e) => ["PositionOutOfBoundsError", "IntegerOutOfRangeError"].includes((e as Error).name));
      expect(decoding, `${requirements.length} requirement(s)`).not.toBeNull();
    }
  });
});
