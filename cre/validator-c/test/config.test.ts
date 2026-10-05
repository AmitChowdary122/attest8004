import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { WORKFLOW_NAME, workflowConfigSchema, workflowNameBytes10 } from "../src/config.ts";
import { testConfig } from "./helpers.ts";

describe("workflowNameBytes10: CRE's bytes10 for a workflow name (the first 10 hex chars of sha256, as ASCII)", () => {
  test("matches what the CRE simulator wrote for the P11 spike's workflow", () => {
    expect(workflowNameBytes10("attest-spike")).toBe("0x37616164666334303261");
  });

  test("gives CreValidator's workflowName for this workflow (the second, independent derivation)", () => {
    expect(WORKFLOW_NAME).toBe("attest8004-validator-c");
    expect(workflowNameBytes10(WORKFLOW_NAME)).toBe("0x36386365303833636635");
  });

  test("workflow.yaml names this workflow", () => {
    const yaml = readFileSync(new URL("../workflow.yaml", import.meta.url), "utf8");
    expect(yaml).toContain(`workflow-name: "${WORKFLOW_NAME}"`);
  });
});

describe("workflowConfigSchema", () => {
  test("accepts the committed config.monad-testnet.json", () => {
    const committed = JSON.parse(readFileSync(new URL("../config.monad-testnet.json", import.meta.url), "utf8"));
    expect(workflowConfigSchema.safeParse(committed).success).toBe(true);
  });

  test("refuses an evaluate URL that isn't loopback http or https, and more polls than CRE's 15 HTTP calls allow", () => {
    expect(workflowConfigSchema.safeParse(testConfig({ evaluateUrl: "http://example.com/evaluate" })).success).toBe(false);
    expect(workflowConfigSchema.safeParse(testConfig({ pollAttempts: 16 })).success).toBe(false);
    expect(workflowConfigSchema.safeParse({ ...testConfig(), extra: 1 }).success).toBe(false);
  });
});
