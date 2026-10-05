import { DEPLOYMENTS } from "@attest8004/sdk";
import { describe, expect, it } from "vitest";
import { parseEvaluateConfig } from "../src/evaluate-config.ts";

const RPC = "https://testnet-rpc.monad.xyz";

describe("parseEvaluateConfig: the /evaluate service's settings, with no keys", () => {
  it("config_readsNoKeys: it never reads a *_PRIVATE_KEY, even when one is set", () => {
    const read: string[] = [];
    const env = new Proxy({ MONAD_TESTNET_RPC_URL: RPC, VALIDATOR_A_PRIVATE_KEY: `0x${"11".repeat(32)}` } as Record<string, string | undefined>, {
      get(target, name: string) {
        read.push(name);
        return target[name];
      },
    });
    parseEvaluateConfig(env);
    expect(read.length).toBeGreaterThan(0);
    expect(read.filter((name) => /PRIVATE_KEY/.test(name))).toEqual([]);
  });

  it("config_defaults: port 8787, 7 requests a second, validator A's default gate", () => {
    const config = parseEvaluateConfig({ MONAD_TESTNET_RPC_URL: RPC });
    expect(config).toEqual({
      rpcUrl: RPC,
      rpcHost: "testnet-rpc.monad.xyz",
      port: 8787,
      rpcRequestsPerSecond: 7,
      gates: [{ gate: DEPLOYMENTS[10143].demoAgentVault, agentId: 1984n }],
    });
  });

  it("reads MANDATE_V1_GATES, CRE_EVALUATE_PORT and CRE_EVALUATE_RPC_REQUESTS_PER_SECOND", () => {
    const vault = DEPLOYMENTS[10143].demoAgentVault;
    const config = parseEvaluateConfig({
      MONAD_TESTNET_RPC_URL: RPC,
      MANDATE_V1_GATES: `${vault}:1984,${vault}:1985`,
      CRE_EVALUATE_PORT: "9001",
      CRE_EVALUATE_RPC_REQUESTS_PER_SECOND: "3",
    });
    expect(config.port).toBe(9001);
    expect(config.rpcRequestsPerSecond).toBe(3);
    expect(config.gates).toEqual([
      { gate: vault, agentId: 1984n },
      { gate: vault, agentId: 1985n },
    ]);
  });

  it("config_rejectsBadPort and a missing RPC URL, reporting every problem at once", () => {
    for (const port of ["0", "65536", "abc", "80.5"]) {
      expect(() => parseEvaluateConfig({ MONAD_TESTNET_RPC_URL: RPC, CRE_EVALUATE_PORT: port })).toThrow(
        `CRE_EVALUATE_PORT must be a port number from 1 to 65535, got "${port}"`,
      );
    }
    expect(() => parseEvaluateConfig({ MANDATE_V1_GATES: "0x1234:1" })).toThrow(/MONAD_TESTNET_RPC_URL is not set[\s\S]*"0x1234" is not an address/);
  });

  it("never echoes the RPC URL in an error", () => {
    const secret = "https://rpc.example/key-abc123";
    expect(() => parseEvaluateConfig({ MONAD_TESTNET_RPC_URL: secret, CRE_EVALUATE_PORT: "x" })).toThrow(/^(?![\s\S]*key-abc123)/);
  });
});
