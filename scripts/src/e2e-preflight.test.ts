import { OPERATOR_REPORT_GAS_CAP } from "@attest8004/sdk";
import { getAddress, parseEther, parseGwei, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  checkModelsEndpoint,
  deployerNeed,
  deployerShortfall,
  executeTimeLeft,
  permissionWindowWait,
  reportsExpected,
  restartBudget,
  validatorNeed,
} from "./e2e-preflight.ts";

const FEE = parseGwei("100");
const BUDGET = {
  fundBelow: parseEther("0.005"),
  fundTarget: parseEther("0.01"),
  fundGas: 26_000n,
  executeGas: 121_000n,
  maxFeePerGas: FEE,
  marginPercent: 50,
};

describe("deployerNeed", () => {
  it("with the vault already funded: execute(S)'s gas at the max fee, plus the margin, and no top-up", () => {
    const need = deployerNeed({ ...BUDGET, vaultBalance: parseEther("0.005") });
    expect(need.topUp).toBe(0n);
    expect(need.gasWithMargin).toBe((121_000n * FEE * 150n) / 100n);
    expect(need.total).toBe(need.gasWithMargin);
  });

  it("with the vault below 0.005 MON: the top-up to 0.01 MON, plus the fund's and execute's gas with the margin", () => {
    const need = deployerNeed({ ...BUDGET, vaultBalance: parseEther("0.004") });
    expect(need.topUp).toBe(parseEther("0.006"));
    expect(need.gasWithMargin).toBe(((26_000n + 121_000n) * FEE * 150n) / 100n);
    expect(need.total).toBe(parseEther("0.006") + need.gasWithMargin);
  });

  it("rounds the margin up, never down", () => {
    const need = deployerNeed({ ...BUDGET, vaultBalance: parseEther("1"), executeGas: 1n, maxFeePerGas: 1n });
    expect(need.gasWithMargin).toBe(2n); // 1.5 wei rounds up
  });
});

describe("deployerShortfall", () => {
  const needFromEmpty = () => deployerNeed({ ...BUDGET, vaultBalance: 0n });

  it("is null when the deployer holds at least what the run needs", () => {
    const need = needFromEmpty();
    expect(deployerShortfall({ held: need.total, need, marginPercent: 50 })).toBeNull();
    expect(deployerShortfall({ held: need.total + 1n, need, marginPercent: 50 })).toBeNull();
  });

  it("says what is needed and what is held, and what the need is made of", () => {
    const need = needFromEmpty();
    const message = deployerShortfall({ held: need.total - 1n, need, marginPercent: 50 });
    expect(message).toBe(
      // 147,000 gas at 100 gwei is 0.0147 MON; with the 50% margin, 0.02205 MON.
      `the deployer holds 0.032049999999999999 MON but needs at least 0.03205 MON: the vault top-up (0.01 MON) plus gas ` +
        "for it and execute(S) at the current max fee, with a 50% margin (0.02205 MON); top the deployer up first",
    );
  });
});

describe("restartBudget", () => {
  const deadline = 1_790_001_800n;

  it("is the full restart wait while S's deadline is far enough away", () => {
    expect(restartBudget({ deadline, now: deadline - 1_500n, executeMarginSeconds: 120n, maxMs: 300_000 })).toEqual({ ok: true, ms: 300_000 });
  });

  it("is capped at S's deadline minus the time execute(S) needs", () => {
    expect(restartBudget({ deadline, now: deadline - 300n, executeMarginSeconds: 120n, maxMs: 300_000 })).toEqual({ ok: true, ms: 180_000 });
  });

  it("refuses when not even the execute margin is left, naming the seconds left", () => {
    expect(restartBudget({ deadline, now: deadline - 120n, executeMarginSeconds: 120n, maxMs: 300_000 })).toEqual({
      ok: false,
      message:
        "only 120 s remain before S's deadline (1790001800), and execute(S) needs 120 s of them: there is no time for the restart check, " +
        "so the run stops without executing S",
    });
  });
});

describe("executeTimeLeft", () => {
  const deadline = 1_790_001_800n;

  it("is null with at least the minimum left", () => {
    expect(executeTimeLeft({ deadline, now: deadline - 60n, minSeconds: 60n })).toBeNull();
  });

  it("refuses with less than the minimum left, or past the deadline", () => {
    expect(executeTimeLeft({ deadline, now: deadline - 59n, minSeconds: 60n })).toBe(
      "only 59 s remain before S's deadline (1790001800), less than the 60 s execute(S) needs: not sending it",
    );
    expect(executeTimeLeft({ deadline, now: deadline + 5n, minSeconds: 60n })).toBe(
      "only 0 s remain before S's deadline (1790001800), less than the 60 s execute(S) needs: not sending it",
    );
  });
});

