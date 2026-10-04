import { identityRegistryAbi, mandateRegistryAbi, reputationRegistryAbi } from "@attest8004/sdk";
import { HttpRequestError, getAddress, keccak256, toHex, zeroHash, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeRpc, RevertError, revert } from "../../../packages/sdk/test/helpers/fake-rpc.ts";
import { checkRpcServesRiskV1, viemRiskReader, type RiskAddresses } from "../src/reader.ts";

const ADDRESSES: RiskAddresses = {
  validationRegistry: getAddress("0xc4a4d0ceb3971cbe7a2536494ac106f2cd9f9a8f"),
  identityRegistry: getAddress("0x8004a818bfb912233c491871b3d84c89a494bd9e"),
  forwarder: getAddress("0x1451f3c36545b191d3642f759d59f21dcfd657b2"),
  mandateRegistry: getAddress("0x2523197373ef813e19b5b14ef2984130868cd17c"),
  reputationRegistry: getAddress("0x8004b663056a597dffe9eccc1965a193b7388713"),
};
const GATE = getAddress("0x23bfbd12545ccd1501dda1b65a54518fd6212a96");
const TARGET = getAddress("0x00000000000000000000000000000000000000b2");
const SOMEONE = getAddress("0x00000000000000000000000000000000000000c3");
const AGENT = 1_984n;
const P = 70_000_000n;
const account = privateKeyToAccount(generatePrivateKey());

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
  return viemRiskReader({ publicClient, addresses: ADDRESSES, ...(concurrency ? { concurrency } : {}) });
}

function callsOf(method: string) {
  return rpc.calls.filter((c) => c.method === method);
}

describe("viemRiskReader: trace()", () => {
  const call = { from: GATE, to: TARGET, value: 1_000_000_000_000_000n, data: "0x" as Hex, gas: 1_000_000n };

  it("sends debug_traceCall with exactly [{from,to,value,data,gas}, '0x<P>', {tracer: callTracer}]", async () => {
    rpc.intercept = (method) => (method === "debug_traceCall" ? { type: "CALL", from: GATE, to: TARGET, value: toHex(call.value), input: "0x" } : undefined);
    const result = await reader().trace(call, P);
    expect(result).toEqual({ ok: true, frame: { type: "CALL", from: GATE, to: TARGET, value: toHex(call.value), input: "0x" } });

    const [sent] = callsOf("debug_traceCall");
    expect(sent?.params).toEqual([
      { from: GATE, to: TARGET, value: toHex(call.value), data: "0x", gas: toHex(1_000_000n) },
      toHex(P),
      { tracer: "callTracer" },
    ]);
  });

  it("JSON-RPC -32003 (insufficient funds) gives {ok: false, error: INSUFFICIENT_FUNDS}, not a throw", async () => {
    rpc.intercept = (method) => {
      if (method === "debug_traceCall") throw rpcError(-32003, "Insufficient funds for gas * price + value");
      return undefined;
    };
    await expect(reader().trace(call, P)).resolves.toEqual({ ok: false, error: "INSUFFICIENT_FUNDS" });
  });

  it("any other RPC or transport failure throws", async () => {
    rpc.intercept = (method) => {
      if (method === "debug_traceCall") throw new HttpRequestError({ url: "https://testnet-rpc.monad.xyz", status: 429 });
      return undefined;
    };
    await expect(reader().trace(call, P)).rejects.toThrow(/HTTP request failed/);
  });

  it.each([
    ["null", null],
    ["a bare string", "not a frame"],
    ["an object with no type/from", { foo: "bar" }],
  ] as const)("a malformed answer (%s) throws", async (_, answer) => {
    rpc.intercept = (method) => (method === "debug_traceCall" ? answer : undefined);
    await expect(reader().trace(call, P)).rejects.toThrow(/malformed RPC answer/);
  });
});

