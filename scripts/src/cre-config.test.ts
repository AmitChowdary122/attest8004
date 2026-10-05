import { DEPLOYMENTS, EVIDENCE_SCHEMA_V1 } from "@attest8004/sdk";
import { CRE_MAX_EVIDENCE_BYTES, EVALUATE_DEFAULTS, MANDATE_V1, parseGateList, PIN_LAG_BLOCKS } from "@attest8004/validator-mandate";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EVIDENCE_SCHEMA_V1 as MIRRORED_SCHEMA } from "../../cre/validator-c/src/mirrored.ts";

// Validator C's workflow (cre/validator-c, a Bun project outside the pnpm workspace) can't import everything it agrees
// with: this pins its committed config and mirrored constants to the repo's own values (P11).
const config = JSON.parse(readFileSync(new URL("../../cre/validator-c/config.monad-testnet.json", import.meta.url), "utf8"));
const workflowYaml = readFileSync(new URL("../../cre/validator-c/workflow.yaml", import.meta.url), "utf8");
const testnet = DEPLOYMENTS[10143];

describe("cre/validator-c/config.monad-testnet.json agrees with the repo", () => {
  it("names CreValidator, its forwarder and the ValidationRegistry as recorded in DEPLOYMENTS", () => {
    expect(config.creValidator).toBe(testnet.validators.creMandateV1);
    expect(config.forwarder).toBe(testnet.creForwarder);
    expect(config.validationRegistry).toBe(testnet.validationRegistry);
    expect(config.chainId).toBe(10143);
  });

  it("serves validator A's default (gate, agent) pairs, as the /evaluate service does", () => {
    const defaults = parseGateList(undefined, []);
    expect(config.gates).toEqual(defaults.map((g) => ({ gate: g.gate, agentId: g.agentId.toString() })));
  });

  it("uses mandate-v1's pin lag, the /evaluate evidence cap and the /evaluate default port", () => {
    expect(BigInt(config.pinLagBlocks)).toBe(PIN_LAG_BLOCKS);
    expect(config.maxEvidenceBytes).toBe(CRE_MAX_EVIDENCE_BYTES);
    expect(config.evaluateUrl).toBe(`http://127.0.0.1:${EVALUATE_DEFAULTS.port}/evaluate`);
  });

  it("the workflow's mirrored constants and workflow.yaml match their sources", () => {
    expect(MIRRORED_SCHEMA).toBe(EVIDENCE_SCHEMA_V1);
    expect(MANDATE_V1.tag).toBe("mandate-v1");
    expect(workflowYaml).toContain('workflow-name: "attest8004-validator-c"');
  });
});
