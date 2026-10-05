// mandate-v1's operator report (SPEC §4.7): its reasons and the agent's spend in plain words, built from the
// evidence it has just published. The verdict data stays public at responseURI; this is the operator's reading of it,
// sealed to the agent's inbox key by the validator's onResponded.
import { canonicalJson, REPORT_SCHEMA_V1, type OperatorReport } from "@attest8004/sdk";
import { formatEther, type Hex } from "viem";
import { z } from "zod";
import { MANDATE_V1 } from "./params.ts";
import { MANDATE_REASONS, type MandateReason } from "./rules.ts";

/** The parts of `mandate-v1`'s published evidence the report reads, after a canonical-JSON round trip (bigints as decimal strings). */
const evidenceView = z.object({
  requestHash: z.string(),
  score: z.number(),
  reasons: z.array(z.string()),
  request: z.object({ agentId: z.string(), target: z.string(), value: z.string(), selector: z.string().nullable() }),
  mandate: z
    .object({ maxValuePerTx: z.string(), maxValuePerDay: z.string(), validUntil: z.string(), owner: z.string(), currentOwner: z.string() })
    .nullable(),
  spend: z.union([
    z.null(),
    z.object({ unreadable: z.string() }),
    z.object({ total: z.string(), entries: z.array(z.object({ counted: z.boolean() })) }),
  ]),
  permissions: z.object({ events: z.array(z.object({ block: z.string(), event: z.string(), afterMandate: z.boolean() })) }),
  simulation: z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), error: z.string() })]),
});
type EvidenceView = z.output<typeof evidenceView>;