describe("viemRiskReader: code/balance/nonce", () => {
  it("reads eth_getCode/eth_getBalance/eth_getTransactionCount at exactly P", async () => {
    rpc.intercept = (method, params) => {
      if (method === "eth_getCode") return "0x6080";
      if (method === "eth_getBalance") return toHex(1_234n);
      if (method === "eth_getTransactionCount") return toHex(7n);
      return undefined;
    };
    const r = reader();
    await expect(r.code(TARGET, P)).resolves.toBe("0x6080");
    await expect(r.balance(TARGET, P)).resolves.toBe(1_234n);
    await expect(r.nonce(TARGET, P)).resolves.toBe(7n);
    for (const method of ["eth_getCode", "eth_getBalance", "eth_getTransactionCount"]) {
      for (const call of callsOf(method)) expect(call.params[1]).toBe(toHex(P));
    }
  });

  it("a malformed answer (null, a non-hex string) throws for each", async () => {
    rpc.intercept = (method) => (["eth_getCode", "eth_getBalance", "eth_getTransactionCount"].includes(method) ? null : undefined);
    const r = reader();
    await expect(r.code(TARGET, P)).rejects.toThrow(/malformed RPC answer/);
    await expect(r.balance(TARGET, P)).rejects.toThrow(/malformed RPC answer/);
    await expect(r.nonce(TARGET, P)).rejects.toThrow(/malformed RPC answer/);
  });

  it("a transport failure throws", async () => {
    rpc.intercept = (method) => {
      if (method === "eth_getCode") throw new HttpRequestError({ url: "https://testnet-rpc.monad.xyz", status: 429 });
      return undefined;
    };
    await expect(reader().code(TARGET, P)).rejects.toThrow(/HTTP request failed/);
  });

  it("an odd-length eth_getCode answer throws (fix round 1, finding 7: eth_getCode is DATA-encoded, whole bytes only — unlike eth_getBalance/eth_getTransactionCount's QUANTITY encoding, which allows odd length)", async () => {
    rpc.intercept = (method) => (method === "eth_getCode" ? "0x0" : undefined);
    await expect(reader().code(TARGET, P)).rejects.toThrow(/malformed RPC answer/);
  });

  it("eth_getBalance and eth_getTransactionCount still accept an odd-length (QUANTITY) answer", async () => {
    rpc.intercept = (method) => {
      if (method === "eth_getBalance") return "0x4d2"; // 1234, 3 hex digits
      if (method === "eth_getTransactionCount") return "0x7";
      return undefined;
    };
    const r = reader();
    await expect(r.balance(TARGET, P)).resolves.toBe(1_234n);
    await expect(r.nonce(TARGET, P)).resolves.toBe(7n);
  });
});

describe("viemRiskReader: agentOwner", () => {
  it("decodes ownerOf at P", async () => {
    rpc.onCall(ADDRESSES.identityRegistry, identityRegistryAbi, "ownerOf", () => SOMEONE);
    await expect(reader().agentOwner(AGENT, P)).resolves.toBe(SOMEONE);
    const [call] = callsOf("eth_call");
    expect(call?.params[1]).toBe(toHex(P));
  });

  it("ownerOf reverting (no such agent) gives null", async () => {
    rpc.onCall(ADDRESSES.identityRegistry, identityRegistryAbi, "ownerOf", () =>
      revert(identityRegistryAbi, "ERC721NonexistentToken", [AGENT]),
    );
    await expect(reader().agentOwner(AGENT, P)).resolves.toBeNull();
  });

  it("an RPC or transport error throws, never null", async () => {
    rpc.intercept = (method) => {
      if (method === "eth_call") throw new HttpRequestError({ url: "https://testnet-rpc.monad.xyz", status: 429 });
      return undefined;
    };
    await expect(reader().agentOwner(AGENT, P)).rejects.toThrow(/HTTP request failed/);
  });

  it("a malformed (non-hex) eth_call answer throws, not null", async () => {
    rpc.intercept = (method) => (method === "eth_call" ? 123 : undefined);
    await expect(reader().agentOwner(AGENT, P)).rejects.toThrow(/malformed RPC answer/);
  });
});

