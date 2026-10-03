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
  it("applies the defaults: the demo vault, the cursor under validators/mandate/.state, 20/h, 10M gas/day, 400k gas/response", () => {
    expect(parseServiceConfig(base, ROOT)).toEqual({
      privateKey: KEY,
      rpcUrl: RPC,
      rpcHost: "rpc.example.org",
      gates: [DEPLOYMENTS[10143].demoAgentVault],
      cursorPath: "/srv/attest8004/validators/mandate/.state/cursor.json",
      maxRequestsPerAgentPerHour: 20,
      dailyGasBudget: 10_000_000n,
      maxResponseGas: 400_000n,
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
    expect(config.gates).toEqual([DEPLOYMENTS[10143].demoAgentVault]);
    expect(config.maxRequestsPerAgentPerHour).toBe(20);
  });

  it("reads every override", () => {
    const config = parseServiceConfig(
      {
        ...base,
        MANDATE_V1_GATES: ` ${GATE_A.toLowerCase()} , ${GATE_B}`,
        MANDATE_V1_CURSOR: "tmp/cursor.json",
        MANDATE_V1_MAX_REQUESTS_PER_AGENT_PER_HOUR: "5",
        MANDATE_V1_DAILY_GAS_BUDGET: "2000000",
        MANDATE_V1_MAX_RESPONSE_GAS: "300000",
      },
      ROOT,
    );
    expect(config).toMatchObject({
      gates: [GATE_A, GATE_B],
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

  it("rejects a gate that isn't an address, or an empty item", () => {
    expect(errorOf({ ...base, MANDATE_V1_GATES: `${GATE_A},0x1234` })).toContain('MANDATE_V1_GATES: "0x1234" is not an address');
    expect(errorOf({ ...base, MANDATE_V1_GATES: `${GATE_A},,${GATE_B}` })).toContain("MANDATE_V1_GATES has an empty item");
    const badChecksum = GATE_A.replace("B", "b");
    expect(errorOf({ ...base, MANDATE_V1_GATES: badChecksum })).toContain("is not an address");
  });
});
