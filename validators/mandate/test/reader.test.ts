import {
  attestGateAbi,
  agentKeySetEvent,
  computeActionHashFromParts,
  computeRequestHashFromParts,
  encodeCanonicalJsonDataUri,
  identityRegistryAbi,
  MandateRegistryNotDeployedError,
  mandateRegistryAbi,
  validationRegistryAbi,
  validationRequestEvent,
  validationResponseEvent,
} from "@attest8004/sdk";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BaseError,
  createPublicClient,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  getAbiItem,
  getAddress,
  http,
  HttpRequestError,
  keccak256,
  TimeoutError,
  toEventSelector,
  toHex,
  zeroHash,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRpc, RevertError, revert, type RpcLog } from "../../../packages/sdk/test/helpers/fake-rpc.ts";
import { collectInputs, type PreimageCache } from "../src/collect.ts";
import { concurrencyLimit } from "../src/concurrency.ts";
import { MANDATE_V1 } from "../src/params.ts";
import { viemMandateReader, type MandateAddresses, type MandateContracts } from "../src/reader.ts";
import { evaluate } from "../src/rules.ts";
import type { MandateInputs } from "../src/types.ts";

const ADDRESSES: MandateAddresses = {
  validationRegistry: getAddress("0xc4a4d0ceb3971cbe7a2536494ac106f2cd9f9a8f"),
  identityRegistry: getAddress("0x8004a818bfb912233c491871b3d84c89a494bd9e"),
  forwarder: getAddress("0x1451f3c36545b191d3642f759d59f21dcfd657b2"),
  mandateRegistry: getAddress("0x2523197373ef813e19b5b14ef2984130868cd17c"),
};
/** The reader's contracts: `ADDRESSES`, with that one MandateRegistry valid at every block. */
const CONTRACTS: MandateContracts = {
  validationRegistry: ADDRESSES.validationRegistry,
  identityRegistry: ADDRESSES.identityRegistry,
  forwarder: ADDRESSES.forwarder,
  mandateRegistries: [{ address: ADDRESSES.mandateRegistry, fromBlock: 0n }],
};
const GATE = getAddress("0x23bfbd12545ccd1501dda1b65a54518fd6212a96");
const VALIDATOR = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const OWNER = getAddress("0x3efeb3cf2fb54a7d99abe90aab786ce5a831a8cf");
const OTHER_OWNER = getAddress("0x00000000000000000000000000000000000000a1");
const TARGET = getAddress("0x00000000000000000000000000000000000000b2");
const STRANGER = getAddress("0x00000000000000000000000000000000000000c3");
const AGENT = 1_984n;
const OTHER_AGENT = 1_985n;
const P = 70_000_000n;
const HASH: Hex = keccak256(toHex("request"));
const OTHER_HASH: Hex = keccak256(toHex("other request"));
const MANDATE_HASH: Hex = keccak256(toHex("mandate"));
const account = privateKeyToAccount(generatePrivateKey());

const transferEvent = getAbiItem({ abi: identityRegistryAbi, name: "Transfer" });
const approvalEvent = getAbiItem({ abi: identityRegistryAbi, name: "Approval" });
const approvalForAllEvent = getAbiItem({ abi: identityRegistryAbi, name: "ApprovalForAll" });
const mandateSetEvent = getAbiItem({ abi: mandateRegistryAbi, name: "MandateSet" });
const mandateRevokedEvent = getAbiItem({ abi: mandateRegistryAbi, name: "MandateRevoked" });
const passkeySetEvent = getAbiItem({ abi: mandateRegistryAbi, name: "PasskeySet" });
const passkeyRotatedEvent = getAbiItem({ abi: mandateRegistryAbi, name: "PasskeyRotated" });
const inboxKeySetEvent = getAbiItem({ abi: mandateRegistryAbi, name: "InboxKeySet" });

/** A log for `event` with `args`, indexed fields as topics and the rest ABI-encoded as data. */
function eventLog(address: Address, event: AbiEvent, args: Record<string, unknown>, blockNumber: bigint, logIndex: number): RpcLog {
  const topics = encodeEventTopics({ abi: [event], eventName: event.name, args } as never) as Hex[];
  const dataInputs = event.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(
    dataInputs,
    dataInputs.map((input) => args[input.name ?? ""]),
  );
  return { address, topics, data, blockNumber, logIndex, transactionHash: keccak256(toHex(`${blockNumber}:${logIndex}`)) };
}

const mandateSetArgs = (agentId: bigint) => ({
  agentId,
  mandateHash: MANDATE_HASH,
  owner: OWNER,
  allowedTargets: [TARGET],
  allowedSelectors: ["0x00000000"],
  maxValuePerTx: 2n,
  maxValuePerDay: 5n,
  validUntil: 1_800_000_000n,
  setAtBlock: 0n,
});

function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

let rpc: FakeRpc;
beforeEach(() => {
  rpc = new FakeRpc();
  rpc.blockNumber = P;
});

/** `retryCount: 0` so a transient failure surfaces at once instead of after viem's backoff. */
function reader(concurrency?: number) {
  const { publicClient } = rpc.clients(account, { retryCount: 0 });
  return viemMandateReader({ publicClient, contracts: CONTRACTS, ...(concurrency ? { concurrency } : {}) });
}

function ethCalls() {
  return rpc.calls.filter((c) => c.method === "eth_call");
}

function getLogsFilters() {
  return rpc.calls
    .filter((c) => c.method === "eth_getLogs")
    .map((c) => c.params[0] as { address: Address | Address[]; topics: (Hex | Hex[] | null)[]; fromBlock: Hex; toBlock: Hex });
}

/** Answers eth_call to `to` with raw `result` (for calls with no ABI, like a plain MON transfer). */
function answerRawCall(to: Address, answer: () => unknown) {
  rpc.intercept = (method, params) => {
    if (method !== "eth_call") return undefined;
    const call = params[0] as { to: Address };
    if (getAddress(call.to) !== to) return undefined;
    return answer();
  };
}