describe("permissionWindowWait", () => {
  it("is null once the mandate's MandateSet is at least a window old", () => {
    expect(permissionWindowWait({ agentId: 1984n, latestBlock: 68_006_000n, setAtBlock: 68_000_000n, windowBlocks: 6_000n, msPerBlock: 305n })).toBeNull();
  });

  it("says how many blocks and about how many minutes to wait while it is younger", () => {
    expect(permissionWindowWait({ agentId: 1984n, latestBlock: 68_001_000n, setAtBlock: 68_000_000n, windowBlocks: 6_000n, msPerBlock: 305n })).toBe(
      "agent 1984's mandate was set at block 68000000, only 1000 blocks ago: risk-v1's recent_permission_events reads the last 6000 " +
        "blocks at its pin, so it would show that MandateSet. Wait 5000 more blocks (about 26 minutes) before running the e2e",
    );
  });
});

describe("checkModelsEndpoint", () => {
  const BASE = "https://llm.example.test/openai/v1/";
  const KEY = "test-key-not-a-secret";
  const MODELS = ["openai/gpt-oss-120b", "meta-llama/llama-prompt-guard-2-86m"];
  const listing = (ids: string[]) => new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }), { status: 200 });

  it("sends one GET to <base>/models with the Bearer key, and nothing else", async () => {
    const fetchFn = vi.fn(async () => listing(MODELS));
    const result = await checkModelsEndpoint({ baseUrl: BASE, apiKey: KEY, models: MODELS, fetch: fetchFn, timeoutMs: 10_000 });
    expect(result).toEqual({ ok: true, listed: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://llm.example.test/openai/v1/models");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a non-2xx answer, naming the status but never the URL or the key", async () => {
    const result = await checkModelsEndpoint({ baseUrl: BASE, apiKey: KEY, models: MODELS, fetch: async () => new Response("{}", { status: 401 }), timeoutMs: 10_000 });
    expect(result).toEqual({ ok: false, message: "LLM endpoint preflight: GET /models answered HTTP 401" });
  });

  it("refuses a network error or a timeout with fixed text", async () => {
    const result = await checkModelsEndpoint({
      baseUrl: BASE,
      apiKey: KEY,
      models: MODELS,
      fetch: async () => Promise.reject(new TypeError(`fetch failed for ${BASE} with ${KEY}`)),
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ ok: false, message: "LLM endpoint preflight: GET /models failed (network error or timeout)" });
  });

  it("refuses when a well-formed listing lacks a model risk-v1 will request", async () => {
    const result = await checkModelsEndpoint({ baseUrl: BASE, apiKey: KEY, models: MODELS, fetch: async () => listing([MODELS[0] as string]), timeoutMs: 10_000 });
    expect(result).toEqual({ ok: false, message: "LLM endpoint preflight: GET /models doesn't list meta-llama/llama-prompt-guard-2-86m" });
  });

  it("accepts a 2xx answer it can't read as a listing, saying the models weren't checked", async () => {
    const result = await checkModelsEndpoint({ baseUrl: BASE, apiKey: KEY, models: MODELS, fetch: async () => new Response("not json", { status: 200 }), timeoutMs: 10_000 });
    expect(result).toEqual({ ok: true, listed: false });
  });

  it("never puts the URL or the key in any message", async () => {
    for (const fetchFn of [async () => new Response("", { status: 500 }), async () => Promise.reject(new Error(`${BASE} ${KEY}`))]) {
      const result = await checkModelsEndpoint({ baseUrl: BASE, apiKey: KEY, models: MODELS, fetch: fetchFn, timeoutMs: 10_000 });
      expect(JSON.stringify(result)).not.toContain("llm.example.test");
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
  });
});

describe("operator reports (P7)", () => {
  const KEY: Hex = "0x8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";
  const ZERO: Hex = `0x${"00".repeat(32)}`;
  const BOARD = { address: getAddress("0xa7d52b3b08fab0cd0527c6242ca678f9feee6a1c"), fromBlock: 68_300_000n };

  it("reportsExpected: on with a key and a board; off without a key; off without a board", () => {
    expect(reportsExpected({ inboxKey: KEY, findingsBoard: BOARD })).toEqual({
      expected: true,
      line: `operator reports: on (inbox key ${KEY}, FindingsBoard ${BOARD.address})`,
    });
    expect(reportsExpected({ inboxKey: ZERO, findingsBoard: BOARD })).toEqual({
      expected: false,
      line: "operator reports: off (agent 1984 has no inbox key: no report will be posted)",
    });
    expect(reportsExpected({ inboxKey: KEY, findingsBoard: null })).toEqual({
      expected: false,
      line: "operator reports: off (no FindingsBoard recorded for this chain)",
    });
  });

  it("validatorNeed: the floor alone when reports are off; floor + 3 × cap × maxFee when on", () => {
    expect(validatorNeed({ floor: parseEther("0.5"), reports: false, maxFeePerGas: FEE })).toBe(parseEther("0.5"));
    expect(validatorNeed({ floor: parseEther("0.5"), reports: true, maxFeePerGas: FEE })).toBe(parseEther("0.5") + 3n * OPERATOR_REPORT_GAS_CAP * FEE);
  });
});