describe("viemRiskReader: agentsOwned, reputationClients, reputationSummary", () => {
  it("agentsOwned decodes the Identity Registry's balanceOf", async () => {
    rpc.onCall(ADDRESSES.identityRegistry, identityRegistryAbi, "balanceOf", () => 3n);
    await expect(reader().agentsOwned(SOMEONE, P)).resolves.toBe(3n);
  });

  it("reputationClients decodes getClients, checksummed", async () => {
    rpc.onCall(ADDRESSES.reputationRegistry, reputationRegistryAbi, "getClients", () => [SOMEONE.toLowerCase(), TARGET.toLowerCase()]);
    await expect(reader().reputationClients(AGENT, P)).resolves.toEqual([SOMEONE, TARGET]);
  });

  it("reputationSummary decodes count/value/decimals and sends exactly the given client list", async () => {
    rpc.onCall(ADDRESSES.reputationRegistry, reputationRegistryAbi, "getSummary", () => [5n, -12n, 2]);
    const clients = [SOMEONE, TARGET];
    await expect(reader().reputationSummary(AGENT, clients, P)).resolves.toEqual({ count: 5n, value: -12n, decimals: 2 });
    const [call] = callsOf("eth_call");
    expect(call?.params[1]).toBe(toHex(P));
  });

  it("getSummary with no clients reverts, and that throws here (callers must skip it instead)", async () => {
    rpc.onCall(ADDRESSES.reputationRegistry, reputationRegistryAbi, "getSummary", () =>
      new RevertError("0x08c379a0"),
    );
    await expect(reader().reputationSummary(AGENT, [], P)).rejects.toThrow();
  });
});

describe("viemRiskReader: agentsOwned is null on revert, never a throw (fix round 1, finding 5)", () => {
  it("balanceOf reverting (e.g. address zero's ERC721InvalidOwner) gives null", async () => {
    rpc.onCall(ADDRESSES.identityRegistry, identityRegistryAbi, "balanceOf", () => new RevertError("0x"));
    await expect(reader().agentsOwned(SOMEONE, P)).resolves.toBeNull();
  });

  it("an RPC or transport error throws, never null", async () => {
    rpc.intercept = (method) => {
      if (method === "eth_call") throw new HttpRequestError({ url: "https://testnet-rpc.monad.xyz", status: 429 });
      return undefined;
    };
    await expect(reader().agentsOwned(SOMEONE, P)).rejects.toThrow(/HTTP request failed/);
  });

  it("a malformed (non-hex) eth_call answer throws, not null", async () => {
    rpc.intercept = (method) => (method === "eth_call" ? 123 : undefined);
    await expect(reader().agentsOwned(SOMEONE, P)).rejects.toThrow(/malformed RPC answer/);
  });
});

describe("viemRiskReader: shares one limiter (default 8) with its wrapped mandate-v1 reads", () => {
  it("at most `concurrency` requests are ever in flight across both kinds of read", async () => {
    rpc.delayMs = 2;
    rpc.onCall(ADDRESSES.identityRegistry, identityRegistryAbi, "ownerOf", () => SOMEONE);
    rpc.intercept = (method) => (method === "eth_getCode" ? "0x" : undefined);
    const r = reader(3);
    await Promise.all([
      r.ownerOf(AGENT, P),
      r.ownerOf(AGENT, P),
      r.code(TARGET, P),
      r.code(TARGET, P),
      r.code(SOMEONE, P),
      r.code(GATE, P),
    ]);
    expect(rpc.peakInFlight).toBeLessThanOrEqual(3);
    expect(rpc.peakInFlight).toBeGreaterThan(0);
  });
});