describe("viemMandateReader: state reads at P", () => {
  function scriptState() {
    rpc
      .onCall(ADDRESSES.mandateRegistry, mandateRegistryAbi, "getMandate", ([agentId]) =>
        agentId === AGENT
          ? [
              {
                allowedTargets: [TARGET],
                allowedSelectors: ["0x00000000", "0xa9059cbb"],
                maxValuePerTx: 2_000n,
                maxValuePerDay: 5_000n,
                validUntil: 1_800_000_000n,
              },
              MANDATE_HASH,
              OWNER,
              69_999_000n,
            ]
          : [
              { allowedTargets: [], allowedSelectors: [], maxValuePerTx: 0n, maxValuePerDay: 0n, validUntil: 0n },
              zeroHash,
              "0x0000000000000000000000000000000000000000",
              0n,
            ],
      )
      .onCall(ADDRESSES.identityRegistry, identityRegistryAbi, "ownerOf", () => OWNER)
      .onCall(ADDRESSES.validationRegistry, validationRegistryAbi, "getAgentValidations", () => [HASH, OTHER_HASH])
      .onCall(ADDRESSES.validationRegistry, validationRegistryAbi, "getValidationStatus", () => [
        VALIDATOR,
        AGENT,
        100,
        keccak256(toHex("evidence")),
        "mandate-v1",
        1_790_000_000n,
      ])
      .onCall(GATE, attestGateAbi, "consumed", () => true);
  }

  it("every eth_call names block P, and the results decode", async () => {
    scriptState();
    answerRawCall(TARGET, () => "0x");
    const r = reader();

    await expect(r.mandate(AGENT, P)).resolves.toEqual({
      allowedTargets: [TARGET],
      allowedSelectors: ["0x00000000", "0xa9059cbb"],
      maxValuePerTx: 2_000n,
      maxValuePerDay: 5_000n,
      validUntil: 1_800_000_000n,
      mandateHash: MANDATE_HASH,
      owner: OWNER,
      setAtBlock: 69_999_000n,
    });
    await expect(r.ownerOf(AGENT, P)).resolves.toBe(OWNER);
    await expect(r.agentValidations(AGENT, P)).resolves.toEqual([HASH, OTHER_HASH]);
    await expect(r.status(HASH, P)).resolves.toEqual({
      validator: VALIDATOR,
      agentId: AGENT,
      response: 100,
      responseHash: keccak256(toHex("evidence")),
      tag: "mandate-v1",
      lastUpdate: 1_790_000_000n,
    });
    await expect(r.consumed(GATE, HASH, P)).resolves.toBe(true);
    await expect(r.simulate({ from: GATE, to: TARGET, value: 1n, data: "0x", gas: 1_000_000n }, P)).resolves.toEqual({ ok: true });

    expect(ethCalls()).toHaveLength(6);
    for (const call of ethCalls()) expect(call.params[1]).toBe(toHex(P));
  });

  it("a mandate whose hash is zero (never set, or revoked) reads as null", async () => {
    scriptState();
    await expect(reader().mandate(OTHER_AGENT, P)).resolves.toBeNull();
  });

  it("consumed() sends the gas cap and reads false", async () => {
    rpc.onCall(GATE, attestGateAbi, "consumed", () => false);
    await expect(reader().consumed(GATE, HASH, P)).resolves.toBe(false);
    const [call] = ethCalls();
    expect((call?.params[0] as { gas?: Hex }).gas).toBe(toHex(MANDATE_V1.consumedCallGas));
    expect(call?.params[1]).toBe(toHex(P));
  });

  it("finalized() reads the finalized tag, block(n) reads block n", async () => {
    rpc.finalizedNumber = P - 1n;
    rpc.blockTimestamp = (n) => 1_790_000_000n + n;
    const r = reader();
    await expect(r.finalized()).resolves.toEqual({
      number: P - 1n,
      hash: keccak256(toHex(P - 1n)),
      timestamp: 1_790_000_000n + P - 1n,
    });
    await expect(r.block(123n)).resolves.toEqual({ number: 123n, hash: keccak256(toHex(123n)), timestamp: 1_790_000_123n });
    expect(rpc.calls.filter((c) => c.method === "eth_getBlockByNumber").map((c) => c.params[0])).toEqual(["finalized", toHex(123n)]);
    await expect(r.chainId()).resolves.toBe(10_143);
  });

  it("a status read before the registry has code (eth_call returns 0x) throws a decode error, not a revert", async () => {
    rpc.intercept = (method) => (method === "eth_call" ? "0x" : undefined);
    const failure = await reader()
      .status(HASH, P)
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(BaseError);
    expect((failure as BaseError).name).toBe("AbiDecodingZeroDataError");
  });

  it("a -32602 history error from any state read throws, never a value", async () => {
    rpc.intercept = (method) => {
      if (method === "eth_call") throw rpcError(-32602, "Block requested not found. Request might be querying historical state that is not available");
      return undefined;
    };
    const r = reader();
    await expect(r.mandate(AGENT, P)).rejects.toThrow(/historical state/);
    await expect(r.ownerOf(AGENT, P)).rejects.toThrow(/historical state/);
    await expect(r.agentValidations(AGENT, P)).rejects.toThrow(/historical state/);
    await expect(r.status(HASH, P)).rejects.toThrow(/historical state/);
    await expect(r.consumed(GATE, HASH, P)).rejects.toThrow(/historical state/);
    await expect(r.simulate({ from: GATE, to: TARGET, value: 0n, data: "0x", gas: 1_000_000n }, P)).rejects.toThrow(
      /historical state/,
    );
  });
});

describe("viemMandateReader: simulate classifies only deterministic outcomes", () => {
  const call = { from: GATE, to: TARGET, value: 3_000n, data: "0xa9059cbb" as Hex, gas: 1_000_000n };

  it("sends one eth_call at P from the gate, with value, data and the explicit gas", async () => {
    answerRawCall(TARGET, () => "0x");
    await expect(reader().simulate(call, P)).resolves.toEqual({ ok: true });
    const [sent] = ethCalls();
    expect(sent?.params[1]).toBe(toHex(P));
    const request = sent?.params[0] as { from: Address; to: Address; value: Hex; data?: Hex; input?: Hex; gas: Hex };
    expect(getAddress(request.from)).toBe(GATE);
    expect(getAddress(request.to)).toBe(TARGET);
    expect(request.value).toBe(toHex(3_000n));
    expect(request.data ?? request.input).toBe("0xa9059cbb");
    expect(request.gas).toBe(toHex(1_000_000n));
  });

  it("code 3 is REVERTED, with the revert data's first 4 bytes", async () => {
    const reverted = revert(attestGateAbi, "ActionExpired", [1n, 2n]);
    answerRawCall(TARGET, () => {
      throw reverted;
    });
    expect(reverted.data.length).toBeGreaterThan(10);
    await expect(reader().simulate(call, P)).resolves.toEqual({
      ok: false,
      error: "REVERTED",
      revertSelector: reverted.data.slice(0, 10),
    });
  });

  it("code 3 with no revert data is REVERTED with a null selector", async () => {
    answerRawCall(TARGET, () => {
      throw new RevertError("0x");
    });
    await expect(reader().simulate(call, P)).resolves.toEqual({ ok: false, error: "REVERTED", revertSelector: null });
  });

  it("Monad's -32003 insufficient funds is INSUFFICIENT_FUNDS", async () => {
    answerRawCall(TARGET, () => {
      throw rpcError(-32003, "Insufficient funds for gas * price + value");
    });
    await expect(reader().simulate(call, P)).resolves.toEqual({ ok: false, error: "INSUFFICIENT_FUNDS", revertSelector: null });
  });

  it("out of gas is OUT_OF_GAS", async () => {
    answerRawCall(TARGET, () => {
      throw rpcError(-32000, "out of gas");
    });
    await expect(reader().simulate(call, P)).resolves.toEqual({ ok: false, error: "OUT_OF_GAS", revertSelector: null });
  });

  it("an HTTP 429 throws", async () => {
    answerRawCall(TARGET, () => {
      throw new HttpRequestError({ url: "https://testnet-rpc.monad.xyz", status: 429, details: "Too Many Requests" });
    });
    await expect(reader().simulate(call, P)).rejects.toThrow(/HTTP request failed/);
  });

  it("an HTTP 429 whose body mentions insufficient funds still throws (only JSON-RPC errors are outcomes)", async () => {
    answerRawCall(TARGET, () => {
      throw new HttpRequestError({ url: "https://testnet-rpc.monad.xyz", status: 429, details: "insufficient funds, out of gas" });
    });
    // viem relabels the error from its text, but the cause is still the HTTP failure, and it throws.
    const error = await reader()
      .simulate(call, P)
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(BaseError);
    expect((error as BaseError).walk((e) => e instanceof HttpRequestError)).toBeInstanceOf(HttpRequestError);
  });

  it("a timeout throws", async () => {
    answerRawCall(TARGET, () => {
      throw new TimeoutError({ body: {}, url: "https://testnet-rpc.monad.xyz" });
    });
    await expect(reader().simulate(call, P)).rejects.toThrow(/took too long/);
  });

  it("a transport failure with no JSON-RPC code throws, whatever its text", async () => {
    answerRawCall(TARGET, () => {
      throw new Error("socket closed: insufficient funds / out of gas"); // viem wraps it as an unknown RPC error (code -1)
    });
    await expect(reader().simulate(call, P)).rejects.toThrow(/socket closed/);
  });

  it("an unknown RPC error throws", async () => {
    answerRawCall(TARGET, () => {
      throw rpcError(-32603, "internal error");
    });
    await expect(reader().simulate(call, P)).rejects.toThrow(/internal error/);
  });
});

