import { DEPLOYMENTS } from "@attest8004/sdk";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { parseGateList, servedGateDecline, servedGateMap } from "../src/gates.ts";

// gates.ts holds mandate-v1's (gate, agent) allowlist code, moved out of config.ts and validator.ts unchanged so the
// /evaluate service (P11) answers for exactly the gates validator A does, with the same texts.
const GATE_A = getAddress("0x12fab3e3ca810cc44bd9f537613a230a2be8d614");
const GATE_B = getAddress("0x23bfbd12545ccd1501dda1b65a54518fd6212a96");

describe("parseGateList", () => {
  it("defaults to the demo vault for agent 1984 when unset", () => {
    const problems: string[] = [];
    expect(parseGateList(undefined, problems)).toEqual([{ gate: DEPLOYMENTS[10143].demoAgentVault, agentId: 1984n }]);
    expect(problems).toEqual([]);
  });

  it("parses <gate>:<agentId> items, trimming spaces and checksumming", () => {
    const problems: string[] = [];
    expect(parseGateList(` ${GATE_A.toLowerCase()}:1984 , ${GATE_B} : 0 ,${GATE_A}:1985`, problems)).toEqual([
      { gate: GATE_A, agentId: 1984n },
      { gate: GATE_B, agentId: 0n },
      { gate: GATE_A, agentId: 1985n },
    ]);
    expect(problems).toEqual([]);
  });

  it("reports each bad item with mandate-v1's texts", () => {
    const problems: string[] = [];
    parseGateList(`${GATE_A}:1984,,0x1234:1985,${GATE_A},${GATE_A}:-1`, problems);
    expect(problems).toEqual([
      "MANDATE_V1_GATES has an empty item",
      'MANDATE_V1_GATES: "0x1234" is not an address',
      `MANDATE_V1_GATES: "${GATE_A}" must be <gate address>:<agentId>, e.g. ${DEPLOYMENTS[10143].demoAgentVault}:1984`,
      `MANDATE_V1_GATES: agentId "-1" for gate ${GATE_A} must be a decimal integer below 2^256`,
    ]);
  });
});

describe("servedGateDecline", () => {
  const served = servedGateMap([
    { gate: GATE_A, agentId: 1984n },
    { gate: GATE_A, agentId: 1985n },
    { gate: GATE_B, agentId: 7n },
  ]);

  it("accepts a served (gate, agent), whatever the gate's letter case", () => {
    expect(servedGateDecline(served, GATE_A.toLowerCase() as typeof GATE_A, 1985n)).toBeNull();
  });

  it("declines a gate it doesn't serve, naming the agent", () => {
    const other = getAddress("0x00000000000000000000000000000000000000b1");
    expect(servedGateDecline(served, other, 1984n)).toBe(
      `GATE_NOT_SERVED: agent 1984 requested through gate ${other}, which this validator doesn't serve`,
    );
  });

  it("declines a served gate named for another agent, listing the served agents in order", () => {
    expect(servedGateDecline(served, GATE_A, 1982n)).toBe(`GATE_NOT_FOR_AGENT: gate ${GATE_A} serves agents 1984, 1985, not 1982`);
    expect(servedGateDecline(served, GATE_B, 1984n)).toBe(`GATE_NOT_FOR_AGENT: gate ${GATE_B} serves agent 7, not 1984`);
  });
});
