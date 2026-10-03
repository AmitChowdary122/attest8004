import {
  attestGateAbi,
  agentKeySetEvent,
  identityRegistryAbi,
  mandateRegistryAbi,
  validationRegistryAbi,
  validationRequestEvent,
  validationResponseEvent,
} from "@attest8004/sdk";
import {
  BaseError,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  getAddress,
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
import { beforeEach, describe, expect, it } from "vitest";
import { FakeRpc, RevertError, revert, type RpcLog } from "../../../packages/sdk/test/helpers/fake-rpc.ts";
import { MANDATE_V1 } from "../src/params.ts";
import { viemMandateReader, type MandateAddresses } from "../src/reader.ts";

const ADDRESSES: MandateAddresses = {
  validationRegistry: getAddress("0xc4a4d0ceb3971cbe7a2536494ac106f2cd9f9a8f"),
  identityRegistry: getAddress("0x8004a818bfb912233c491871b3d84c89a494bd9e"),
  forwarder: getAddress("0x1451f3c36545b191d3642f759d59f21dcfd657b2"),
  mandateRegistry: getAddress("0x2523197373ef813e19b5b14ef2984130868cd17c"),
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
  return viemMandateReader({ publicClient, addresses: ADDRESSES, ...(concurrency ? { concurrency } : {}) });
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

describe("viemMandateReader: consumed() is null only for a deterministic call failure", () => {
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

describe("viemMandateReader: permission logs", () => {
  const selectors = [transferEvent, approvalEvent, approvalForAllEvent, agentKeySetEvent, mandateSetEvent, mandateRevokedEvent].map(
    (event) => toEventSelector(event),
  );

  it("queries windows of at most 100 blocks that cover (P - 6,000, P] exactly, across the three contracts and six events", async () => {
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