describe("viemMandateReader: consumed() is null for any outcome of the pinned call that isn't a bool", () => {
  it("a gate with no code (the call succeeds with no data) reads as null: chain state, not an RPC failure", async () => {
    answerRawCall(GATE, () => "0x");
    await expect(reader().consumed(GATE, HASH, P)).resolves.toBeNull();
  });

  it("a successful call whose data isn't a bool reads as null", async () => {
    answerRawCall(GATE, () => `0x${"00".repeat(31)}02`);
    await expect(reader().consumed(GATE, HASH, P)).resolves.toBeNull();
  });

  it("a revert reads as null", async () => {
    rpc.onCall(GATE, attestGateAbi, "consumed", () => revert(attestGateAbi, "ActionAlreadyConsumed", [HASH]));
    await expect(reader().consumed(GATE, HASH, P)).resolves.toBeNull();
  });

  it("running out of gas within the cap reads as null", async () => {
    answerRawCall(GATE, () => {
      throw rpcError(-32000, "out of gas");
    });
    await expect(reader().consumed(GATE, HASH, P)).resolves.toBeNull();
  });

  it("an HTTP 429, a timeout, a -32602 history error and insufficient funds all throw", async () => {
    const failures: Array<() => Error> = [
      () => new HttpRequestError({ url: "https://testnet-rpc.monad.xyz", status: 429 }),
      () => new TimeoutError({ body: {}, url: "https://testnet-rpc.monad.xyz" }),
      () => rpcError(-32602, "Block requested not found. Request might be querying historical state that is not available"),
      () => rpcError(-32003, "Insufficient funds for gas * price + value"),
    ];
    for (const failure of failures) {
      answerRawCall(GATE, () => {
        throw failure();
      });
      await expect(reader().consumed(GATE, HASH, P)).rejects.toThrow();
    }
  });
});

/** The reader's error for an eth_call answer that carries no hex result. */
const MALFORMED = /malformed RPC answer/;

describe("viemMandateReader: an eth_call answer with no hex result is an RPC failure, never chain state", () => {
  const call = { from: GATE, to: TARGET, value: 0n, data: "0x" as Hex, gas: 1_000_000n };

  it.each([
    ["null", null],
    ["a number", 123],
    ["an object", {}],
    ["hex with an odd number of digits", "0x123"],
    ["a string that isn't hex", "true"],
  ] as const)("an answer of %s: consumed(), simulate() and every registry read throw", async (_, answer) => {
    rpc.intercept = (method) => (method === "eth_call" ? answer : undefined);
    const r = reader();
    await expect(r.consumed(GATE, HASH, P)).rejects.toThrow(MALFORMED);
    await expect(r.simulate(call, P)).rejects.toThrow(MALFORMED);
    await expect(r.mandate(AGENT, P)).rejects.toThrow(MALFORMED);
    await expect(r.ownerOf(AGENT, P)).rejects.toThrow(MALFORMED);
    await expect(r.agentValidations(AGENT, P)).rejects.toThrow(MALFORMED);
    await expect(r.status(HASH, P)).rejects.toThrow(MALFORMED);
  });
});

