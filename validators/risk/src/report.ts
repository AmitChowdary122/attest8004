// risk-v1's operator report (SPEC §4.7): each finding's explanation (the model's words, or code's for an injection
// flag) with a recommended action from a fixed table here, never from the model, so a recommendation can't be
// prompt-injected and the frozen risk-v1 output schema stays as it is. Built from the evidence just published.
import { canonicalJson, REPORT_SCHEMA_V1, type OperatorReport } from "@attest8004/sdk";
import type { Hex } from "viem";
import { z } from "zod";
import { PROMPT_INJECTION_SUSPECTED, type ModelFindingCode } from "./findings.ts";
import { RISK_V1 } from "./params.ts";

/** The recommended action for each finding code: what the operator should do about it. */
export const RISK_ACTIONS: Record<ModelFindingCode | typeof PROMPT_INJECTION_SUSPECTED, string> = {
  FUNDS_FORWARDED: "Don't execute it. Find out where the target sends the value; if that isn't expected, remove the target from the mandate.",
  NEW_CONTRACT: "Review the contract (its source and deployer) before executing; a contract days old has no track record.",
  FRESH_COUNTERPARTY: "Confirm the counterparty out of band before executing; an address that has never transacted is unknown.",
  MANDATE_VIOLATION: "Don't execute it. mandate-v1's report names the rule that failed.",
  PERMISSION_CHANGE: "Check the permission change; if you didn't make it, revoke the mandate now (owner only) and investigate.",
  SIMULATION_FAILED: "Don't execute it: the action fails at the checked block.",
  LOW_REPUTATION: "Treat the counterparty as untrusted, and require more validation before acting with it.",
  RISKY_LABEL: "Check what the label says about the address before executing.",
  SUSPICIOUS_CALLDATA: "Decode the calldata and confirm it does only what the agent claims.",
  OTHER: "Read the explanation and decide before executing.",
  PROMPT_INJECTION_SUSPECTED:
    "Untrusted text tried to steer the model: read the flagged fields in the public evidence before trusting this verdict.",
};

/** The parts of `risk-v1`'s published evidence the report reads, after a canonical-JSON round trip. */
const evidenceView = z.object({
  requestHash: z.string(),
  score: z.number(),
  request: z.object({ agentId: z.string() }),
  findings: z.array(z.object({ code: z.string(), severity: z.enum(["low", "medium", "high"]), explanation: z.string() })),
});

/** The report schema's limit on an item's text, in characters; a longer explanation is clipped (never split mid-character). */
const MAX_TEXT_CHARS = 600;
const clip = (text: string) => {
  const chars = Array.from(text);
  return chars.length > MAX_TEXT_CHARS ? `${chars.slice(0, MAX_TEXT_CHARS - 1).join("")}…` : text;
};

const MODEL_NOTE = "Explanations are the model's (advisory; recorded, not re-run); the score is computed in code from the severities.";

/**
 * The operator report for one `risk-v1` verdict, from the evidence document the validator just published (as
 * `onResponded` receives it) and its `responseHash`. Throws if the evidence isn't `risk-v1`'s shape.
 */
export function riskReport(o: { evidence: Record<string, unknown>; responseHash: Hex }): OperatorReport {
  const e = evidenceView.parse(JSON.parse(canonicalJson(o.evidence)));
  const count = (severity: "low" | "medium" | "high") => e.findings.filter((f) => f.severity === severity).length;
  return {
    schema: REPORT_SCHEMA_V1,
    tag: RISK_V1.tag,
    requestHash: e.requestHash as Hex,
    agentId: e.request.agentId,
    score: e.score,
    responseHash: o.responseHash,
    summary:
      e.findings.length === 0
        ? `Score ${e.score}: no findings.`
        : `Score ${e.score}: ${count("high")} high, ${count("medium")} medium, ${count("low")} low finding(s).`,
    items: e.findings.map((f) => ({
      code: f.code,
      severity: f.severity,
      text: clip(f.explanation),
      action: RISK_ACTIONS[f.code as keyof typeof RISK_ACTIONS] ?? RISK_ACTIONS.OTHER,
    })),
    notes: [MODEL_NOTE],
  };
}