describe("viemRiskReader: still a VerifyReader (mandate-v1's own methods pass through)", () => {
  it("finalized() and mandate() work unchanged, reading at P", async () => {
    rpc.finalizedNumber = P - 1n;
    rpc.onCall(ADDRESSES.mandateRegistry, mandateRegistryAbi, "getMandate", () => [
      { allowedTargets: [], allowedSelectors: [], maxValuePerTx: 0n, maxValuePerDay: 0n, validUntil: 0n },
      zeroHash,
      "0x0000000000000000000000000000000000000000",
      0n,
    ]);
    const r = reader();
    await expect(r.finalized()).resolves.toEqual({ number: P - 1n, hash: keccak256(toHex(P - 1n)), timestamp: expect.any(BigInt) });
    await expect(r.mandate(AGENT, P)).resolves.toBeNull(); // mandateHash zero: never set
  });
});

describe("checkRpcServesRiskV1: the service's startup checks (final review A4)", () => {
  const SECRET_URL = "https://rpc.secret-provider.example/v2/not-a-real-key-42";
  const okFrame = { type: "CALL", from: "0x0000000000000000000000000000000000000000", to: "0x0000000000000000000000000000000000000000", value: "0x0", input: "0x" };
  const check = () => checkRpcServesRiskV1(rpc.clients(account, { retryCount: 0 }).publicClient, ADDRESSES.identityRegistry);

  function answering(o: { trace?: () => unknown; code?: () => unknown } = {}) {
    rpc.intercept = (method) => {
      if (method === "debug_traceCall") return (o.trace ?? (() => okFrame))();
      if (method === "eth_getCode") return (o.code ?? (() => "0x6080"))();
      return undefined;
    };
  }

  it("makes one trivial debug_traceCall at latest with callTracer, and one eth_getCode of the Identity Registry at head - 2,000,000", async () => {
    answering();
    await expect(check()).resolves.toEqual({ historyBlock: P - 2_000_000n });
    expect(callsOf("debug_traceCall").map((c) => c.params)).toEqual([
      [{ from: "0x0000000000000000000000000000000000000000", to: "0x0000000000000000000000000000000000000000", value: "0x0", gas: toHex(21_000n) }, "latest", { tracer: "callTracer" }],
    ]);
    expect(callsOf("eth_getCode").map((c) => c.params)).toEqual([[ADDRESSES.identityRegistry, toHex(P - 2_000_000n)]]);
  });

  it("empty code at that block still passes: only whether the node serves the state is checked", async () => {
    answering({ code: () => "0x" });
    await expect(check()).resolves.toEqual({ historyBlock: P - 2_000_000n });
  });

  it("a head under 2,000,000 reads block 0", async () => {
    rpc.blockNumber = 1_234n;
    answering();
    await expect(check()).resolves.toEqual({ historyBlock: 0n });
    expect(callsOf("eth_getCode")[0]?.params).toEqual([ADDRESSES.identityRegistry, "0x0"]);
  });

  const traceFailures: Array<[string, () => unknown]> = [
    ["the method is refused", () => { throw rpcError(-32601, `the method debug_traceCall does not exist (${SECRET_URL})`); }],
    ["a transport failure", () => { throw new HttpRequestError({ url: SECRET_URL, status: 503 }); }],
    ["an answer that isn't a callTracer frame", () => ({ structLogs: [] })],
    ["a null answer", () => null],
  ];
  it.each(traceFailures)("debug_traceCall failing (%s) stops with fixed text, never the URL, before any history read", async (_name, trace) => {
    answering({ trace });
    const error = await check().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("the RPC must serve debug_traceCall (callTracer)");
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain("secret-provider");
    expect(callsOf("eth_getCode")).toEqual([]);
  });

  const historyFailures: Array<[string, () => unknown]> = [
    ["history the node no longer serves (-32602)", () => { throw rpcError(-32602, `Block requested not found (${SECRET_URL})`); }],
    ["a transport failure", () => { throw new HttpRequestError({ url: SECRET_URL, status: 429 }); }],
    ["a malformed answer", () => "0x123"],
    ["a null answer", () => null],
  ];
  it.each(historyFailures)("eth_getCode 2,000,000 blocks back failing (%s) stops with fixed text, never the URL", async (_name, code) => {
    answering({ code });
    const error = await check().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("the RPC must serve state 2,000,000 blocks back");
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain("secret-provider");
  });
});