describe("viemMandateReader over viem's http transport: only a hex result is chain state", () => {
  // A real JSON-RPC endpoint on 127.0.0.1, so viem's own HTTP parsing runs. viem resolves an HTTP
  // 200 with no `result` and no `error` (or a body that parses to one) as that missing `result`.
  let server: Server;
  let url = "";
  /** The HTTP 200 reply to each request: its body, and its content type (none when omitted). */
  let reply: (id: unknown) => { body: string; contentType?: string } = () => ({ body: "" });
  const rpcReply = (payload: Record<string, unknown>) => (id: unknown) => ({
    body: JSON.stringify({ jsonrpc: "2.0", id, ...payload }),
    contentType: "application/json",
  });
  const call = { from: GATE, to: TARGET, value: 0n, data: "0x" as Hex, gas: 1_000_000n };

  beforeAll(async () => {
    server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        raw += chunk;
      });
      request.on("end", () => {
        const { body, contentType } = reply((JSON.parse(raw) as { id?: unknown }).id);
        response.writeHead(200, contentType === undefined ? {} : { "content-type": contentType });
        response.end(body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  function httpReader() {
    const publicClient = createPublicClient({ transport: http(url, { retryCount: 0 }) });
    return viemMandateReader({ publicClient, contracts: CONTRACTS });
  }

  it.each([
    ["result: null", rpcReply({ result: null })],
    ["neither result nor error", rpcReply({})],
    ["an empty body with no content type", () => ({ body: "" })],
    ["a bare {} body", () => ({ body: "{}", contentType: "application/json" })],
    ["result: 123", rpcReply({ result: 123 })],
    ["result: an odd number of hex digits", rpcReply({ result: "0x123" })],
  ] as const)("an HTTP 200 with %s: consumed(), simulate() and the registry reads throw", async (_, answer) => {
    reply = answer;
    const r = httpReader();
    await expect(r.consumed(GATE, HASH, P)).rejects.toThrow(MALFORMED);
    await expect(r.simulate(call, P)).rejects.toThrow(MALFORMED);
    await expect(r.mandate(AGENT, P)).rejects.toThrow(MALFORMED);
    await expect(r.status(HASH, P)).rejects.toThrow(MALFORMED);
  });

  it('result "0x" (a call to an address with no code) is chain state: consumed() is null, simulate() is ok', async () => {
    reply = rpcReply({ result: "0x" });
    const r = httpReader();
    await expect(r.consumed(GATE, HASH, P)).resolves.toBeNull();
    await expect(r.simulate(call, P)).resolves.toEqual({ ok: true });
  });

  it("consumed() reads a bool as itself, and a 32-byte word that isn't a bool as null", async () => {
    const r = httpReader();
    reply = rpcReply({ result: encodeAbiParameters([{ type: "bool" }], [true]) });
    await expect(r.consumed(GATE, HASH, P)).resolves.toBe(true);
    reply = rpcReply({ result: encodeAbiParameters([{ type: "bool" }], [false]) });
    await expect(r.consumed(GATE, HASH, P)).resolves.toBe(false);
    reply = rpcReply({ result: `0x${"00".repeat(31)}02` });
    await expect(r.consumed(GATE, HASH, P)).resolves.toBeNull();
  });

  it("the node's JSON-RPC errors are still classified: a revert, too little balance, running out of gas", async () => {
    const r = httpReader();
    const reverted = revert(attestGateAbi, "ActionExpired", [1n, 2n]);
    reply = rpcReply({ error: { code: 3, message: "execution reverted", data: reverted.data } });
    await expect(r.simulate(call, P)).resolves.toEqual({ ok: false, error: "REVERTED", revertSelector: reverted.data.slice(0, 10) });
    await expect(r.consumed(GATE, HASH, P)).resolves.toBeNull();

    reply = rpcReply({ error: { code: -32003, message: "Insufficient funds for gas * price + value" } });
    await expect(r.simulate(call, P)).resolves.toEqual({ ok: false, error: "INSUFFICIENT_FUNDS", revertSelector: null });
    await expect(r.consumed(GATE, HASH, P)).rejects.toThrow(/Insufficient funds/);

    reply = rpcReply({ error: { code: -32000, message: "out of gas" } });
    await expect(r.simulate(call, P)).resolves.toEqual({ ok: false, error: "OUT_OF_GAS", revertSelector: null });
    await expect(r.consumed(GATE, HASH, P)).resolves.toBeNull();
  });
});

describe("viemMandateReader: permission logs", () => {
  const selectors = [
    transferEvent,
    approvalEvent,
    approvalForAllEvent,
    agentKeySetEvent,
    mandateSetEvent,
    mandateRevokedEvent,
    passkeySetEvent,
    passkeyRotatedEvent,
  ].map((event) => toEventSelector(event));

  it("queries windows of at most 100 blocks that cover (P - 6,000, P] exactly, across the three contracts and eight events", async () => {
    await reader().permissionLogs(P - MANDATE_V1.permissionWindowBlocks + 1n, P, { agentId: AGENT, owner: OWNER });
    const filters = getLogsFilters().sort((a, b) => (BigInt(a.fromBlock) < BigInt(b.fromBlock) ? -1 : 1));
    expect(filters).toHaveLength(60);
    expect(BigInt(filters[0]?.fromBlock ?? "0x0")).toBe(P - 5_999n);
    expect(BigInt(filters.at(-1)?.toBlock ?? "0x0")).toBe(P);
    let next = P - 5_999n;
    for (const filter of filters) {
      const from = BigInt(filter.fromBlock);
      const to = BigInt(filter.toBlock);
      expect(from).toBe(next);
      expect(to - from).toBeLessThanOrEqual(99n);
      expect(to).toBeLessThanOrEqual(P);
      next = to + 1n;
      expect([filter.address].flat().map((a) => getAddress(a)).sort()).toEqual(
        [ADDRESSES.identityRegistry, ADDRESSES.forwarder, ADDRESSES.mandateRegistry].sort(),
      );
      expect([filter.topics[0]].flat().sort()).toEqual([...selectors].sort());
    }
    expect(next).toBe(P + 1n);
  });

  it("keeps only this agent's and this owner's events from the right emitter, sorted by (block, logIndex)", async () => {
    const from = P - 299n;
    const id = ADDRESSES.identityRegistry;
    const fwd = ADDRESSES.forwarder;
    const mr = ADDRESSES.mandateRegistry;
    rpc.logs.push(
      // kept
      eventLog(mr, mandateSetEvent, mandateSetArgs(AGENT), P - 10n, 2),
      eventLog(id, transferEvent, { from: OTHER_OWNER, to: OWNER, tokenId: AGENT }, P - 200n, 5),
      eventLog(id, approvalEvent, { owner: OWNER, approved: STRANGER, tokenId: AGENT }, P - 200n, 1),
      eventLog(id, approvalForAllEvent, { owner: OWNER, operator: STRANGER, approved: true }, P - 150n, 0),
      eventLog(fwd, agentKeySetEvent, { agentId: AGENT, owner: OWNER, key: STRANGER }, P - 100n, 3),
      eventLog(mr, mandateRevokedEvent, { agentId: AGENT, mandateHash: MANDATE_HASH, owner: OWNER }, P - 10n, 1),
      // dropped: another agent or owner
      eventLog(id, transferEvent, { from: OWNER, to: STRANGER, tokenId: OTHER_AGENT }, P - 120n, 0),
      eventLog(id, approvalEvent, { owner: OWNER, approved: STRANGER, tokenId: OTHER_AGENT }, P - 120n, 1),
      eventLog(id, approvalForAllEvent, { owner: OTHER_OWNER, operator: STRANGER, approved: true }, P - 120n, 2),
      eventLog(fwd, agentKeySetEvent, { agentId: OTHER_AGENT, owner: OWNER, key: STRANGER }, P - 120n, 3),
      eventLog(mr, mandateSetEvent, mandateSetArgs(OTHER_AGENT), P - 120n, 4),
      eventLog(mr, mandateRevokedEvent, { agentId: OTHER_AGENT, mandateHash: MANDATE_HASH, owner: OWNER }, P - 120n, 5),
      // dropped: the right event and agent, but the wrong emitter
      eventLog(fwd, transferEvent, { from: OWNER, to: STRANGER, tokenId: AGENT }, P - 90n, 0),
      eventLog(mr, approvalForAllEvent, { owner: OWNER, operator: STRANGER, approved: true }, P - 90n, 1),
      eventLog(id, agentKeySetEvent, { agentId: AGENT, owner: OWNER, key: STRANGER }, P - 90n, 2),
      eventLog(fwd, mandateSetEvent, mandateSetArgs(AGENT), P - 90n, 3),
      // dropped: outside [from, P]
      eventLog(id, transferEvent, { from: OWNER, to: STRANGER, tokenId: AGENT }, from - 1n, 0),
      eventLog(id, transferEvent, { from: OWNER, to: STRANGER, tokenId: AGENT }, P + 1n, 0),
    );
    const events = await reader().permissionLogs(from, P, { agentId: AGENT, owner: OWNER });
    const tx = (block: bigint, logIndex: number) => keccak256(toHex(`${block}:${logIndex}`));
    expect(events).toEqual([
      { block: P - 200n, logIndex: 1, txHash: tx(P - 200n, 1), emitter: "IdentityRegistry", event: "Approval" },
      { block: P - 200n, logIndex: 5, txHash: tx(P - 200n, 5), emitter: "IdentityRegistry", event: "Transfer" },
      { block: P - 150n, logIndex: 0, txHash: tx(P - 150n, 0), emitter: "IdentityRegistry", event: "ApprovalForAll" },
      { block: P - 100n, logIndex: 3, txHash: tx(P - 100n, 3), emitter: "AgentRequestForwarder", event: "AgentKeySet" },
      { block: P - 10n, logIndex: 1, txHash: tx(P - 10n, 1), emitter: "MandateRegistry", event: "MandateRevoked" },
      { block: P - 10n, logIndex: 2, txHash: tx(P - 10n, 2), emitter: "MandateRegistry", event: "MandateSet" },
    ]);
  });

  it("PasskeySet and PasskeyRotated for the agent are MandateRegistry permission events; another agent's are not", async () => {
    const mr = ADDRESSES.mandateRegistry;
    const fwd = ADDRESSES.forwarder;
    const key = (n: string) => keccak256(toHex(`passkey ${n}`));
    const rotated = (agentId: bigint) => ({ agentId, owner: OWNER, oldQx: key("old x"), oldQy: key("old y"), qx: key("x"), qy: key("y") });
    rpc.logs.push(
      // kept
      eventLog(mr, passkeySetEvent, { agentId: AGENT, owner: OWNER, qx: key("old x"), qy: key("old y") }, P - 30n, 0),
      eventLog(mr, passkeyRotatedEvent, rotated(AGENT), P - 20n, 4),
      // dropped: another agent
      eventLog(mr, passkeySetEvent, { agentId: OTHER_AGENT, owner: OWNER, qx: key("x"), qy: key("y") }, P - 25n, 0),
      eventLog(mr, passkeyRotatedEvent, rotated(OTHER_AGENT), P - 15n, 0),
      // dropped: the right event and agent, but the wrong emitter
      eventLog(fwd, passkeySetEvent, { agentId: AGENT, owner: OWNER, qx: key("x"), qy: key("y") }, P - 12n, 0),
      eventLog(fwd, passkeyRotatedEvent, rotated(AGENT), P - 11n, 0),
      // not a permission event (it moves no funds and grants no rights), so never asked for
      eventLog(mr, inboxKeySetEvent, { agentId: AGENT, owner: OWNER, x25519Pub: key("inbox") }, P - 5n, 0),
    );
    const events = await reader().permissionLogs(P - 99n, P, { agentId: AGENT, owner: OWNER });
    const tx = (block: bigint, logIndex: number) => keccak256(toHex(`${block}:${logIndex}`));
    expect(events).toEqual([
      { block: P - 30n, logIndex: 0, txHash: tx(P - 30n, 0), emitter: "MandateRegistry", event: "PasskeySet" },
      { block: P - 20n, logIndex: 4, txHash: tx(P - 20n, 4), emitter: "MandateRegistry", event: "PasskeyRotated" },
    ]);
  });

  it("runs at most `concurrency` eth_getLogs at once (default 8)", async () => {
    for (const [limit, expected] of [
      [undefined, 8],
      [3, 3],
    ] as const) {
      let inFlight = 0;
      let peak = 0;
      rpc.intercept = (method) => {
        if (method !== "eth_getLogs") return undefined;
        inFlight++;
        peak = Math.max(peak, inFlight);
        return new Promise((resolve) =>
          setTimeout(() => {
            inFlight--;
            resolve([]);
          }, 1),
        );
      };
      await reader(limit).permissionLogs(P - 5_999n, P, { agentId: AGENT, owner: OWNER });
      expect(peak).toBe(expected);
    }
  });

  it("a failing window throws (no partial event list)", async () => {
    let n = 0;
    rpc.intercept = (method) => {
      if (method === "eth_getLogs" && ++n === 7) throw new HttpRequestError({ url: "https://testnet-rpc.monad.xyz", status: 429 });
      return undefined;
    };
    await expect(reader().permissionLogs(P - 5_999n, P, { agentId: AGENT, owner: OWNER })).rejects.toThrow(/HTTP request failed/);
  });
});

describe("viemMandateReader: the MandateRegistry history (the registry valid at the block read)", () => {
  const V2_REGISTRY = getAddress("0xb60adb7d3cfb303dd501fef6ae136131e655e231");
  const FIRST = P - 1_000_000n;
  /** The first block v2 is valid at. */
  const SWITCH = P - 50n;
  const HISTORY: MandateContracts = {
    ...CONTRACTS,
    mandateRegistries: [
      { address: ADDRESSES.mandateRegistry, fromBlock: FIRST },
      { address: V2_REGISTRY, fromBlock: SWITCH },
    ],
  };

  function historyReader() {
    const { publicClient } = rpc.clients(account, { retryCount: 0 });
    return viemMandateReader({ publicClient, contracts: HISTORY });
  }

  const record = (setAtBlock: bigint) => [
    { allowedTargets: [TARGET], allowedSelectors: ["0x00000000"], maxValuePerTx: 2n, maxValuePerDay: 5n, validUntil: 1_800_000_000n },
    MANDATE_HASH,
    OWNER,
    setAtBlock,
  ];

  it("reader.mandate() calls getMandate on the registry valid at `at`", async () => {
    rpc
      .onCall(ADDRESSES.mandateRegistry, mandateRegistryAbi, "getMandate", () => record(FIRST + 1n))
      .onCall(V2_REGISTRY, mandateRegistryAbi, "getMandate", () => record(SWITCH));
    const r = historyReader();

    await expect(r.mandate(AGENT, SWITCH - 1n)).resolves.toMatchObject({ setAtBlock: FIRST + 1n });
    await expect(r.mandate(AGENT, SWITCH)).resolves.toMatchObject({ setAtBlock: SWITCH });
    await expect(r.mandate(AGENT, FIRST)).resolves.toMatchObject({ setAtBlock: FIRST + 1n });
    expect(ethCalls().map((c) => [getAddress((c.params[0] as { to: Address }).to), c.params[1]])).toEqual([
      [ADDRESSES.mandateRegistry, toHex(SWITCH - 1n)],
      [V2_REGISTRY, toHex(SWITCH)],
      [ADDRESSES.mandateRegistry, toHex(FIRST)],
    ]);

    // Before the first registry there is nothing to read: it throws, and asks the RPC nothing.
    await expect(r.mandate(AGENT, FIRST - 1n)).rejects.toBeInstanceOf(MandateRegistryNotDeployedError);
    expect(ethCalls()).toHaveLength(3);
  });

  it("reader.permissionLogs() asks eth_getLogs for the registry valid at toBlock only", async () => {
    const revoked = { agentId: AGENT, mandateHash: MANDATE_HASH, owner: OWNER };
    rpc.logs.push(
      eventLog(ADDRESSES.mandateRegistry, mandateRevokedEvent, revoked, SWITCH - 10n, 0), // P4, before the switch
      eventLog(ADDRESSES.mandateRegistry, mandateSetEvent, mandateSetArgs(AGENT), SWITCH + 5n, 0), // P4 after it: governs nothing
      eventLog(V2_REGISTRY, mandateSetEvent, mandateSetArgs(AGENT), SWITCH + 10n, 1), // v2
    );
    const tx = (block: bigint, logIndex: number) => keccak256(toHex(`${block}:${logIndex}`));
    const r = historyReader();

    // A window straddling the switch, ending at or after it: v2 only (P4's events before the switch can't change a verdict).
    const straddling = await r.permissionLogs(SWITCH - 99n, P, { agentId: AGENT, owner: OWNER });
    expect(straddling).toEqual([{ block: SWITCH + 10n, logIndex: 1, txHash: tx(SWITCH + 10n, 1), emitter: "MandateRegistry", event: "MandateSet" }]);
    const straddlingFilters = getLogsFilters();
    expect(straddlingFilters).toHaveLength(2);
    for (const filter of straddlingFilters) {
      expect([filter.address].flat().map((a) => getAddress(a)).sort()).toEqual([ADDRESSES.identityRegistry, ADDRESSES.forwarder, V2_REGISTRY].sort());
    }

    // A window ending just before the switch: P4 only.
    const before = await r.permissionLogs(SWITCH - 99n, SWITCH - 1n, { agentId: AGENT, owner: OWNER });
    expect(before).toEqual([{ block: SWITCH - 10n, logIndex: 0, txHash: tx(SWITCH - 10n, 0), emitter: "MandateRegistry", event: "MandateRevoked" }]);
    for (const filter of getLogsFilters().slice(straddlingFilters.length)) {
      expect([filter.address].flat().map((a) => getAddress(a)).sort()).toEqual(
        [ADDRESSES.identityRegistry, ADDRESSES.forwarder, ADDRESSES.mandateRegistry].sort(),
      );
    }
  });
});

describe("viemMandateReader: passkey events in the permission window", () => {
  /** The block the agent's current mandate was set in (its MandateSet log is at log index 1 there). */
  const S = P - 100n;
  const pinned = { number: P, hash: keccak256(toHex(P)), timestamp: 1_790_000_000n };
  const key = (n: string) => keccak256(toHex(`passkey ${n}`));

  /** collectInputs over the viem reader for a request inside its mandate, with `logs` in the window too. */
  async function verdictWith(logs: RpcLog[]) {
    rpc = new FakeRpc();
    rpc.blockNumber = P;
    rpc
      .onCall(ADDRESSES.identityRegistry, identityRegistryAbi, "ownerOf", () => OWNER)
      .onCall(ADDRESSES.mandateRegistry, mandateRegistryAbi, "getMandate", () => [
        { allowedTargets: [TARGET], allowedSelectors: ["0x00000000"], maxValuePerTx: 100n, maxValuePerDay: 1_000n, validUntil: pinned.timestamp + 86_400n },
        MANDATE_HASH,
        OWNER,
        S,
      ])
      .onCall(ADDRESSES.validationRegistry, validationRegistryAbi, "getAgentValidations", () => []);
    answerRawCall(TARGET, () => "0x");
    rpc.logs.push(eventLog(ADDRESSES.mandateRegistry, mandateSetEvent, { ...mandateSetArgs(AGENT), setAtBlock: S }, S, 1), ...logs);
    const request = {
      block: P - 3n,
      requestHash: keccak256(toHex("the request being checked")),
      chainId: 10_143,
      gate: GATE,
      agentId: AGENT,
      target: TARGET,
      value: 10n,
      data: "0x" as Hex,
      deadline: pinned.timestamp + 60n,
      salt: keccak256(toHex("salt")),
    };
    const inputs = await collectInputs({ reader: reader(), validator: VALIDATOR, request, pinned, cache: new Map() });
    return { events: inputs.permissions.events, reasons: evaluate(inputs).reasons };
  }

  it("a PasskeyRotated after the mandate's MandateSet fails PERMISSION_CHANGED_AFTER_MANDATE; a PasskeySet before it doesn't", async () => {
    const set = await verdictWith([eventLog(ADDRESSES.mandateRegistry, passkeySetEvent, { agentId: AGENT, owner: OWNER, qx: key("x"), qy: key("y") }, S - 10n, 0)]);
    expect(set.events).toEqual([
      expect.objectContaining({ block: S - 10n, emitter: "MandateRegistry", event: "PasskeySet", afterMandate: false }),
      expect.objectContaining({ block: S, emitter: "MandateRegistry", event: "MandateSet", afterMandate: false }),
    ]);
    expect(set.reasons).toEqual([]);

    const rotated = await verdictWith([
      eventLog(
        ADDRESSES.mandateRegistry,
        passkeyRotatedEvent,
        { agentId: AGENT, owner: OWNER, oldQx: key("x"), oldQy: key("y"), qx: key("new x"), qy: key("new y") },
        S,
        2,
      ),
    ]);
    expect(rotated.events).toEqual([
      expect.objectContaining({ block: S, logIndex: 1, event: "MandateSet", afterMandate: false }),
      expect.objectContaining({ block: S, logIndex: 2, emitter: "MandateRegistry", event: "PasskeyRotated", afterMandate: true }),
    ]);
    expect(rotated.reasons).toEqual(["PERMISSION_CHANGED_AFTER_MANDATE"]);
  });
});

describe("viemMandateReader: approval evidence and request logs", () => {
  const BASE_TS = 1_790_000_000n;
  /** About 3.3 blocks a second: block n carries BASE_TS + floor(10n / 33). */
  const tsOf = (n: bigint) => BASE_TS + (n * 10n) / 33n;
  const blocksAt = (ts: bigint, below: bigint) => {
    const blocks: bigint[] = [];
    for (let n = below - 2_000n; n <= below; n++) if (tsOf(n) === ts) blocks.push(n);
    return blocks;
  };

  function responseLog(requestHash: Hex, responseURI: string, blockNumber: bigint, logIndex: number): RpcLog {
    return eventLog(
      ADDRESSES.validationRegistry,
      validationResponseEvent,
      {
        validatorAddress: VALIDATOR,
        agentId: AGENT,
        requestHash,
        response: 100,
        responseURI,
        responseHash: keccak256(toHex(responseURI)),
        tag: "mandate-v1",
      },
      blockNumber,
      logIndex,
    );
  }

  beforeEach(() => {
    rpc.blockTimestamp = tsOf;
  });

  it("finds the response among exactly the blocks that carry its timestamp, and takes the last one", async () => {
    const block = P - 1_000n;
    const ts = tsOf(block);
    const sameSecond = blocksAt(ts, P);
    expect(sameSecond.length).toBeGreaterThanOrEqual(3);
    const first = sameSecond[0] as bigint;
    const last = sameSecond.at(-1) as bigint;
    rpc.logs.push(
      responseLog(HASH, "data:application/json,earlier-second", first - 1n, 0),
      responseLog(HASH, "data:application/json,first", first, 4),
      responseLog(OTHER_HASH, "data:application/json,other-request", last, 9),
      responseLog(HASH, "data:application/json,last", last, 2),
      responseLog(HASH, "data:application/json,later-second", last + 1n, 0),
    );
    await expect(reader().responseEvidence(HASH, ts, P)).resolves.toBe("data:application/json,last");

    const filters = getLogsFilters();
    expect(filters).toHaveLength(1);
    expect(BigInt(filters[0]?.fromBlock ?? "0x0")).toBe(first);
    expect(BigInt(filters[0]?.toBlock ?? "0x0")).toBe(last);
    expect(getAddress(filters[0]?.address as Address)).toBe(ADDRESSES.validationRegistry);
    expect(filters[0]?.topics[0]).toBe(toEventSelector(validationResponseEvent));
    expect(filters[0]?.topics[3]).toBe(HASH);
  });

  it("finds a response from about 25 h before P in a bounded number of block lookups, never above notAfter", async () => {
    const block = P - 296_000n;
    const ts = tsOf(block);
    rpc.logs.push(responseLog(HASH, "data:application/json,old", block, 0));
    await expect(reader().responseEvidence(HASH, ts, P)).resolves.toBe("data:application/json,old");
    const lookups = rpc.calls.filter((c) => c.method === "eth_getBlockByNumber");
    expect(lookups.length).toBeLessThanOrEqual(40);
    for (const lookup of lookups) expect(BigInt(lookup.params[0] as Hex)).toBeLessThanOrEqual(P);
    for (const filter of getLogsFilters()) expect(BigInt(filter.toBlock)).toBeLessThanOrEqual(P);
  });

  it("responseLog is the same last log, with the block and log index it was found at", async () => {
    const ts = tsOf(P - 1_000n);
    const sameSecond = blocksAt(ts, P);
    const last = sameSecond.at(-1) as bigint;
    rpc.logs.push(
      responseLog(HASH, "data:application/json,first", sameSecond[0] as bigint, 4),
      responseLog(HASH, "data:application/json,last", last, 2),
      responseLog(HASH, "data:application/json,later-second", last + 1n, 0),
    );
    const r = reader();
    await expect(r.responseLog(HASH, ts, P)).resolves.toEqual({ uri: "data:application/json,last", block: last, logIndex: 2 });
    await expect(r.responseEvidence(HASH, ts, P)).resolves.toBe("data:application/json,last");
    await expect(r.responseLog(OTHER_HASH, ts, P)).resolves.toBeNull();
    await expect(r.responseLog(HASH, tsOf(P) + 10n, P)).resolves.toBeNull();
  });

  it("stops at notAfter even when later blocks share the timestamp", async () => {
    const ts = tsOf(P - 500n);
    const sameSecond = blocksAt(ts, P);
    const notAfter = sameSecond[1] as bigint;
    rpc.logs.push(responseLog(HASH, "data:application/json,visible", sameSecond[0] as bigint, 0));
    rpc.logs.push(responseLog(HASH, "data:application/json,after-notAfter", sameSecond[2] as bigint, 0));
    await expect(reader().responseEvidence(HASH, ts, notAfter)).resolves.toBe("data:application/json,visible");
    expect(BigInt(getLogsFilters()[0]?.toBlock ?? "0x0")).toBe(notAfter);
  });

  it("is null when no log matches at that timestamp", async () => {
    const ts = tsOf(P - 1_000n);
    rpc.logs.push(responseLog(OTHER_HASH, "data:application/json,other", P - 1_000n, 0));
    await expect(reader().responseEvidence(HASH, ts, P)).resolves.toBeNull();
  });

  it("is null when the first block at or after the timestamp is later than it (no block carries it)", async () => {
    rpc.blockTimestamp = (n) => BASE_TS + 2n * n; // one block every other second
    await expect(reader().responseEvidence(HASH, BASE_TS + 2n * (P - 100n) + 1n, P)).resolves.toBeNull();
    expect(getLogsFilters()).toHaveLength(0);
  });

  it("is null when no block at or before notAfter carries that timestamp", async () => {
    await expect(reader().responseEvidence(HASH, tsOf(P) + 10n, P)).resolves.toBeNull();
    expect(getLogsFilters()).toHaveLength(0);
  });

  it("a block lookup failure throws, never null", async () => {
    rpc.intercept = (method) => {
      if (method === "eth_getBlockByNumber") throw new HttpRequestError({ url: "https://testnet-rpc.monad.xyz", status: 429 });
      return undefined;
    };
    await expect(reader().responseEvidence(HASH, tsOf(P - 10n), P)).rejects.toThrow(/HTTP request failed/);
  });

  it("requestUri reads the ValidationRequest log in exactly that block", async () => {
    const block = P - 42n;
    rpc.logs.push(
      eventLog(
        ADDRESSES.validationRegistry,
        validationRequestEvent,
        { validatorAddress: VALIDATOR, agentId: AGENT, requestURI: "data:application/json,request", requestHash: HASH },
        block,
        0,
      ),
    );
    const r = reader();
    await expect(r.requestUri(HASH, block)).resolves.toBe("data:application/json,request");
    await expect(r.requestUri(OTHER_HASH, block)).resolves.toBeNull();
    const [filter] = getLogsFilters();
    expect(BigInt(filter?.fromBlock ?? "0x0")).toBe(block);
    expect(BigInt(filter?.toBlock ?? "0x0")).toBe(block);
    expect(filter?.topics[3]).toBe(HASH);
  });
});

describe("viemMandateReader: CCIP-Read is never followed", () => {
  // EIP-3668: a contract reverts with OffchainLookup to ask the caller to fetch from these URLs and
  // call it back. Following it would fetch attacker-chosen URLs and re-call at `latest`, not at P.
  const offchainLookupAbi = [
    {
      type: "error",
      name: "OffchainLookup",
      inputs: [
        { name: "sender", type: "address" },
        { name: "urls", type: "string[]" },
        { name: "callData", type: "bytes" },
        { name: "callbackFunction", type: "bytes4" },
        { name: "extraData", type: "bytes" },
      ],
    },
  ] as const;
  const CALLBACK = "0xdeadbeef";
  const lookup = (sender: Address) =>
    encodeErrorResult({
      abi: offchainLookupAbi,
      errorName: "OffchainLookup",
      args: [sender, ["http://127.0.0.1:9/{sender}/{data}.json"], "0x1234", CALLBACK, "0x"],
    });

  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ data: "0x" }), { status: 200, headers: { "content-type": "application/json" } }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** `to` reverts with OffchainLookup, and would answer its callback with `callbackAnswer`. */
  function offchainLookupAt(to: Address, callbackAnswer: Hex) {
    rpc.intercept = (method, params) => {
      if (method !== "eth_call") return undefined;
      const call = params[0] as { to: Address; data?: Hex; input?: Hex };
      if (getAddress(call.to) !== to) return undefined;
      if ((call.data ?? call.input ?? "0x").startsWith(CALLBACK)) return callbackAnswer;
      throw new RevertError(lookup(to));
    };
  }

  function expectNoFollowUp() {
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ethCalls()).toHaveLength(1);
    for (const call of ethCalls()) expect(call.params[1]).toBe(toHex(P));
  }

  it("simulate: an OffchainLookup revert is REVERTED with its selector, with no fetch and no second call", async () => {
    offchainLookupAt(TARGET, "0x");
    await expect(reader().simulate({ from: GATE, to: TARGET, value: 1n, data: "0x12345678", gas: 1_000_000n }, P)).resolves.toEqual({
      ok: false,
      error: "REVERTED",
      revertSelector: "0x556f1830",
    });
    expectNoFollowUp();
  });

  it("consumed: an OffchainLookup revert reads as null (a revert), with no fetch and no second call", async () => {
    offchainLookupAt(GATE, encodeAbiParameters([{ type: "bool" }], [false]));
    await expect(reader().consumed(GATE, HASH, P)).resolves.toBeNull();
    expectNoFollowUp();
  });

  it("a registry read that reverts with OffchainLookup throws, with no fetch and no second call", async () => {
    offchainLookupAt(ADDRESSES.identityRegistry, encodeAbiParameters([{ type: "address" }], [OWNER]));
    await expect(reader().ownerOf(AGENT, P)).rejects.toThrow();
    expectNoFollowUp();
  });
});

