import { canonicalJson } from "@attest8004/sdk";
import type { MandateInputs, MandateRecord, PinnedBlock, Simulation } from "@attest8004/validator-mandate";
import { encodeErrorResult, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { RiskReader } from "../src/reader.ts";
import { capOutput, initialScope, ONCHAIN_TOOLS, runTool, TOOL_DEFINITIONS, type ToolContext } from "../src/tools.ts";
import type { CallFrame, TraceResult } from "../src/trace.ts";
import type { JsonValue } from "../src/types.ts";

/** A hex literal, typed as `Hex` (avoids TS widening a bare string literal to `string`). */
function hex(value: string): Hex {
  return value as Hex;
}

/** `{ok: true, frame}`, typed as a `TraceResult` (avoids `ok` widening to `boolean`). */
function okTrace(frame: CallFrame): TraceResult {
  return { ok: true, frame };
}

const GATE = getAddress("0x23bfbd12545ccd1501dda1b65a54518fd6212a96");
const TARGET = getAddress("0xeeebba55620afc42e9c88b5d962476367b8da338");
const OWNER = getAddress("0x3efeb3cf2fb54a7d99abe90aab786ce5a831a8cf");
const SINK = getAddress("0xc8702ca01e934f0568ea43b354c17ec7749d313f");
const OUT_OF_SCOPE = getAddress(`0x${"00".repeat(18)}dead`);
const AGENT = 1_984n;
const P: PinnedBlock = { number: 10_000_000n, hash: keccak256(toHex(10_000_000n)), timestamp: 1_790_000_000n };

const REQUEST: MandateInputs["request"] = {
  block: P.number - 3n,
  requestHash: keccak256(toHex("request")),
  chainId: 10_143,
  gate: GATE,
  agentId: AGENT,
  target: TARGET,
  value: 1_000_000_000_000_000n,
  data: "0x",
  deadline: P.timestamp + 60n,
  salt: keccak256(toHex("salt")),
};

function fakeFrame(overrides: Partial<CallFrame> = {}): CallFrame {
  return { type: "CALL", from: GATE, to: TARGET, value: toHex(REQUEST.value), input: "0x", ...overrides };
}

function makeReader(overrides: Partial<RiskReader> = {}): RiskReader {
  const defaults: RiskReader = {
    chainId: vi.fn(async () => 10_143),
    finalized: vi.fn(async () => P),
    block: vi.fn(async () => P),
    mandate: vi.fn(async () => null),
    ownerOf: vi.fn(async () => OWNER),
    agentValidations: vi.fn(async () => []),
    status: vi.fn(async () => {
      throw new Error("status: not used by tools.ts");
    }),
    consumed: vi.fn(async () => null),
    permissionLogs: vi.fn(async () => []),
    simulate: vi.fn(async (): Promise<Simulation> => ({ ok: true })),
    responseEvidence: vi.fn(async () => null),
    responseLog: vi.fn(async () => null),
    requestUri: vi.fn(async () => null),
    trace: vi.fn(async () => okTrace(fakeFrame())),
    code: vi.fn(async () => hex("0x")),
    balance: vi.fn(async () => 0n),
    nonce: vi.fn(async () => 0n),
    agentOwner: vi.fn(async () => null),
    agentsOwned: vi.fn(async () => 0n),
    reputationClients: vi.fn(async () => []),
    reputationSummary: vi.fn(async (_agentId: bigint, _clients: Address[], _at: bigint) => ({ count: 0n, value: 0n, decimals: 0 })),
  };
  return { ...defaults, ...overrides };
}

function makeCtx(reader: RiskReader, scope?: Set<string>): ToolContext {
  return { reader, pinned: P, request: REQUEST, scope: scope ?? initialScope(REQUEST, OWNER, null) };
}

describe("ONCHAIN_TOOLS and TOOL_DEFINITIONS", () => {
  it("lists exactly the five onchain tools, and TOOL_DEFINITIONS matches their names and no-arg/one-arg shape", () => {
    expect(ONCHAIN_TOOLS).toEqual(["get_mandate", "simulate_action", "recent_permission_events", "counterparty_onchain", "erc8004_reputation"]);
    expect(TOOL_DEFINITIONS.map((t) => t.function.name)).toEqual(ONCHAIN_TOOLS);
    const byName = new Map(TOOL_DEFINITIONS.map((t) => [t.function.name, t]));
    expect(byName.get("get_mandate")?.function.parameters.required).toEqual([]);
    expect(byName.get("counterparty_onchain")?.function.parameters.required).toEqual(["address"]);
    expect(byName.get("erc8004_reputation")?.function.parameters.required).toEqual(["agentId"]);
  });
});

describe("runTool: arguments", () => {
  it("bad JSON gives INVALID_ARGUMENTS, and keeps the raw string as `arguments`", async () => {
    const ctx = makeCtx(makeReader());
    const result = await runTool("counterparty_onchain", "not json", ctx);
    expect(result.output).toEqual({ error: "INVALID_ARGUMENTS" });
    expect(result.arguments).toBe("not json");
    expect(result.onchain).toBe(true);
  });

  it("valid JSON of the wrong shape gives INVALID_ARGUMENTS", async () => {
    const ctx = makeCtx(makeReader());
    const result = await runTool("counterparty_onchain", JSON.stringify({ addr: TARGET }), ctx);
    expect(result.output).toEqual({ error: "INVALID_ARGUMENTS" });
  });

  it("an unknown tool name gives UNKNOWN_TOOL, onchain: false, never throws", async () => {
    const ctx = makeCtx(makeReader());
    const result = await runTool("made_up_tool", "{}", ctx);
    expect(result.output).toEqual({ error: "UNKNOWN_TOOL" });
    expect(result.onchain).toBe(false);
  });

  it("the two not-yet-implemented Nansen names also give UNKNOWN_TOOL (Task 9 adds them)", async () => {
    const ctx = makeCtx(makeReader());
    await expect(runTool("nansen_counterparty_profile", "{}", ctx)).resolves.toEqual(
      expect.objectContaining({ output: { error: "UNKNOWN_TOOL" } }),
    );
  });
});

describe("runTool: scope", () => {
  it("an out-of-scope address gives ADDRESS_OUT_OF_SCOPE with no reads", async () => {
    const reader = makeReader();
    const ctx = makeCtx(reader);
    expect(ctx.scope.has(OUT_OF_SCOPE.toLowerCase())).toBe(false);
    const result = await runTool("counterparty_onchain", JSON.stringify({ address: OUT_OF_SCOPE }), ctx);
    expect(result.output).toEqual({ error: "ADDRESS_OUT_OF_SCOPE" });
    expect(reader.code).not.toHaveBeenCalled();
    expect(reader.balance).not.toHaveBeenCalled();
    expect(reader.nonce).not.toHaveBeenCalled();
    expect(reader.agentsOwned).not.toHaveBeenCalled();
  });

  it("an in-scope address (the target) is read normally", async () => {
    const reader = makeReader();
    const ctx = makeCtx(reader);
    const result = await runTool("counterparty_onchain", JSON.stringify({ address: TARGET }), ctx);
    expect((result.output as { error?: string }).error).toBeUndefined();
    expect(reader.code).toHaveBeenCalled();
  });

  it("after simulate_action, the sink address from the trace is added to scope", async () => {
    const reader = makeReader({ trace: vi.fn(async () => okTrace(fakeFrame({ to: SINK }))) });
    const ctx = makeCtx(reader);
    expect(ctx.scope.has(SINK.toLowerCase())).toBe(false);
    await runTool("simulate_action", "{}", ctx);
    expect(ctx.scope.has(SINK.toLowerCase())).toBe(true);

    // and now a counterparty_onchain call on that newly-scoped address succeeds
    const result = await runTool("counterparty_onchain", JSON.stringify({ address: SINK }), ctx);
    expect((result.output as { error?: string }).error).toBeUndefined();
  });
});

describe("runTool: age probes (counterparty_onchain)", () => {
  it("a contract with no code at P-10,000 but code at P-1,000 gives youngerThanBlocks: '10000'", async () => {
    const codeAt = (address: Address, at: bigint): Hex => (P.number - at >= 10_000n ? "0x" : "0x6080");
    const reader = makeReader({ code: vi.fn(async (address, at) => codeAt(address, at)) });
    const ctx = makeCtx(reader);
    const result = await runTool("counterparty_onchain", JSON.stringify({ address: TARGET }), ctx);
    const output = result.output as { isContract: boolean; age: { youngerThanBlocks: string | null } };
    expect(output.isContract).toBe(true);
    expect(output.age.youngerThanBlocks).toBe("10000");
  });

  it("a contract with code at every probe gives youngerThanBlocks: null", async () => {
    const reader = makeReader({ code: vi.fn(async () => hex("0x6080")) });
    const ctx = makeCtx(reader);
    const result = await runTool("counterparty_onchain", JSON.stringify({ address: TARGET }), ctx);
    const output = result.output as { isContract: boolean; age: { youngerThanBlocks: string | null } };
    expect(output.isContract).toBe(true);
    expect(output.age.youngerThanBlocks).toBeNull();
  });

  it("an EOA with nonce 0 at P gives neverSent: true, with no probing of nonce()", async () => {
    const nonce = vi.fn(async () => 0n);
    const reader = makeReader({ code: vi.fn(async () => hex("0x")), nonce });
    const ctx = makeCtx(reader);
    const result = await runTool("counterparty_onchain", JSON.stringify({ address: TARGET }), ctx);
    const output = result.output as { isContract: boolean; age: { neverSent: boolean | null; youngerThanBlocks: string | null } };
    expect(output.isContract).toBe(false);
    expect(output.age).toEqual({ neverSent: true, youngerThanBlocks: null });
    expect(nonce).toHaveBeenCalledTimes(1); // only the read at P itself
  });

  it("an EOA with nonce > 0 at P, but nonce 0 at the 10,000-block probe, gives youngerThanBlocks: '10000'", async () => {
    const nonceAt = (at: bigint): bigint => (P.number - at >= 10_000n ? 0n : 3n);
    const reader = makeReader({ code: vi.fn(async () => hex("0x")), nonce: vi.fn(async (_address: Address, at: bigint) => nonceAt(at)) });
    const ctx = makeCtx(reader);
    const result = await runTool("counterparty_onchain", JSON.stringify({ address: TARGET }), ctx);
    const output = result.output as { age: { neverSent: boolean | null; youngerThanBlocks: string | null } };
    expect(output.age).toEqual({ neverSent: false, youngerThanBlocks: "10000" });
  });
});

describe("runTool: EIP-7702 delegate", () => {
  it("code 0xef0100<addr> gives delegatesTo: <addr>, and it is not treated as a contract", async () => {
    const delegate = getAddress("0x1234567890123456789012345678901234567890");
    const code = `0xef0100${delegate.slice(2).toLowerCase()}` as Hex;
    const reader = makeReader({ code: vi.fn(async () => code), nonce: vi.fn(async () => 5n) });
    const ctx = makeCtx(reader);
    const result = await runTool("counterparty_onchain", JSON.stringify({ address: TARGET }), ctx);
    const output = result.output as { isContract: boolean; delegatesTo: Address | null };
    expect(output.delegatesTo).toBe(delegate);
    expect(output.isContract).toBe(false);
  });
});

describe("runTool: untrusted text", () => {
  it("simulate_action's revert reason is returned in `untrusted`", async () => {
    const output = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
      errorName: "Error",
      args: ["nope"],
    });
    const reader = makeReader({
      trace: vi.fn(async () => okTrace(fakeFrame({ error: "execution reverted", output }))),
    });
    const ctx = makeCtx(reader);
    const result = await runTool("simulate_action", "{}", ctx);
    expect(result.untrusted).toEqual([{ source: "tool:simulate_action", text: "nope" }]);
  });

  it("a clean simulation has no untrusted text", async () => {
    const ctx = makeCtx(makeReader());
    const result = await runTool("simulate_action", "{}", ctx);
    expect(result.untrusted).toEqual([]);
  });
});

