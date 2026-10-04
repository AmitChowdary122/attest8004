// The e2e's expectations about agent 1984's daily cap (scripts/src/e2e.ts), kept free of env and RPC so they can
// be unit tested. Each e2e run adds an approved 0.001 MON (S, executed) to the agent's mandate-v1 spend for 25 h, and
// an approved 0.001 MON (R, never executed) until R's deadline passes.
import { MANDATE_V1, type SpendEntry } from "@attest8004/validator-mandate";
import { formatEther } from "viem";

const mon = (wei: bigint): string => `${formatEther(wei)} MON`;

/**
 * O's reasons, in the order `mandate-v1` reports them (validators/mandate/src/rules.ts): an unlisted target and a
 * value over the per-tx cap always; and `DAILY_CAP_EXCEEDED` once the spend O's own evidence counts plus O's value
 * is over the daily cap. That spend includes the run's S and R (both approved, deadlines still ahead), so O gets it
 * whenever anything else is counted.
 */
export function expectedReasonsO(o: { spendTotal: bigint; value: bigint; maxValuePerDay: bigint }): string[] {
  const reasons = ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"];
  if (o.spendTotal + o.value > o.maxValuePerDay) reasons.push("DAILY_CAP_EXCEEDED");
  return reasons;
}

/**
 * Why the run's in-mandate actions (`inMandateValues`: S and R) can't all be approved under the daily cap given the
 * agent's counted spend, or `null` when they fit (spend plus every value at most the cap). `mandate-v1` checks them
 * in order, and each later one's spend counts the earlier approvals, so all of them must fit together. The message
 * says when the oldest counted approval leaves the 25 h window.
 */
export function dailyCapShortfall(o: {
  spend: { total: bigint; entries: readonly SpendEntry[] };
  inMandateValues: readonly bigint[];
  maxValuePerDay: bigint;
}): string | null {
  const { spend, inMandateValues, maxValuePerDay } = o;
  const needed = inMandateValues.reduce((sum, value) => sum + value, 0n);
  if (spend.total + needed <= maxValuePerDay) return null;
  let oldest: bigint | undefined;
  for (const entry of spend.entries) {
    if (entry.counted && (oldest === undefined || entry.approvedAt < oldest)) oldest = entry.approvedAt;
  }
  const leaves = oldest === undefined ? "an unknown time" : new Date(Number(oldest + MANDATE_V1.spendWindowSeconds) * 1000).toISOString();
  return (
    `the run's in-mandate actions (${inMandateValues.map((value) => mon(value)).join(" + ")} = ${mon(needed)}) would exceed ` +
    `the daily cap (${mon(spend.total)} of ${mon(maxValuePerDay)} already counted); the oldest counted approval leaves ` +
    `the 25 h window at ${leaves}, or approve a mandate with a higher cap at https://attest8004.vercel.app/approve (and change E2E_MANDATE_TERMS in the SDK)`
  );
}