describe("viemMandateReader: an approval through a gate with no code counts toward spend", () => {
  it("collectInputs records it as consumed: null, counted: true (fail closed), instead of failing", async () => {
    const CODELESS = getAddress("0x0000000000000000000000000000000000000e0a");
    const pinned = { number: P, hash: keccak256(toHex(P)), timestamp: 1_790_000_000n };
    const parts = {
      chainId: 10_143,
      gate: CODELESS,
      agentId: AGENT,
      target: TARGET,
      value: 7n,
      dataHash: keccak256("0x"),
      deadline: pinned.timestamp - 60n, // expired: it counts only because consumed() is unknown
      salt: keccak256(toHex("through a codeless gate")),
    };
    const approval = computeRequestHashFromParts({ ...parts, validator: VALIDATOR });
    rpc
      .onCall(ADDRESSES.identityRegistry, identityRegistryAbi, "ownerOf", () => OWNER)
      .onCall(ADDRESSES.mandateRegistry, mandateRegistryAbi, "getMandate", () => [
        { allowedTargets: [TARGET], allowedSelectors: ["0x00000000"], maxValuePerTx: 100n, maxValuePerDay: 1_000n, validUntil: pinned.timestamp + 86_400n },
        MANDATE_HASH,
        OWNER,
        P - 10_000n,
      ])
      .onCall(ADDRESSES.validationRegistry, validationRegistryAbi, "getAgentValidations", () => [approval])
      .onCall(ADDRESSES.validationRegistry, validationRegistryAbi, "getValidationStatus", () => [
        VALIDATOR,
        AGENT,
        100,
        keccak256(toHex("evidence")),
        "mandate-v1",
        pinned.timestamp - 600n,
      ]);
    rpc.intercept = (method, params) => {
      if (method !== "eth_call") return undefined;
      const to = getAddress((params[0] as { to: Address }).to);
      return to === CODELESS || to === TARGET ? "0x" : undefined; // no code at either: the calls succeed with no data
    };
    const { publicClient } = rpc.clients(account, { retryCount: 0 });
    const request = {
      block: P - 3n,
      requestHash: keccak256(toHex("the request being checked")),
      chainId: 10_143,
      gate: GATE,
      agentId: AGENT,
      target: TARGET,
      value: 10n,
      data: "0x" as Hex,
      deadline: pinned.timestamp + 60n,
      salt: keccak256(toHex("salt")),
    };

    const inputs = await collectInputs({
      reader: viemMandateReader({ publicClient, contracts: CONTRACTS }),
      validator: VALIDATOR,
      request,
      pinned,
      cache: new Map([[approval, parts]]),
    });

    expect(inputs.spend).toEqual({
      since: pinned.timestamp - MANDATE_V1.spendWindowSeconds,
      total: 7n,
      entries: [{ requestHash: approval, approvedAt: pinned.timestamp - 600n, gate: CODELESS, value: 7n, deadline: parts.deadline, consumed: null, counted: true }],
    });
  });
});