const mon = (wei: string | bigint) => `${formatEther(BigInt(wei))} MON`;
const date = (seconds: string) => new Date(Number(seconds) * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
/** At most this many permission events are named in one item; the rest are counted. */
const MAX_LISTED_EVENTS = 6;

/** Each reason's plain-words text (one sentence of what happened) and recommended action (one of what to do). */
export const MANDATE_REASON_TEXT: Record<MandateReason, { text: (e: EvidenceView) => string; action: string }> = {
  MANDATE_MISSING: {
    text: (e) => `Agent ${e.request.agentId} has no mandate (never set, or revoked).`,
    action: "Approve a mandate on /approve before the agent acts.",
  },
  MANDATE_OWNER_CHANGED: {
    text: (e) => `The mandate was set by ${e.mandate?.owner ?? "a previous owner"}, who no longer owns the agent (${e.mandate?.currentOwner ?? "someone else"} does).`,
    action: "The new owner approves a fresh mandate on /approve.",
  },
  MANDATE_EXPIRED: {
    text: (e) => `The mandate expired at ${e.mandate ? date(e.mandate.validUntil) : "an earlier time"}.`,
    action: "Approve a new mandate with a later expiry.",
  },
  ACTION_EXPIRED: {
    text: () => "The action's deadline had already passed at the block the validator checked.",
    action: "Have the agent propose it again with a fresh deadline.",
  },
  DEADLINE_AFTER_MANDATE: {
    text: (e) => `The action's deadline is after the mandate's expiry${e.mandate ? ` (${date(e.mandate.validUntil)})` : ""}.`,
    action: "Propose it with an earlier deadline, or renew the mandate.",
  },
  TARGET_NOT_ALLOWED: {
    text: (e) => `The action sends to ${e.request.target}, which the mandate doesn't allow.`,
    action: "Don't execute it. If the target is legitimate, approve a mandate that lists it on /approve.",
  },
  SELECTOR_NOT_ALLOWED: {
    text: (e) =>
      e.request.selector === null
        ? "The action's calldata holds no function selector the mandate could allow."
        : `The action calls the function with selector ${e.request.selector}, which the mandate doesn't allow.`,
    action: "Don't execute it. If the call is legitimate, approve a mandate that allows its selector.",
  },
  VALUE_OVER_TX_CAP: {
    text: (e) => `The action moves ${mon(e.request.value)}; the mandate allows at most ${e.mandate ? mon(e.mandate.maxValuePerTx) : "less"} per transaction.`,
    action: "Don't execute it. Reduce or split the payment, or approve a higher per-transaction cap.",
  },
  DAILY_CAP_EXCEEDED: {
    text: (e) => {
      const counted = e.spend !== null && "total" in e.spend ? BigInt(e.spend.total) : 0n;
      return `With this action the agent would spend ${mon(counted + BigInt(e.request.value))} in 24 h; the mandate's daily cap is ${e.mandate ? mon(e.mandate.maxValuePerDay) : "lower"}.`;
    },
    action: "Wait until earlier approvals leave the 25 h window, or approve a higher daily cap.",
  },
  SPEND_HISTORY_UNREADABLE: {
    text: () => "An earlier approval's evidence couldn't be read, so the agent's daily spend couldn't be counted.",
    action: "Check the earlier approvals with pnpm attest8004 verify before trusting this agent's spend.",
  },
  PERMISSION_CHANGED_AFTER_MANDATE: {
    text: (e) => {
      const after = e.permissions.events.filter((event) => event.afterMandate);
      const listed = after.slice(0, MAX_LISTED_EVENTS).map((event) => `${event.event} at block ${event.block}`);
      const more = after.length > MAX_LISTED_EVENTS ? `; and ${after.length - MAX_LISTED_EVENTS} more` : "";
      return `${after.length} permission change(s) after the current mandate was set: ${listed.join("; ")}${more}.`;
    },
    action:
      "If you didn't make this change, revoke the mandate now (owner only, no passkey) and investigate; if you did, approve the mandate again to accept it.",
  },
  SIMULATION_FAILED: {
    text: (e) => `Simulating the action at the checked block failed${e.simulation.ok ? "" : ` (${e.simulation.error})`}.`,
    action: "Don't execute it: it would fail onchain.",
  },
};

function spendNote(e: EvidenceView): string {
  if (e.spend === null) return "Daily spend: no mandate, so nothing is capped.";
  if ("unreadable" in e.spend) return "Daily spend: an earlier approval's evidence was unreadable, so spend couldn't be counted.";
  const counted = e.spend.entries.filter((entry) => entry.counted).length;
  const cap = e.mandate ? mon(e.mandate.maxValuePerDay) : "unknown";
  const hours = Number(MANDATE_V1.spendWindowSeconds / 3_600n);
  return `Daily spend: ${mon(e.spend.total)} already counted against the ${cap} cap (${counted} approval(s) in the last ${hours} h); this action asks for ${mon(e.request.value)}.`;
}

/**
 * The operator report for one `mandate-v1` verdict, from the evidence document the validator just published (as
 * `onResponded` receives it) and its `responseHash`. Throws if the evidence isn't `mandate-v1`'s shape.
 */
export function mandateReport(o: { evidence: Record<string, unknown>; responseHash: Hex }): OperatorReport {
  const e = evidenceView.parse(JSON.parse(canonicalJson(o.evidence)));
  const reasons = e.reasons.filter((r): r is MandateReason => (MANDATE_REASONS as readonly string[]).includes(r));
  return {
    schema: REPORT_SCHEMA_V1,
    tag: MANDATE_V1.tag,
    requestHash: e.requestHash as Hex,
    agentId: e.request.agentId,
    score: e.score,
    responseHash: o.responseHash,
    summary:
      e.score === 100
        ? `Approved: agent ${e.request.agentId}'s action is inside its mandate (score 100).`
        : `Refused: ${reasons.length} mandate rule(s) failed (score ${e.score}).`,
    items: reasons.map((code) => ({ code, severity: null, text: MANDATE_REASON_TEXT[code].text(e), action: MANDATE_REASON_TEXT[code].action })),
    notes: [spendNote(e)],
  };
}
