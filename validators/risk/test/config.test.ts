import { DEPLOYMENTS } from "@attest8004/sdk";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { parseRiskServiceConfig } from "../src/config.ts";
import { RISK_V1 } from "../src/params.ts";

const ROOT = "/srv/attest8004";
// Built at run time, so no key-shaped literal sits in the source.
const KEY = `0x${"cd".repeat(32)}`;
const RPC = "https://rpc.example.org/v1/secret-path-token";
const LLM_URL = "https://llm.example.com/openai/v1?token=secret-llm-url";
const LLM_KEY = `gsk_${"Zz9".repeat(12)}`;
const GATE_A = getAddress("0x12fab3e3ca810cc44bd9f537613a230a2be8d614");
const GATE_B = getAddress("0x7a5ec388ccbfd3b255cfa94fc2062c0807f2c4cd");

const base = {
  VALIDATOR_B_PRIVATE_KEY: KEY,
  MONAD_TESTNET_RPC_URL: RPC,
  LLM_BASE_URL: LLM_URL,
  LLM_API_KEY: LLM_KEY,
  LLM_MODEL: "openai/gpt-oss-120b",
};

function errorOf(env: Record<string, string | undefined>): string {
  try {
    parseRiskServiceConfig(env, ROOT);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseRiskServiceConfig to throw");
}

describe("parseRiskServiceConfig", () => {
  it("defaults: the demo vault for agent 1984, the cursor under validators/risk/.state, 20/h, 10M gas/day, 1M gas/response, 30 RPM and 8,000 TPM, no Nansen key", () => {
    expect(parseRiskServiceConfig(base, ROOT)).toEqual({
      privateKey: KEY,
      rpcUrl: RPC,
      rpcHost: "rpc.example.org",
      llmBaseUrl: LLM_URL,
      llmHost: "llm.example.com",
      llmApiKey: LLM_KEY,
      llmModel: "openai/gpt-oss-120b",
      nansenApiKey: undefined,
      gates: [{ gate: DEPLOYMENTS[10143].demoAgentVault, agentId: 1_984n }],
      cursorPath: "/srv/attest8004/validators/risk/.state/cursor.json",
      maxRequestsPerAgentPerHour: 20,
      dailyGasBudget: 10_000_000n,
      maxResponseGas: 1_000_000n,
      rpcRequestsPerSecond: 7,
      llmRequestsPerMinute: 30,
      llmTokensPerMinute: 8_000,
    });
  });

  it("treats blank values as unset", () => {
    const config = parseRiskServiceConfig(
      {
        ...base,
        NANSEN_API_KEY: " ",
        RISK_V1_GATES: "",
        RISK_V1_CURSOR: " ",
        RISK_V1_MAX_REQUESTS_PER_AGENT_PER_HOUR: "",
        RISK_V1_DAILY_GAS_BUDGET: "",
        RISK_V1_MAX_RESPONSE_GAS: "",
        RISK_V1_LLM_REQUESTS_PER_MINUTE: "",
        RISK_V1_LLM_TOKENS_PER_MINUTE: "",
      },
      ROOT,
    );
    expect(config).toMatchObject({
      nansenApiKey: undefined,
      gates: [{ gate: DEPLOYMENTS[10143].demoAgentVault, agentId: 1_984n }],
      cursorPath: "/srv/attest8004/validators/risk/.state/cursor.json",
      maxRequestsPerAgentPerHour: 20,
      llmRequestsPerMinute: 30,
      llmTokensPerMinute: 8_000,
    });
  });

  it("reads every override", () => {
    const config = parseRiskServiceConfig(
      {
        ...base,
        LLM_BASE_URL: "http://localhost:8080/v1/",
        LLM_MODEL: " some/other-model ",
        NANSEN_API_KEY: "nansen-key-value",
        RISK_V1_GATES: ` ${GATE_A.toLowerCase()}:1984 , ${GATE_B} : 0 ,${GATE_A}:1985`,
        RISK_V1_CURSOR: "tmp/risk-cursor.json",
        RISK_V1_MAX_REQUESTS_PER_AGENT_PER_HOUR: "5",
        RISK_V1_DAILY_GAS_BUDGET: "4000000",
        RISK_V1_MAX_RESPONSE_GAS: "800000",
        RISK_V1_LLM_REQUESTS_PER_MINUTE: "10",
        RISK_V1_LLM_TOKENS_PER_MINUTE: "12000",
      },
      ROOT,
    );
    expect(config).toMatchObject({
      llmBaseUrl: "http://localhost:8080/v1/",
      llmHost: "localhost:8080",
      llmModel: "some/other-model",
      nansenApiKey: "nansen-key-value",
      gates: [
        { gate: GATE_A, agentId: 1_984n },
        { gate: GATE_B, agentId: 0n },
        { gate: GATE_A, agentId: 1_985n },
      ],
      cursorPath: "/srv/attest8004/tmp/risk-cursor.json",
      maxRequestsPerAgentPerHour: 5,
      dailyGasBudget: 4_000_000n,
      maxResponseGas: 800_000n,
      llmRequestsPerMinute: 10,
      llmTokensPerMinute: 12_000,
    });
    expect(parseRiskServiceConfig({ ...base, RISK_V1_CURSOR: "/var/lib/risk/cursor.json" }, ROOT).cursorPath).toBe("/var/lib/risk/cursor.json");
  });

  it("every problem at once: names each missing required variable", () => {
    const message = errorOf({});
    for (const name of ["VALIDATOR_B_PRIVATE_KEY", "MONAD_TESTNET_RPC_URL", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]) {
      expect(message).toContain(`${name} is not set`);
    }
    // NANSEN_API_KEY is optional.
    expect(message).not.toContain("NANSEN_API_KEY");
  });

  it("every problem at once: malformed values and bad settings together, one error", () => {
    const message = errorOf({
      ...base,
      VALIDATOR_B_PRIVATE_KEY: "0x1234",
      LLM_BASE_URL: "ftp://llm.example.com",
      RISK_V1_GATES: "0x1234:1984",
      RISK_V1_LLM_TOKENS_PER_MINUTE: "abc",
    });
    expect(message.split("\n  - ")).toHaveLength(5);
    expect(message).toContain("VALIDATOR_B_PRIVATE_KEY must be 0x followed by 64 hex digits");
    expect(message).toContain("LLM_BASE_URL must be an http(s) URL");
    expect(message).toContain('RISK_V1_GATES: "0x1234" is not an address');
    expect(message).toContain('RISK_V1_LLM_TOKENS_PER_MINUTE must be a positive decimal integer, got "abc"');
  });

  it("LLM_API_KEY never appears in errors, nor the private key or either URL", () => {
    const badKey = `0x${"cd".repeat(31)}`;
    const message = errorOf({
      VALIDATOR_B_PRIVATE_KEY: badKey,
      MONAD_TESTNET_RPC_URL: "ftp://secret-path-token",
      LLM_BASE_URL: "not a url secret-llm-url",
      LLM_API_KEY: LLM_KEY,
      RISK_V1_DAILY_GAS_BUDGET: "1",
    });
    expect(message).toContain("VALIDATOR_B_PRIVATE_KEY must be 0x followed by 64 hex digits");
    expect(message).toContain("MONAD_TESTNET_RPC_URL must be an http(s) URL");
    expect(message).toContain("LLM_BASE_URL must be an http(s) URL");
    expect(message).toContain("LLM_MODEL is not set");
    expect(message).not.toContain(LLM_KEY);
    expect(message).not.toContain(badKey);
    expect(message).not.toContain("secret-path-token");
    expect(message).not.toContain("secret-llm-url");
  });

  it("bad RISK_V1_GATES item: not an address, a bad agentId, an empty item, or a gate with no agent", () => {
    expect(errorOf({ ...base, RISK_V1_GATES: `${GATE_A}:1984,0x1234:1985` })).toContain('RISK_V1_GATES: "0x1234" is not an address');
    expect(errorOf({ ...base, RISK_V1_GATES: `${GATE_A}:1984,,${GATE_B}:1985` })).toContain("RISK_V1_GATES has an empty item");
    const badChecksum = GATE_A.replace("D614", "d614");
    expect(badChecksum).not.toBe(GATE_A);
    expect(errorOf({ ...base, RISK_V1_GATES: `${badChecksum}:1984` })).toContain("is not an address");
    for (const agentId of ["abc", "-1", "1e3", "01984", "", "1.5", `${2n ** 256n}`]) {
      expect(errorOf({ ...base, RISK_V1_GATES: `${GATE_A}:${agentId}` })).toContain(
        `RISK_V1_GATES: agentId "${agentId}" for gate ${GATE_A} must be a decimal integer below 2^256`,
      );
    }
    expect(errorOf({ ...base, RISK_V1_GATES: GATE_A })).toContain(
      `RISK_V1_GATES: "${GATE_A}" must be <gate address>:<agentId>, e.g. ${DEPLOYMENTS[10143].demoAgentVault}:1984`,
    );
    expect(errorOf({ ...base, RISK_V1_GATES: `${GATE_A}:1984:1985` })).toContain("must be <gate address>:<agentId>");
  });

  it.each([
    ["RISK_V1_MAX_REQUESTS_PER_AGENT_PER_HOUR", "0"],
    ["RISK_V1_MAX_REQUESTS_PER_AGENT_PER_HOUR", "1e3"],
    ["RISK_V1_DAILY_GAS_BUDGET", "10,000,000"],
    ["RISK_V1_MAX_RESPONSE_GAS", "-1"],
    ["RISK_V1_LLM_REQUESTS_PER_MINUTE", "0"],
    ["RISK_V1_LLM_REQUESTS_PER_MINUTE", "2.5"],
    ["RISK_V1_LLM_TOKENS_PER_MINUTE", "8k"],
  ])("%s=%s is not a positive decimal integer", (name, value) => {
    expect(errorOf({ ...base, [name]: value })).toContain(`${name} must be a positive decimal integer, got "${value}"`);
  });

  it("RISK_V1_MAX_RESPONSE_GAS above budget rejected: the daily budget must fit at least one response", () => {
    expect(errorOf({ ...base, RISK_V1_MAX_RESPONSE_GAS: "2000000", RISK_V1_DAILY_GAS_BUDGET: "1500000" })).toContain(
      "RISK_V1_DAILY_GAS_BUDGET (1500000) must be at least RISK_V1_MAX_RESPONSE_GAS (2000000)",
    );
    expect(errorOf({ ...base, RISK_V1_DAILY_GAS_BUDGET: "999999" })).toContain(
      "RISK_V1_DAILY_GAS_BUDGET (999999) must be at least RISK_V1_MAX_RESPONSE_GAS (1000000)",
    );
  });

  it("RISK_V1_LLM_TOKENS_PER_MINUTE below the largest request risk-v1 sends is rejected (every check would fail its pacing)", () => {
    expect(errorOf({ ...base, RISK_V1_LLM_TOKENS_PER_MINUTE: String(RISK_V1.maxRequestTokens - 1) })).toContain(
      `RISK_V1_LLM_TOKENS_PER_MINUTE (${RISK_V1.maxRequestTokens - 1}) must be at least ${RISK_V1.maxRequestTokens}, the largest request risk-v1 sends`,
    );
    expect(parseRiskServiceConfig({ ...base, RISK_V1_LLM_TOKENS_PER_MINUTE: String(RISK_V1.maxRequestTokens) }, ROOT).llmTokensPerMinute).toBe(
      RISK_V1.maxRequestTokens,
    );
  });

  it("RPC requests per second: default 7, 1–15 accepted, 0/16/\"x\" refused", () => {
    expect(parseRiskServiceConfig(base, ROOT).rpcRequestsPerSecond).toBe(7);
    expect(parseRiskServiceConfig({ ...base, RISK_V1_RPC_REQUESTS_PER_SECOND: "15" }, ROOT).rpcRequestsPerSecond).toBe(15);
    for (const bad of ["0", "16", "x", "7.5"]) {
      expect(errorOf({ ...base, RISK_V1_RPC_REQUESTS_PER_SECOND: bad })).toContain("RISK_V1_RPC_REQUESTS_PER_SECOND must be an integer from 1 to 15");
    }
  });

  it("daily budget below response cap + report cap refused", () => {
    expect(errorOf({ ...base, RISK_V1_DAILY_GAS_BUDGET: "1419999" })).toContain(
      "RISK_V1_DAILY_GAS_BUDGET (1419999) must be at least RISK_V1_MAX_RESPONSE_GAS (1000000) plus the operator report cap (420000)",
    );
    expect(parseRiskServiceConfig({ ...base, RISK_V1_DAILY_GAS_BUDGET: "1420000" }, ROOT).dailyGasBudget).toBe(1_420_000n);
  });
});