describe("runTool: erc8004_reputation", () => {
  it("getSummary isn't called when there are no clients", async () => {
    const reputationSummary = vi.fn(async (_agentId: bigint, _clients: Address[], _at: bigint) => ({ count: 0n, value: 0n, decimals: 0 }));
    const reader = makeReader({ reputationClients: vi.fn(async () => []), reputationSummary });
    const ctx = makeCtx(reader);
    const result = await runTool("erc8004_reputation", JSON.stringify({ agentId: "1984" }), ctx);
    expect(reputationSummary).not.toHaveBeenCalled();
    expect((result.output as { summary: unknown }).summary).toBeNull();
    expect((result.output as { clientCount: number }).clientCount).toBe(0);
  });

  it("20 clients send exactly the first 16 to getSummary", async () => {
    const clients = Array.from({ length: 20 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`));
    const reputationSummary = vi.fn(async (_agentId: bigint, _clients: Address[], _at: bigint) => ({ count: 20n, value: 42n, decimals: 0 }));
    const reader = makeReader({ reputationClients: vi.fn(async () => clients), reputationSummary });
    const ctx = makeCtx(reader);
    const result = await runTool("erc8004_reputation", JSON.stringify({ agentId: "1984" }), ctx);
    expect(reputationSummary).toHaveBeenCalledTimes(1);
    const [, sentClients] = reputationSummary.mock.calls[0] as [bigint, Address[], bigint];
    expect(sentClients).toHaveLength(16);
    expect(sentClients).toEqual(clients.slice(0, 16));
    expect((result.output as { clientCount: number }).clientCount).toBe(20);
  });

  it("owner is null when agentOwner reverts (no such agent)", async () => {
    const reader = makeReader({ agentOwner: vi.fn(async () => null) });
    const ctx = makeCtx(reader);
    const result = await runTool("erc8004_reputation", JSON.stringify({ agentId: "999999" }), ctx);
    expect((result.output as { owner: unknown }).owner).toBeNull();
  });
});

describe("capOutput", () => {
  it("fits within maxBytes already: returned unchanged, no `truncated`", () => {
    const value: JsonValue = { a: 1, b: [1, 2, 3] };
    expect(capOutput(value, 1_536)).toEqual(value);
  });

  it("cuts the longest array from its end and records truncated: {field, dropped}", () => {
    const value: JsonValue = { events: Array.from({ length: 200 }, (_, i) => ({ block: i.toString(), note: "x".repeat(20) })) };
    const capped = capOutput(value, 1_536) as { events: JsonValue[]; truncated: { field: string; dropped: number } };
    expect(new TextEncoder().encode(canonicalJson(capped)).length).toBeLessThanOrEqual(1_536);
    expect(capped.truncated.field).toBe("events");
    expect(capped.truncated.dropped).toBeGreaterThan(0);
    expect(capped.events.length).toBe(200 - capped.truncated.dropped);
  });

  it("is deterministic: capping the same input twice gives the same result", () => {
    const value: JsonValue = { events: Array.from({ length: 200 }, (_, i) => ({ block: i.toString(), note: "x".repeat(20) })) };
    expect(canonicalJson(capOutput(value, 1_536))).toBe(canonicalJson(capOutput(value, 1_536)));
  });

  it("never mutates the input", () => {
    const value: JsonValue = { events: Array.from({ length: 200 }, (_, i) => ({ block: i.toString() })) };
    const before = canonicalJson(value);
    capOutput(value, 1_536);
    expect(canonicalJson(value)).toBe(before);
  });
});

describe("runTool: size — every tool's output after capping is <= 1,536 bytes", () => {
  it("recent_permission_events with 300 synthetic events still fits", async () => {
    const events = Array.from({ length: 300 }, (_, i) => ({
      block: BigInt(i),
      logIndex: i,
      txHash: keccak256(toHex(`tx${i}`)),
      emitter: "MandateRegistry" as const,
      event: "MandateSet" as const,
      afterMandate: i % 2 === 0,
    }));
    const reader = makeReader({ permissionLogs: vi.fn(async () => events) });
    const ctx = makeCtx(reader);
    const result = await runTool("recent_permission_events", "{}", ctx);
    expect(new TextEncoder().encode(canonicalJson(result.output)).length).toBeLessThanOrEqual(1_536);
  });

  for (const name of ["get_mandate", "simulate_action", "counterparty_onchain", "erc8004_reputation"] as const) {
    it(`${name} fits within 1,536 bytes under normal conditions`, async () => {
      const reader = makeReader({
        mandate: vi.fn(async () => ({
          allowedTargets: [TARGET, GATE],
          allowedSelectors: ["0x00000000" as Hex, "0xa9059cbb" as Hex],
          maxValuePerTx: 2_000_000_000_000_000n,
          maxValuePerDay: 5_000_000_000_000_000n,
          validUntil: 1_800_000_000n,
          mandateHash: keccak256(toHex("mandate")),
          owner: OWNER,
          setAtBlock: P.number - 1_000_000n, // well before the 6,000-block permission window
        })) as unknown as RiskReader["mandate"],
        reputationClients: vi.fn(async () => Array.from({ length: 16 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`))),
        reputationSummary: vi.fn(async () => ({ count: 16n, value: 100n, decimals: 0 })),
      });
      const ctx = makeCtx(reader);
      const args = name === "counterparty_onchain" ? JSON.stringify({ address: TARGET }) : name === "erc8004_reputation" ? JSON.stringify({ agentId: "1984" }) : "{}";
      const result = await runTool(name, args, ctx);
      expect(new TextEncoder().encode(canonicalJson(result.output)).length).toBeLessThanOrEqual(1_536);
    });
  }
});

