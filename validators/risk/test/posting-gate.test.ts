// P12 AUD-04 (route A+): validator B declines, posting nothing, when the model's output breaks risk-v1's own rubric
// in a way that would let a fund-forwarding action through: no simulation, forwarding not flagged high, or a rubric-high
// code graded lower. Nothing posted changes, so risk-v1's evidence and `verify` stay byte-identical.
import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { postingGate } from "../src/posting-gate.ts";
import type { RecordedFinding, ToolCallRecord } from "../src/types.ts";

const GATE = getAddress("0x12fab3e3ca810cc44bd9f537613a230a2be8d614");
const TARGET = getAddress("0xeeebba55620afc42e9c88b5d962476367b8da338");
const SINK = getAddress("0xc8702ca01e934f0568ea43b354c17ec7749d313f");
const ALLOWED = getAddress("0x00000000000000000000000000000000000000a1");

function simulation(flows: { from: Address; to: Address | null; value: string }[], ok = true): ToolCallRecord {
  return { id: "call_sim", name: "simulate_action", arguments: {}, output: { ok, error: null, revertReason: null, revertReasonTruncated: false, calls: [], valueFlows: flows, truncatedCalls: 0 }, onchain: true };
}
const finding = (code: string, severity: "low" | "medium" | "high"): RecordedFinding =>
  ({ code, severity, explanation: "x", sources: ["simulate_action"], origin: "model" }) as RecordedFinding;
const gate = (o: { findings?: RecordedFinding[]; toolCalls: ToolCallRecord[]; allowedTargets?: Address[] }) =>
  postingGate({ findings: o.findings ?? [], toolCalls: o.toolCalls, request: { gate: GATE, target: TARGET }, mandate: { allowedTargets: o.allowedTargets ?? [TARGET] } });

describe("postingGate", () => {
  it("passes a simulated action whose value reaches only the target, with no findings", () => {
    expect(gate({ toolCalls: [simulation([{ from: GATE, to: TARGET, value: "1000" }])] })).toBeNull();
  });

  it("declines when no simulation ran: SIMULATION_NOT_RUN", () => {
    expect(gate({ toolCalls: [] })).toMatch(/^SIMULATION_NOT_RUN/);
  });

  it("declines forwarding past the target and the allowlist without a high FUNDS_FORWARDED", () => {
    const toolCalls = [simulation([{ from: GATE, to: TARGET, value: "1000" }, { from: TARGET, to: SINK, value: "1000" }])];
    expect(gate({ toolCalls })).toMatch(new RegExp(`^FORWARDING_NOT_FLAGGED_HIGH: .*${SINK}`));
    expect(gate({ toolCalls, findings: [finding("FUNDS_FORWARDED", "low")] })).toMatch(/^FORWARDING_NOT_FLAGGED_HIGH/);
    expect(gate({ toolCalls, findings: [finding("FUNDS_FORWARDED", "high")] })).toBeNull();
  });

  it("forwarding to an allowlisted address or back to the gate isn't forwarding", () => {
    const toolCalls = [simulation([{ from: GATE, to: TARGET, value: "1000" }, { from: TARGET, to: ALLOWED, value: "10" }, { from: TARGET, to: GATE, value: "5" }])];
    expect(gate({ toolCalls, allowedTargets: [TARGET, ALLOWED] })).toBeNull();
  });

  it("declines a rubric-high code graded below high: SEVERITY_BELOW_RUBRIC", () => {
    const toolCalls = [simulation([{ from: GATE, to: TARGET, value: "1000" }])];
    for (const code of ["FUNDS_FORWARDED", "MANDATE_VIOLATION", "PERMISSION_CHANGE", "SIMULATION_FAILED"]) {
      expect(gate({ toolCalls, findings: [finding(code, "medium")] })).toBe(`SEVERITY_BELOW_RUBRIC: ${code} graded medium; risk-v1's rubric makes it high`);
      expect(gate({ toolCalls, findings: [finding(code, "high")] })).toBeNull();
    }
    expect(gate({ toolCalls, findings: [finding("NEW_CONTRACT", "medium"), finding("FRESH_COUNTERPARTY", "low")] })).toBeNull();
  });

  it("P12 re-check N3: value flows cut by the output cap, with no high FUNDS_FORWARDED: VALUE_FLOWS_TRUNCATED", () => {
    const capped = simulation([{ from: GATE, to: TARGET, value: "1000" }]);
    capped.output = { ...(capped.output as Record<string, unknown>), truncated: { valueFlows: 3 } } as ToolCallRecord["output"];
    expect(gate({ toolCalls: [capped] })).toBe("VALUE_FLOWS_TRUNCATED: the simulation's output cap dropped 3 value flow(s), so a forward may be hidden");
    expect(gate({ toolCalls: [capped], findings: [finding("FUNDS_FORWARDED", "high")] })).toBeNull();
  });

  it("a failed simulation still counts as run", () => {
    expect(gate({ toolCalls: [simulation([], false)], findings: [finding("SIMULATION_FAILED", "high")] })).toBeNull();
  });

  it("with no mandate, only the target and the gate are allowed", () => {
    const toolCalls = [simulation([{ from: GATE, to: TARGET, value: "1" }, { from: TARGET, to: ALLOWED, value: "1" }])];
    expect(postingGate({ findings: [], toolCalls, request: { gate: GATE, target: TARGET }, mandate: null })).toMatch(/^FORWARDING_NOT_FLAGGED_HIGH/);
  });
});
