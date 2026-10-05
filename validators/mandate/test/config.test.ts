import { DEPLOYMENTS } from "@attest8004/sdk";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/config.ts";

const ROOT = "/srv/attest8004";
// Built at run time, so no key-shaped literal sits in the source.
const KEY = `0x${"ab".repeat(32)}`;
const RPC = "https://rpc.example.org/v1/secret-path-token";
const GATE_A = getAddress("0x23bfbd12545ccd1501dda1b65a54518fd6212a96");
const GATE_B = getAddress("0x7a5ec388ccbfd3b255cfa94fc2062c0807f2c4cd");

const base = { VALIDATOR_A_PRIVATE_KEY: KEY, MONAD_TESTNET_RPC_URL: RPC };

function errorOf(env: Record<string, string | undefined>): string {
  try {
    parseServiceConfig(env, ROOT);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseServiceConfig to throw");
}

describe("parseServiceConfig", () => {
  it("applies the defaults: the demo vault for agent 1984, the cursor under validators/mandate/.state, 20/h, 10M gas/day, 400k gas/response", () => {
    expect(parseServiceConfig(base, ROOT)).toEqual({
      privateKey: KEY,
      rpcUrl: RPC,
      rpcHost: "rpc.example.org",
      gates: [{ gate: DEPLOYMENTS[10143].demoAgentVault, agentId: 1_984n }],
      cursorPath: "/srv/attest8004/validators/mandate/.state/cursor.json",
      maxRequestsPerAgentPerHour: 20,
      dailyGasBudget: 10_000_000n,
      maxResponseGas: 400_000n,
      rpcRequestsPerSecond: 7,
    });
  });

  it("treats blank values as unset", () => {
    const config = parseServiceConfig(
      {
        ...base,
        MANDATE_V1_GATES: "",
        MANDATE_V1_CURSOR: " ",
        MANDATE_V1_MAX_REQUESTS_PER_AGENT_PER_HOUR: "",
        MANDATE_V1_DAILY_GAS_BUDGET: "",
        MANDATE_V1_MAX_RESPONSE_GAS: "",
      },
      ROOT,
    );
    expect(config.gates).toEqual([{ gate: DEPLOYMENTS[10143].demoAgentVault, agentId: DEPLOYMENTS[10143].demoAgents[0] }]);
    expect(config.maxRequestsPerAgentPerHour).toBe(20);
  });

  it("reads every override", () => {
    const config = parseServiceConfig(
      {
        ...base,
        MANDATE_V1_GATES: ` ${GATE_A.toLowerCase()}:1984 , ${GATE_B} : 0 ,${GATE_A}:1985`,
        MANDATE_V1_CURSOR: "tmp/cursor.json",
        MANDATE_V1_MAX_REQUESTS_PER_AGENT_PER_HOUR: "5",
        MANDATE_V1_DAILY_GAS_BUDGET: "2000000",
        MANDATE_V1_MAX_RESPONSE_GAS: "300000",
      },
      ROOT,
    );
    expect(config).toMatchObject({
      gates: [
        { gate: GATE_A, agentId: 1_984n },
        { gate: GATE_B, agentId: 0n },
        { gate: GATE_A, agentId: 1_985n },
      ],
      cursorPath: "/srv/attest8004/tmp/cursor.json",
      maxRequestsPerAgentPerHour: 5,
      dailyGasBudget: 2_000_000n,
      maxResponseGas: 300_000n,
    });
    expect(parseServiceConfig({ ...base, MANDATE_V1_CURSOR: "/var/lib/mandate/cursor.json" }, ROOT).cursorPath).toBe(
      "/var/lib/mandate/cursor.json",
    );
  });

  it("names every missing variable at once", () => {
    const message = errorOf({});
    expect(message).toContain("VALIDATOR_A_PRIVATE_KEY is not set");
    expect(message).toContain("MONAD_TESTNET_RPC_URL is not set");
  });

  it("rejects a malformed key or RPC URL without echoing either", () => {
    const badKey = `0x${"ab".repeat(31)}`;
    const message = errorOf({ VALIDATOR_A_PRIVATE_KEY: badKey, MONAD_TESTNET_RPC_URL: "ftp://secret-path-token" });
    expect(message).toContain("VALIDATOR_A_PRIVATE_KEY must be 0x followed by 64 hex digits");
    expect(message).toContain("MONAD_TESTNET_RPC_URL must be an http(s) URL");
    expect(message).not.toContain(badKey);
    expect(message).not.toContain("secret-path-token");
  });

  it.each([
    ["MANDATE_V1_MAX_REQUESTS_PER_AGENT_PER_HOUR", "0"],
    ["MANDATE_V1_MAX_REQUESTS_PER_AGENT_PER_HOUR", "1e3"],
    ["MANDATE_V1_MAX_REQUESTS_PER_AGENT_PER_HOUR", "-5"],
    ["MANDATE_V1_DAILY_GAS_BUDGET", "10,000,000"],
    ["MANDATE_V1_DAILY_GAS_BUDGET", "12.5"],
    ["MANDATE_V1_MAX_RESPONSE_GAS", "abc"],
    ["MANDATE_V1_MAX_RESPONSE_GAS", "0"],
  ])("%s=%s is not a positive decimal integer", (name, value) => {
    expect(errorOf({ ...base, [name]: value })).toContain(`${name} must be a positive decimal integer, got "${value}"`);
  });

  it("needs the daily budget to fit at least one response", () => {
    expect(errorOf({ ...base, MANDATE_V1_DAILY_GAS_BUDGET: "300000" })).toContain(
      "MANDATE_V1_DAILY_GAS_BUDGET (300000) must be at least MANDATE_V1_MAX_RESPONSE_GAS (400000)",
    );
  });

  it("rejects a gate that isn't an address, an agentId that isn't a decimal integer, or an empty item", () => {
    expect(errorOf({ ...base, MANDATE_V1_GATES: `${GATE_A}:1984,0x1234:1985` })).toContain('MANDATE_V1_GATES: "0x1234" is not an address');
    expect(errorOf({ ...base, MANDATE_V1_GATES: `${GATE_A}:1984,,${GATE_B}:1985` })).toContain("MANDATE_V1_GATES has an empty item");
    const badChecksum = GATE_A.replace("B", "b");
    expect(errorOf({ ...base, MANDATE_V1_GATES: `${badChecksum}:1984` })).toContain("is not an address");
    for (const agentId of ["abc", "-1", "1e3", "01984", "", "1.5", `${2n ** 256n}`]) {
      expect(errorOf({ ...base, MANDATE_V1_GATES: `${GATE_A}:${agentId}` })).toContain(
        `MANDATE_V1_GATES: agentId "${agentId}" for gate ${GATE_A} must be a decimal integer below 2^256`,
      );
    }
  });

  it("needs each gate paired with the one agent it serves, so a gate alone (any agent) is refused", () => {
    expect(errorOf({ ...base, MANDATE_V1_GATES: GATE_A })).toContain(
      `MANDATE_V1_GATES: "${GATE_A}" must be <gate address>:<agentId>, e.g. ${DEPLOYMENTS[10143].demoAgentVault}:1984`,
    );
    expect(errorOf({ ...base, MANDATE_V1_GATES: `${GATE_A}:1984:1985` })).toContain("must be <gate address>:<agentId>");
  });

  it("RPC requests per second: default 7, 1–15 accepted, 0/16/\"x\" refused", () => {
    expect(parseServiceConfig(base, ROOT).rpcRequestsPerSecond).toBe(7);
    expect(parseServiceConfig({ ...base, MANDATE_V1_RPC_REQUESTS_PER_SECOND: "1" }, ROOT).rpcRequestsPerSecond).toBe(1);
    expect(parseServiceConfig({ ...base, MANDATE_V1_RPC_REQUESTS_PER_SECOND: "15" }, ROOT).rpcRequestsPerSecond).toBe(15);
    for (const bad of ["0", "16", "x", "7.5"]) {
      expect(errorOf({ ...base, MANDATE_V1_RPC_REQUESTS_PER_SECOND: bad })).toContain("MANDATE_V1_RPC_REQUESTS_PER_SECOND must be an integer from 1 to 15");
    }
  });

  it("daily budget below response cap + report cap refused", () => {
    expect(errorOf({ ...base, MANDATE_V1_DAILY_GAS_BUDGET: "829999" })).toContain(
      "MANDATE_V1_DAILY_GAS_BUDGET (829999) must be at least MANDATE_V1_MAX_RESPONSE_GAS (400000) plus the operator report cap (430000)",
    );
    expect(parseServiceConfig({ ...base, MANDATE_V1_DAILY_GAS_BUDGET: "830000" }, ROOT).dailyGasBudget).toBe(830_000n);
  });
});
