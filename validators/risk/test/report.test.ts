import { buildEvidence, encodeReport, fitReport, MAX_REPORT_PLAINTEXT_BYTES, operatorReportSchema } from "@attest8004/sdk";
import { keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { riskEvidence } from "../src/evidence.ts";
import { MODEL_FINDING_CODES, PROMPT_INJECTION_SUSPECTED } from "../src/findings.ts";
import { RISK_V1 } from "../src/params.ts";
import { RISK_ACTIONS, riskReport } from "../src/report.ts";
import type { RecordedFinding } from "../src/types.ts";
import { sampleRiskRecord, SINK } from "./helpers/risk-fakes.ts";

const REQUEST_HASH = keccak256(toHex("rhB"));
const RESPONSE_HASH = keccak256(toHex("evidence B"));

function evidenceWith(findings: RecordedFinding[], score: number): Record<string, unknown> {
  return buildEvidence({
    tag: RISK_V1.tag,
    requestHash: REQUEST_HASH,
    result: { score, reasons: findings.map((f) => f.code), evidence: riskEvidence(sampleRiskRecord({ findings })) },
  });
}

const forwarded: RecordedFinding = {
  code: "FUNDS_FORWARDED",
  severity: "high",
  explanation: `The target forwards all of it to ${SINK}.`,
  sources: ["simulate_action"],
  origin: "model",
};
const fresh: RecordedFinding = { code: "FRESH_COUNTERPARTY", severity: "medium", explanation: "The sink has no code and nonce 0.", sources: ["counterparty_onchain"], origin: "model" };
const injection: RecordedFinding = {
  code: PROMPT_INJECTION_SUSPECTED,
  severity: "medium",
  explanation: "Prompt Guard flagged untrusted text in: calldata_text.",
  sources: ["classifier:calldata_text"],
  origin: "code",
};

describe("riskReport", () => {
  it("one item per finding, model's then code's, with explanation and the table's action", () => {
    const report = riskReport({ evidence: evidenceWith([forwarded, fresh, injection], 0), responseHash: RESPONSE_HASH });
    expect(report).toMatchObject({ schema: "attest8004.report.v1", tag: "risk-v1", requestHash: REQUEST_HASH, score: 0, responseHash: RESPONSE_HASH });
    expect(report.agentId).toBe(sampleRiskRecord().request.agentId.toString());
    expect(report.items).toEqual([
      { code: "FUNDS_FORWARDED", severity: "high", text: forwarded.explanation, action: RISK_ACTIONS.FUNDS_FORWARDED },
      { code: "FRESH_COUNTERPARTY", severity: "medium", text: fresh.explanation, action: RISK_ACTIONS.FRESH_COUNTERPARTY },
      { code: PROMPT_INJECTION_SUSPECTED, severity: "medium", text: injection.explanation, action: RISK_ACTIONS.PROMPT_INJECTION_SUSPECTED },
    ]);
    expect(RISK_ACTIONS.FUNDS_FORWARDED).toBe(
      "Don't execute it. Find out where the target sends the value; if that isn't expected, remove the target from the mandate.",
    );
    expect(report.notes).toEqual([
      "Explanations are the model's (advisory; recorded, not re-run); the score is computed in code from the severities.",
    ]);
  });

  it("every MODEL_FINDING_CODES entry and PROMPT_INJECTION_SUSPECTED has an action", () => {
    for (const code of [...MODEL_FINDING_CODES, PROMPT_INJECTION_SUSPECTED]) {
      expect(RISK_ACTIONS[code], code).toBeDefined();
      expect(RISK_ACTIONS[code].length, code).toBeGreaterThan(10);
      expect(RISK_ACTIONS[code].length, code).toBeLessThanOrEqual(300);
    }
  });

  it("summary counts by severity", () => {
    expect(riskReport({ evidence: evidenceWith([forwarded, fresh, injection], 0), responseHash: RESPONSE_HASH }).summary).toBe(
      "Score 0: 1 high, 2 medium, 0 low finding(s).",
    );
    expect(riskReport({ evidence: evidenceWith([], 100), responseHash: RESPONSE_HASH }).summary).toBe("Score 100: no findings.");
  });

  it("nine 400-char explanations of 3-byte characters: fitReport clips them, and the report encodes", () => {
    const long = (code: RecordedFinding["code"]): RecordedFinding => ({ code, severity: "low", explanation: "€".repeat(400), sources: ["request"], origin: "model" });
    const findings = [...MODEL_FINDING_CODES.slice(0, 8).map(long), { ...injection, explanation: "€".repeat(400) }];
    const report = riskReport({ evidence: evidenceWith(findings, 40), responseHash: RESPONSE_HASH });
    expect(operatorReportSchema.safeParse(report).success).toBe(true);
    const fitted = fitReport(report);
    expect(fitted.items.every((it) => it.text === `${"€".repeat(200)}…`)).toBe(true);
    expect(encodeReport(fitted).length).toBeLessThanOrEqual(MAX_REPORT_PLAINTEXT_BYTES);
  });
});