describe("runTool: determinism", () => {
  for (const name of ONCHAIN_TOOLS) {
    it(`${name}'s output is identical across two independent runs, and canonicalJson never throws`, async () => {
      const buildReader = () =>
        makeReader({
          mandate: vi.fn(async () => ({
            allowedTargets: [TARGET],
            allowedSelectors: ["0x00000000" as Hex],
            maxValuePerTx: 1_000n,
            maxValuePerDay: 2_000n,
            validUntil: 1_800_000_000n,
            mandateHash: keccak256(toHex("mandate")),
            owner: OWNER,
            setAtBlock: P.number - 1_000_000n, // well before the 6,000-block permission window
          })) as unknown as RiskReader["mandate"],
          reputationClients: vi.fn(async () => [OWNER]),
          reputationSummary: vi.fn(async () => ({ count: 1n, value: 5n, decimals: 0 })),
        });
      const args = name === "counterparty_onchain" ? JSON.stringify({ address: TARGET }) : name === "erc8004_reputation" ? JSON.stringify({ agentId: "1984" }) : "{}";

      const ctx1 = makeCtx(buildReader());
      const ctx2 = makeCtx(buildReader());
      const result1 = await runTool(name, args, ctx1);
      const result2 = await runTool(name, args, ctx2);

      expect(canonicalJson(result1.output)).toBe(canonicalJson(result2.output));
      expect(() => canonicalJson(result1.output)).not.toThrow();
    });
  }
});

describe("initialScope", () => {
  it("seeds target, gate, owner, and the mandate's allowed targets, lower-cased", () => {
    const mandate: MandateRecord = {
      allowedTargets: [SINK],
      allowedSelectors: [],
      maxValuePerTx: 0n,
      maxValuePerDay: 0n,
      validUntil: 0n,
      mandateHash: keccak256(toHex("m")),
      owner: OWNER,
      setAtBlock: 0n,
    };
    const scope = initialScope(REQUEST, OWNER, mandate);
    expect(scope).toEqual(new Set([TARGET.toLowerCase(), GATE.toLowerCase(), OWNER.toLowerCase(), SINK.toLowerCase()]));
  });

  it("with no mandate, seeds just target, gate and owner", () => {
    const scope = initialScope(REQUEST, OWNER, null);
    expect(scope).toEqual(new Set([TARGET.toLowerCase(), GATE.toLowerCase(), OWNER.toLowerCase()]));
  });
});