describe("viemMandateReader: one RPC budget across a whole collection", () => {
  const BASE_TS = 1_790_000_000n;
  const tsOf = (n: bigint) => BASE_TS + (n * 10n) / 33n;
  const pinned = { number: P, hash: keccak256(toHex(P)), timestamp: tsOf(P) };

  /** collectInputs over the viem reader: 12 approvals (2 needing evidence lookups), 60 log windows, a simulation. */
  async function collectWith(concurrency: number | undefined): Promise<MandateInputs> {
    rpc.blockTimestamp = tsOf;
    rpc.delayMs = 1;
    const statuses = new Map<Hex, readonly unknown[]>();
    const hashes: Hex[] = [];
    const cache: PreimageCache = new Map();
    for (let i = 0; i < 12; i++) {
      const parts = {
        chainId: 10_143,
        gate: GATE,
        agentId: AGENT,
        target: TARGET,
        value: 10n,
        dataHash: keccak256("0x"),
        deadline: pinned.timestamp,
        salt: keccak256(toHex(`budget ${i}`)),
      };
      const requestHash = computeRequestHashFromParts({ ...parts, validator: VALIDATOR });
      const approvedAt = P - 1_000n - BigInt(i) * 50n;
      const evidence = encodeCanonicalJsonDataUri({
        schema: "attest8004.evidence.v1",
        validator: "mandate-v1",
        requestHash,
        score: 100,
        reasons: [],
        request: {
          block: (approvedAt - 1n).toString(),
          chainId: parts.chainId,
          gate: parts.gate,
          agentId: parts.agentId.toString(),
          target: parts.target,
          value: parts.value.toString(),
          dataHash: parts.dataHash,
          selector: "0x00000000",
          deadline: parts.deadline.toString(),
          salt: parts.salt,
        },
      });
      hashes.push(requestHash);
      statuses.set(requestHash, [VALIDATOR, AGENT, 100, evidence.hash, "mandate-v1", tsOf(approvedAt)]);
      if (i < 10) {
        cache.set(requestHash, parts);
      } else {
        rpc.logs.push(
          eventLog(
            ADDRESSES.validationRegistry,
            validationResponseEvent,
            { validatorAddress: VALIDATOR, agentId: AGENT, requestHash, response: 100, responseURI: evidence.uri, responseHash: evidence.hash, tag: "mandate-v1" },
            approvedAt,
            0,
          ),
        );
      }
      expect(computeActionHashFromParts(parts)).toMatch(/^0x/);
    }
    rpc
      .onCall(ADDRESSES.identityRegistry, identityRegistryAbi, "ownerOf", () => OWNER)
      .onCall(ADDRESSES.mandateRegistry, mandateRegistryAbi, "getMandate", () => [
        { allowedTargets: [TARGET], allowedSelectors: ["0x00000000"], maxValuePerTx: 100n, maxValuePerDay: 1_000n, validUntil: pinned.timestamp + 86_400n },
        MANDATE_HASH,
        OWNER,
        P - 10_000n,
      ])
      .onCall(ADDRESSES.validationRegistry, validationRegistryAbi, "getAgentValidations", () => hashes)
      .onCall(ADDRESSES.validationRegistry, validationRegistryAbi, "getValidationStatus", ([hash]) => statuses.get(hash as Hex))
      .onCall(GATE, attestGateAbi, "consumed", () => true);
    answerRawCall(TARGET, () => "0x");

    const { publicClient } = rpc.clients(account, { retryCount: 0 });
    const r = viemMandateReader({ publicClient, contracts: CONTRACTS, ...(concurrency ? { concurrency } : {}) });
    const request = {
      block: P - 3n,
      requestHash: keccak256(toHex("the request being checked")),
      chainId: 10_143,
      gate: GATE,
      agentId: AGENT,
      target: TARGET,
      value: 10n,
      data: "0x" as Hex,
      deadline: pinned.timestamp + 60n,
      salt: keccak256(toHex("salt")),
    };
    return collectInputs({ reader: r, validator: VALIDATOR, request, pinned, cache });
  }

  it.each([
    [undefined, 8],
    [3, 3],
  ] as const)("with concurrency %s, at most %i RPCs are ever in flight", async (concurrency, limit) => {
    const inputs = await collectWith(concurrency);
    expect(inputs.spend).toEqual({ since: pinned.timestamp - MANDATE_V1.spendWindowSeconds, entries: expect.any(Array), total: 120n });
    expect(rpc.calls.filter((c) => c.method === "eth_getLogs").length).toBeGreaterThanOrEqual(62); // 60 windows + 2 evidence lookups
    expect(rpc.peakInFlight).toBe(limit);
  });

  it("two readers sharing one limit keep at most N requests in flight", async () => {
    rpc.delayMs = 5;
    rpc.onCall(ADDRESSES.identityRegistry, identityRegistryAbi, "ownerOf", () => OWNER);
    const shared = concurrencyLimit(2);
    const r1 = viemMandateReader({ publicClient: rpc.clients(account, { retryCount: 0 }).publicClient, contracts: CONTRACTS, limit: shared });
    const r2 = viemMandateReader({ publicClient: rpc.clients(account, { retryCount: 0 }).publicClient, contracts: CONTRACTS, limit: shared });

    await Promise.all([
      r1.ownerOf(AGENT, P),
      r1.ownerOf(AGENT, P),
      r1.ownerOf(AGENT, P),
      r2.ownerOf(AGENT, P),
      r2.ownerOf(AGENT, P),
      r2.ownerOf(AGENT, P),
    ]);

    expect(rpc.peakInFlight).toBe(2);
  });
});
