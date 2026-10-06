import { getAddress, type Address } from "viem";
import type { RecordedFinding, ToolCallRecord } from "./types.ts";

/** The codes risk-v1's rubric (prompt.ts) makes high: a lower grade breaks the rubric. */
const RUBRIC_HIGH_CODES: ReadonlySet<string> = new Set(["FUNDS_FORWARDED", "MANDATE_VIOLATION", "PERMISSION_CHANGE", "SIMULATION_FAILED"]);

/**
 * Whether validator B may post this verdict at all (P12, AUD-04, the owner's route A+): a decline reason, or null.
 * It refuses, before anything is posted, a model output that breaks risk-v1's own rubric in a way that could let a
 * fund-forwarding action through — the score itself stays code's `scoreOf(findings)`, untouched:
 *
 * - `SIMULATION_NOT_RUN`: the model never called `simulate_action`, so nothing was checked for value flows;
 * - `FORWARDING_NOT_FLAGGED_HIGH`: a recorded simulation shows value reaching an address that is not the target, the
 *   gate or in the mandate's `allowedTargets`, and there is no `FUNDS_FORWARDED` finding graded high;
 * - `SEVERITY_BELOW_RUBRIC`: `FUNDS_FORWARDED`, `MANDATE_VIOLATION`, `PERMISSION_CHANGE` or `SIMULATION_FAILED`
 *   graded below high.
 *
 * A decline posts nothing, so the gate's "B at least 80" fails closed, and every verdict B still posts means what
 * risk-v1 meant before: its evidence and `verify` are unchanged. It can't make a simulation sound against a target that
 * detects it (a limitation stated in ARCHITECTURE §9): it only stops the model from waiving what the simulation showed.
 */
export function postingGate(o: {
  findings: readonly RecordedFinding[];
  toolCalls: readonly ToolCallRecord[];
  request: { gate: Address; target: Address };
  mandate: { allowedTargets: readonly Address[] } | null;
}): string | null {
  const simulations = o.toolCalls.filter((call) => call.name === "simulate_action" && flowsOf(call.output) !== null);
  if (simulations.length === 0) return "SIMULATION_NOT_RUN: the model never called simulate_action";

  const allowed = new Set([o.request.gate, o.request.target, ...(o.mandate?.allowedTargets ?? [])].map((a) => getAddress(a)));
  const outside = simulations.flatMap((call) => flowsOf(call.output) ?? []).find((flow) => flow.to !== null && !allowed.has(flow.to));
  const flaggedHigh = o.findings.some((f) => f.code === "FUNDS_FORWARDED" && f.severity === "high");
  if (outside && !flaggedHigh) {
    return `FORWARDING_NOT_FLAGGED_HIGH: the simulation sends value to ${outside.to}, outside the target and the mandate, with no high FUNDS_FORWARDED`;
  }
  const below = o.findings.find((f) => RUBRIC_HIGH_CODES.has(f.code) && f.severity !== "high");
  if (below) return `SEVERITY_BELOW_RUBRIC: ${below.code} graded ${below.severity}; risk-v1's rubric makes it high`;
  return null;
}

/** A recorded `simulate_action` output's value flows (recipients checksummed), or null when it isn't one. */
function flowsOf(output: unknown): { to: Address | null }[] | null {
  if (typeof output !== "object" || output === null || !("valueFlows" in output)) return null;
  const flows = (output as { valueFlows: unknown }).valueFlows;
  if (!Array.isArray(flows)) return null;
  return flows.map((flow) => {
    const to = typeof flow === "object" && flow !== null && "to" in flow ? (flow as { to: unknown }).to : null;
    return { to: typeof to === "string" ? getAddress(to) : null };
  });
}
