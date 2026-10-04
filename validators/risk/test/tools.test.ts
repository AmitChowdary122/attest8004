import { canonicalJson } from "@attest8004/sdk";
import type { MandateInputs, MandateRecord, PinnedBlock, Simulation } from "@attest8004/validator-mandate";
import { encodeErrorResult, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { TOOL_NAMES } from "../src/findings.ts";
import type { NansenClient } from "../src/nansen.ts";
import { RISK_V1 } from "../src/params.ts";
import type { RiskReader } from "../src/reader.ts";
import { capOutput, initialScope, NANSEN_TOOLS, ONCHAIN_TOOLS, runTool, TOOL_DEFINITIONS, type ToolContext } from "../src/tools.ts";
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

/** A `NansenClient` that is `available: false` (today's default — no `NANSEN_API_KEY`), never calling `fetch`. */
function makeNansen(overrides: Partial<NansenClient> = {}): NansenClient {
  const defaults: NansenClient = {
    available: false,
    reason: "NANSEN_API_KEY is not set",
    profile: vi.fn(async () => ({ available: false, reason: "NANSEN_API_KEY is not set" })),
    flows: vi.fn(async () => ({ available: false, reason: "NANSEN_API_KEY is not set" })),
  };
  return { ...defaults, ...overrides };
}

function makeCtx(reader: RiskReader, scope?: Set<string>, nansen?: NansenClient): ToolContext {
  return { reader, pinned: P, request: REQUEST, scope: scope ?? initialScope(REQUEST, OWNER, null), nansen: nansen ?? makeNansen() };
}

describe("ONCHAIN_TOOLS, NANSEN_TOOLS and TOOL_DEFINITIONS", () => {
  it("lists exactly the five onchain tools and the two Nansen tools, matching findings.ts's TOOL_NAMES", () => {
    expect(ONCHAIN_TOOLS).toEqual(["get_mandate", "simulate_action", "recent_permission_events", "counterparty_onchain", "erc8004_reputation"]);
    expect(NANSEN_TOOLS).toEqual(["nansen_counterparty_profile", "nansen_flows"]);
    expect([...ONCHAIN_TOOLS, ...NANSEN_TOOLS]).toEqual(TOOL_NAMES);
  });

  it("TOOL_DEFINITIONS matches all seven names, in TOOL_NAMES order, and each one's no-arg/one-arg shape", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.function.name)).toEqual(TOOL_NAMES);
    const byName = new Map(TOOL_DEFINITIONS.map((t) => [t.function.name, t]));
    const paramsOf = (name: string) => byName.get(name)?.function.parameters as { required?: string[]; additionalProperties?: boolean } | undefined;
    // The no-argument tools (Task 13 ruling): a plain empty object schema, with no additionalProperties
    // false and no required list, so a provider that validates tool calls server-side (Groq's
    // tool_use_failed) never refuses a call that passes stray arguments; runTool ignores them.
    for (const name of ["get_mandate", "simulate_action", "recent_permission_events"]) {
      expect(byName.get(name)?.function.parameters, name).toEqual({ type: "object", properties: {} });
    }
    for (const name of ["counterparty_onchain", "erc8004_reputation", "nansen_counterparty_profile", "nansen_flows"]) {
      expect(paramsOf(name)?.additionalProperties, name).toBe(false);
    }
    expect(paramsOf("counterparty_onchain")?.required).toEqual(["address"]);
    expect(paramsOf("erc8004_reputation")?.required).toEqual(["agentId"]);
    expect(paramsOf("nansen_counterparty_profile")?.required).toEqual(["address"]);
    expect(paramsOf("nansen_flows")?.required).toEqual(["address"]);
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

  it("an unknown tool name gives UNKNOWN_TOOL, onchain: true (fix round 1, finding 6 — only the two Nansen tools are ever onchain: false), never throws", async () => {
    const ctx = makeCtx(makeReader());
    const result = await runTool("made_up_tool", "{}", ctx);
    expect(result.output).toEqual({ error: "UNKNOWN_TOOL" });
    expect(result.onchain).toBe(true);
  });

  it("canonicalJson(parsed) throwing (a non-safe-integer number, e.g. a float or a 78-digit integer) falls back to the raw string as `arguments` (fix round 1, finding 4)", async () => {
    const ctx = makeCtx(makeReader());
    const rawFloat = JSON.stringify({ agentId: 1.5 });
    const floatResult = await runTool("erc8004_reputation", rawFloat, ctx);
    expect(floatResult.output).toEqual({ error: "INVALID_ARGUMENTS" });
    expect(floatResult.arguments).toBe(rawFloat);

    const rawHuge = `{"agentId": ${"9".repeat(78)}}`;
    const hugeResult = await runTool("erc8004_reputation", rawHuge, ctx);
    expect(hugeResult.output).toEqual({ error: "INVALID_ARGUMENTS" });
    expect(hugeResult.arguments).toBe(rawHuge);

    // a normal, canonical-JSON-safe argument is still recorded as parsed JSON, not the raw string
    const rawGood = JSON.stringify({ address: TARGET });
    const goodResult = await runTool("counterparty_onchain", rawGood, ctx);
    expect(goodResult.arguments).toEqual({ address: TARGET });
  });

  it("a __proto__ key at any depth falls back to the raw string as `arguments`, and INVALID_ARGUMENTS without a read (fix round 1 for Task 11)", async () => {
    // JSON.parse keeps "__proto__" as an own key and canonicalJson writes it, but zod's records drop it
    // silently, so a parsed record with one could never rebuild the same evidence bytes.
    const reader = makeReader();
    const ctx = makeCtx(reader);
    for (const raw of [`{"address":"${TARGET}","__proto__":{"x":1}}`, `{"address":"${TARGET}","extra":[{"__proto__":null}]}`, '{"__proto__":{}}']) {
      const result = await runTool("counterparty_onchain", raw, ctx);
      expect(result.arguments, raw).toBe(raw);
      expect(result.output, raw).toEqual({ error: "INVALID_ARGUMENTS" });
    }
    expect(reader.code).not.toHaveBeenCalled();
    // A no-argument tool ignores its arguments, so it runs; the record still keeps the raw string.
    const noArgs = await runTool("get_mandate", '{"__proto__":{}}', ctx);
    expect(noArgs.arguments).toBe('{"__proto__":{}}');
    expect(noArgs.output).toEqual((await runTool("get_mandate", "{}", ctx)).output);
  });

  it("a no-argument tool accepts any JSON object and ignores its contents (Task 13 ruling: Groq's recorded tool_use_failed passed the action as arguments)", async () => {
    const reader = makeReader({ mandate: vi.fn(async () => null) });
    const recorded = JSON.stringify({ agentId: "1984", block: "67959992", chainId: 10_143, target: TARGET, value: "1000000000000000", data: "0x2b66d72e" });
    for (const name of ["get_mandate", "simulate_action", "recent_permission_events"]) {
      const ctx = makeCtx(reader);
      const empty = await runTool(name, "{}", ctx);
      expect(empty.output, name).not.toEqual({ error: "INVALID_ARGUMENTS" });
      for (const raw of [recorded, '{"x":{"y":[1,2]}}', '{"x":1.5}']) {
        const result = await runTool(name, raw, makeCtx(reader));
        expect(result.output, `${name} ${raw}`).toEqual(empty.output);
        expect(result.onchain).toBe(true);
      }
      // Recorded as parsed JSON when canonical-JSON-safe, else as the raw string (as for every tool).
      expect((await runTool(name, recorded, makeCtx(reader))).arguments).toEqual(JSON.parse(recorded));
      expect((await runTool(name, '{"x":1.5}', makeCtx(reader))).arguments).toBe('{"x":1.5}');
    }
  });

  it("a no-argument tool still gives INVALID_ARGUMENTS, with no read, for input that isn't a JSON object", async () => {
    for (const name of ["get_mandate", "simulate_action", "recent_permission_events"]) {
      const reader = makeReader();
      for (const raw of ["", "not json", "[]", "null", "1", '"{}"', "true", "{"]) {
        const result = await runTool(name, raw, makeCtx(reader));
        expect(result.output, `${name} ${JSON.stringify(raw)}`).toEqual({ error: "INVALID_ARGUMENTS" });
      }
      expect(reader.mandate).not.toHaveBeenCalled();
      expect(reader.trace).not.toHaveBeenCalled();
      expect(reader.permissionLogs).not.toHaveBeenCalled();
    }
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

describe("runTool: nansen_counterparty_profile and nansen_flows", () => {
  it("both are onchain: false, whether the scope check passes or not", async () => {
    const ctx = makeCtx(makeReader());
    const inScope = await runTool("nansen_counterparty_profile", JSON.stringify({ address: TARGET }), ctx);
    expect(inScope.onchain).toBe(false);
    const outOfScope = await runTool("nansen_flows", JSON.stringify({ address: OUT_OF_SCOPE }), ctx);
    expect(outOfScope.onchain).toBe(false);
  });

  it("an out-of-scope address gives ADDRESS_OUT_OF_SCOPE and never calls the Nansen client", async () => {
    const nansen = makeNansen();
    const ctx = makeCtx(makeReader(), undefined, nansen);
    const profileResult = await runTool("nansen_counterparty_profile", JSON.stringify({ address: OUT_OF_SCOPE }), ctx);
    const flowsResult = await runTool("nansen_flows", JSON.stringify({ address: OUT_OF_SCOPE }), ctx);
    expect(profileResult.output).toEqual({ error: "ADDRESS_OUT_OF_SCOPE" });
    expect(flowsResult.output).toEqual({ error: "ADDRESS_OUT_OF_SCOPE" });
    expect(nansen.profile).not.toHaveBeenCalled();
    expect(nansen.flows).not.toHaveBeenCalled();
  });

  it("nansen_counterparty_profile: an in-scope address calls nansen.profile(address) and returns its output, with no NANSEN_API_KEY today", async () => {
    const nansen = makeNansen();
    const ctx = makeCtx(makeReader(), undefined, nansen);
    const result = await runTool("nansen_counterparty_profile", JSON.stringify({ address: TARGET }), ctx);
    expect(nansen.profile).toHaveBeenCalledWith(TARGET);
    expect(result.output).toEqual({ available: false, reason: "NANSEN_API_KEY is not set" });
    expect(result.untrusted).toEqual([]);
  });

  it("nansen_flows: an in-scope address calls nansen.flows(address, P.timestamp - nansenWindowSeconds, P.timestamp)", async () => {
    const nansen = makeNansen();
    const ctx = makeCtx(makeReader(), undefined, nansen);
    const result = await runTool("nansen_flows", JSON.stringify({ address: TARGET }), ctx);
    expect(nansen.flows).toHaveBeenCalledWith(TARGET, P.timestamp - RISK_V1.nansenWindowSeconds, P.timestamp);
    expect(result.output).toEqual({ available: false, reason: "NANSEN_API_KEY is not set" });
    expect(result.untrusted).toEqual([]);
  });

  it("nansen_counterparty_profile: labels[].label and firstFunder.name are returned in `untrusted`, sourced tool:nansen_counterparty_profile", async () => {
    const other = getAddress("0x1234567890123456789012345678901234567890");
    const nansen = makeNansen({
      profile: vi.fn(async () => ({
        available: true,
        labels: [{ label: "Exchange", category: "CEX", kind: ["Hot Wallet"] }],
        firstFunder: { address: other, name: "Binance", chain: "ethereum", time: "2026-01-01T00:00:00Z" },
      })),
    });
    const ctx = makeCtx(makeReader(), undefined, nansen);
    const result = await runTool("nansen_counterparty_profile", JSON.stringify({ address: TARGET }), ctx);
    expect(result.untrusted).toEqual([
      { source: "tool:nansen_counterparty_profile", text: "Exchange" },
      { source: "tool:nansen_counterparty_profile", text: "Binance" },
    ]);
    // the first-funder address is also folded into scope, like every other tool output
    expect(ctx.scope.has(other.toLowerCase())).toBe(true);
  });

  it("nansen_counterparty_profile: an unavailable result produces no untrusted fields", async () => {
    const nansen = makeNansen({ profile: vi.fn(async () => ({ available: false, reason: "NANSEN_ERROR 429 rate_limit_exceeded" })) });
    const ctx = makeCtx(makeReader(), undefined, nansen);
    const result = await runTool("nansen_counterparty_profile", JSON.stringify({ address: TARGET }), ctx);
    expect(result.untrusted).toEqual([]);
    expect(result.output).toEqual({ available: false, reason: "NANSEN_ERROR 429 rate_limit_exceeded" });
  });

  it("nansen_flows: every counterparty label is returned in `untrusted`, sourced tool:nansen_flows", async () => {
    const other = getAddress("0x1234567890123456789012345678901234567890");
    const nansen = makeNansen({
      flows: vi.fn(async () => ({
        available: true,
        counterparties: [
          { address: other, labels: ["Exchange", "Hot Wallet"], interactionCount: 3, totalVolumeUsd: "100.5", volumeInUsd: "50", volumeOutUsd: "50.5" },
        ],
      })),
    });
    const ctx = makeCtx(makeReader(), undefined, nansen);
    const result = await runTool("nansen_flows", JSON.stringify({ address: TARGET }), ctx);
    expect(result.untrusted).toEqual([
      { source: "tool:nansen_flows", text: "Exchange" },
      { source: "tool:nansen_flows", text: "Hot Wallet" },
    ]);
    expect(ctx.scope.has(other.toLowerCase())).toBe(true);
  });

  it("a large Nansen response is still capped at RISK_V1.toolOutputMaxBytes by the generic capOutput pass", async () => {
    const counterparties = Array.from({ length: RISK_V1.nansenMaxCounterparties }, (_, i) => ({
      address: getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`),
      labels: ["Exchange", "Hot Wallet", "Market Maker"],
      interactionCount: i,
      totalVolumeUsd: "123456.789",
      volumeInUsd: "60000",
      volumeOutUsd: "63456.789",
    }));
    const nansen = makeNansen({ flows: vi.fn(async () => ({ available: true, counterparties })) });
    const ctx = makeCtx(makeReader(), undefined, nansen);
    const result = await runTool("nansen_flows", JSON.stringify({ address: TARGET }), ctx);
    expect(new TextEncoder().encode(canonicalJson(result.output)).length).toBeLessThanOrEqual(RISK_V1.toolOutputMaxBytes);
  });

  it("fix round 1, finding 1: a malformed address Nansen returns is null in output, never added to scope, and never surfaces in untrusted", async () => {
    const nansen = makeNansen({
      profile: vi.fn(async () => ({
        available: true,
        labels: [],
        firstFunder: { address: null, name: "Binance", chain: "ethereum", time: "1" },
      })),
      flows: vi.fn(async () => ({
        available: true,
        counterparties: [{ address: null, labels: ["Exchange"], interactionCount: 1, totalVolumeUsd: null, volumeInUsd: null, volumeOutUsd: null }],
      })),
    });
    const ctx = makeCtx(makeReader(), undefined, nansen);
    const scopeBefore = new Set(ctx.scope);

    const profileResult = await runTool("nansen_counterparty_profile", JSON.stringify({ address: TARGET }), ctx);
    const flowsResult = await runTool("nansen_flows", JSON.stringify({ address: TARGET }), ctx);

    expect((profileResult.output as { firstFunder: { address: unknown } }).firstFunder.address).toBeNull();
    expect((flowsResult.output as { counterparties: { address: unknown }[] }).counterparties[0]?.address).toBeNull();
    // only the legitimate label/name strings are screened — the (null) address never was one
    expect(profileResult.untrusted).toEqual([{ source: "tool:nansen_counterparty_profile", text: "Binance" }]);
    expect(flowsResult.untrusted).toEqual([{ source: "tool:nansen_flows", text: "Exchange" }]);
    expect(ctx.scope).toEqual(scopeBefore);
  });

  it("INVALID_ARGUMENTS and bad JSON behave the same as counterparty_onchain's, and never call the Nansen client", async () => {
    const nansen = makeNansen();
    const ctx = makeCtx(makeReader(), undefined, nansen);
    const badJson = await runTool("nansen_flows", "not json", ctx);
    expect(badJson.output).toEqual({ error: "INVALID_ARGUMENTS" });
    const wrongShape = await runTool("nansen_counterparty_profile", JSON.stringify({ addr: TARGET }), ctx);
    expect(wrongShape.output).toEqual({ error: "INVALID_ARGUMENTS" });
    expect(nansen.profile).not.toHaveBeenCalled();
    expect(nansen.flows).not.toHaveBeenCalled();
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

describe("runTool: counterparty_onchain, agentsOwned null on revert (fix round 1, finding 5)", () => {
  it("agentsOwned: null (the Identity Registry's balanceOf reverted, e.g. address zero) passes through as null, not a thrown error", async () => {
    const reader = makeReader({ agentsOwned: vi.fn(async () => null) });
    const ctx = makeCtx(reader);
    const result = await runTool("counterparty_onchain", JSON.stringify({ address: TARGET }), ctx);
    const output = result.output as { agentsOwned: unknown };
    expect(output.agentsOwned).toBeNull();
  });

  it("a normal agentsOwned count is still a decimal string", async () => {
    const reader = makeReader({ agentsOwned: vi.fn(async () => 3n) });
    const ctx = makeCtx(reader);
    const result = await runTool("counterparty_onchain", JSON.stringify({ address: TARGET }), ctx);
    const output = result.output as { agentsOwned: unknown };
    expect(output.agentsOwned).toBe("3");
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

  it("cuts the longest array from its end and records a cumulative drop count for that field", () => {
    const value: JsonValue = { events: Array.from({ length: 200 }, (_, i) => ({ block: i.toString(), note: "x".repeat(20) })) };
    const capped = capOutput(value, 1_536) as { events: JsonValue[]; truncated: Record<string, number> };
    expect(new TextEncoder().encode(canonicalJson(capped)).length).toBeLessThanOrEqual(1_536);
    expect(capped.truncated.events).toBeGreaterThan(0);
    expect(capped.events.length).toBe(200 - (capped.truncated.events ?? 0));
    expect(Object.keys(capped.truncated)).toEqual(["events"]);
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

  it("fix round 1, finding 3(a) / fix round 2, finding 3: a realistic flattenTrace-shaped output (13 calls, 6 flows) caps to pinned exact counts, cutting both fields", () => {
    // A realistic `simulate_action` output shape (the exact field names/types `flattenTrace`
    // produces: `calls[]` of {depth,type,from,to,value,selector,error}, `valueFlows[]` of
    // {from,to,value}), with real 42-char checksummed addresses — not the arbitrary "note"-padded
    // placeholders the original fix-round-1 test used. `address(n)` below gives a distinct, valid
    // checksummed address per index.
    const address = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
    const calls = Array.from({ length: 13 }, (_, i) => ({
      depth: i,
      type: "CALL",
      from: address(i + 1),
      to: address(i + 2),
      value: (i % 2 === 0 ? (i + 1) * 1_000 : 0).toString(),
      selector: null,
      error: null,
    }));
    // `flattenTrace` always sorts `valueFlows` by value descending (fix round 2, finding 1), so a
    // "realistic flattenTrace-shaped output" has them pre-sorted: 6,000 down to 1,000. capOutput must
    // then drop from the *end* — the smallest (1,000) — not the actual largest.
    const valueFlows = Array.from({ length: 6 }, (_, i) => ({
      from: address(i * 2 + 1),
      to: address(i * 2 + 2),
      value: ((6 - i) * 1_000).toString(),
    }));
    const value: JsonValue = {
      ok: true,
      error: null,
      revertReason: null,
      revertReasonTruncated: false,
      calls,
      valueFlows,
      truncatedCalls: 0,
    };

    // Pinned by actually running capOutput on this exact input (measured, not hand-computed) —
    // recomputed after the finding-1 sort change landed. Re-measure and update these four numbers
    // together if `capOutput`'s algorithm or this input ever changes.
    const fullBytes = new TextEncoder().encode(canonicalJson(value)).length;
    expect(fullBytes).toBe(3_055);

    const capped = capOutput(value, 1_536) as {
      calls: JsonValue[];
      valueFlows: Array<{ value: string }>;
      truncated: Record<string, number>;
    };
    const cappedBytes = new TextEncoder().encode(canonicalJson(capped)).length;

    expect(cappedBytes).toBe(1_434);
    expect(cappedBytes).toBeLessThanOrEqual(1_536);
    expect(capped.calls).toHaveLength(4);
    expect(capped.valueFlows).toHaveLength(5);
    expect(capped.truncated).toEqual({ calls: 9, valueFlows: 1 });
    // both fields were actually cut (the regression this guards against: finding 3's reviewer
    // measurement showed the *other* field's drop silently going unreported)
    expect(capped.truncated.calls).toBeGreaterThan(0);
    expect(capped.truncated.valueFlows).toBeGreaterThan(0);
    // and the one flow capOutput dropped is the smallest (1,000) — the sort fix (finding 1) means
    // cutting from the end of `valueFlows` always removes the least important entry
    expect(capped.valueFlows.map((f) => f.value)).toEqual(["6000", "5000", "4000", "3000", "2000"]);
  });

  it("fix round 1, finding 3(b): when every array is exhausted, the longest string is cut from its end so the cap still holds", () => {
    const value: JsonValue = { revertReason: "x".repeat(20_000), ok: false };
    const capped = capOutput(value, 1_536) as { revertReason: string; truncated: Record<string, number> };
    expect(new TextEncoder().encode(canonicalJson(capped)).length).toBeLessThanOrEqual(1_536);
    expect(capped.revertReason.length).toBeLessThan(20_000);
    expect(capped.truncated.revertReason).toBe(20_000 - capped.revertReason.length);
  });

  it("fix round 2, finding 2: a string cut landing inside a surrogate pair drops the trailing lone high surrogate", () => {
    // `fullBytes - 1`: exactly 1 byte over budget, so the *first* cut removes exactly 1 UTF-16 unit —
    // the emoji's low surrogate, landing the cut right inside the pair, which is precisely where the
    // bug lived. (capOutput then keeps cutting a little further to pay for the `truncated` marker's
    // own bytes, same as any other string cut — that convergence isn't this test's concern.)
    const prefix = "a".repeat(500);
    const value: JsonValue = { note: `${prefix}\u{1F600}` };
    const fullBytes = new TextEncoder().encode(canonicalJson(value)).length;
    const capped = capOutput(value, fullBytes - 1) as { note: string; truncated: Record<string, number> };

    expect(new TextEncoder().encode(canonicalJson(capped)).length).toBeLessThanOrEqual(fullBytes - 1);
    expect(/[\uD800-\uDFFF]/.test(capped.note)).toBe(false); // no lone surrogate of either kind remains
    expect(prefix.startsWith(capped.note)).toBe(true); // whatever remains is a clean prefix of the plain-ASCII text
    expect(capped.note.length).toBeLessThan(prefix.length); // the emoji is gone, not left dangling as half a pair
    expect(capped.truncated.note).toBeGreaterThanOrEqual(2); // at least both of the emoji's own surrogate units
    expect(() => JSON.stringify(capped)).not.toThrow();
  });

  it("property-style: capOutput's result is always <= maxBytes, for a range of shapes", () => {
    // A small deterministic PRNG (no new dependency) standing in for a property-testing library:
    // same seed every run, so this is still a fully deterministic test.
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const randomShape = (): JsonValue => {
      const arrays = 1 + Math.floor(rand() * 3);
      const shape: Record<string, JsonValue> = { ok: rand() > 0.5 };
      for (let i = 0; i < arrays; i++) {
        const length = Math.floor(rand() * 400);
        shape[`field${i}`] = Array.from({ length }, () => ({
          note: "n".repeat(Math.floor(rand() * 100)),
          n: Math.floor(rand() * 1_000_000),
        }));
      }
      shape.bigString = "s".repeat(Math.floor(rand() * 30_000));
      return shape;
    };

    for (let trial = 0; trial < 25; trial++) {
      const shape = randomShape();
      const capped = capOutput(shape, 1_536);
      expect(new TextEncoder().encode(canonicalJson(capped)).length).toBeLessThanOrEqual(1_536);
    }
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

  it("simulate_action with a 20,000-char revert reason still fits (fix round 1, finding 3): flattenTrace's own 256-char cap plus capOutput's string-cutting fallback both apply", async () => {
    const output = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
      errorName: "Error",
      args: ["x".repeat(20_000)],
    });
    const reader = makeReader({ trace: vi.fn(async () => okTrace(fakeFrame({ error: "execution reverted", output }))) });
    const ctx = makeCtx(reader);
    const result = await runTool("simulate_action", "{}", ctx);
    expect(new TextEncoder().encode(canonicalJson(result.output)).length).toBeLessThanOrEqual(1_536);
    expect((result.output as { revertReasonTruncated: boolean }).revertReasonTruncated).toBe(true);
  });

  it("fix round 2, finding 1: 6 one-wei dust flows placed before the real 0.001 MON forward — the forward survives capping and sorts first", async () => {
    // A trace shaped exactly like the risky-but-mandated demo scenario this fix protects: a long
    // chain (18 zero-value filler frames, so `calls` gets truncated by flattenTrace's own
    // maxTraceCalls=16 well before the interesting part) with 6 one-wei "dust" transfers, then the
    // real 0.001 MON forward last. Without the finding-1 sort, capOutput — which always cuts from the
    // *end* of an array — would have popped the forward (last in call order) off `valueFlows` before
    // ever touching the worthless dust at the front.
    const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
    let node: CallFrame = { type: "CALL", from: addr(24), to: addr(25), value: toHex(1_000_000_000_000_000n), input: "0x" };
    for (let i = 23; i >= 18; i--) {
      node = { type: "CALL", from: addr(i), to: addr(i + 1), value: "0x1", input: "0x", calls: [node] }; // 1 wei of dust
    }
    for (let i = 17; i >= 0; i--) {
      node = { type: "CALL", from: addr(i), to: addr(i + 1), value: "0x0", input: "0x", calls: [node] }; // filler
    }
    const reader = makeReader({ trace: vi.fn(async (): Promise<TraceResult> => ({ ok: true, frame: node })) });
    const ctx = makeCtx(reader);
    const result = await runTool("simulate_action", "{}", ctx);
    const bytes = new TextEncoder().encode(canonicalJson(result.output)).length;
    const output = result.output as { calls: unknown[]; valueFlows: Array<{ value: string }>; truncated: Record<string, number> };

    // Pinned by actually running this scenario (measured, not hand-computed): both `calls` and
    // `valueFlows` need cutting to fit, which is exactly what makes this test meaningful — if
    // `valueFlows` were never touched, the forward's survival would prove nothing about the fix.
    expect(bytes).toBe(1_429);
    expect(bytes).toBeLessThanOrEqual(1_536);
    expect(output.calls).toHaveLength(4);
    expect(output.valueFlows).toHaveLength(5);
    expect(output.truncated).toEqual({ calls: 12, valueFlows: 2 });

    // the forward is present, and sorted first (it's the largest value) — the dust transfers that
    // got dropped (2 of the original 6) are the ones a stable descending sort always drops last
    expect(output.valueFlows[0]?.value).toBe("1000000000000000");
    expect(output.valueFlows.slice(1).every((f) => f.value === "1")).toBe(true);
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
