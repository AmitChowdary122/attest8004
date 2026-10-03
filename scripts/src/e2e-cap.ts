// The e2e's expectations about agent 1984's daily cap (scripts/src/e2e.ts), kept free of env and RPC so they can
// be unit tested. Each e2e run adds an approved 0.001 MON (A) to the agent's mandate-v1 spend for 25 h.
import { MANDATE_V1, type SpendEntry } from "@attest8004/validator-mandate";
import { formatEther } from "viem";

const mon = (wei: bigint): string => `${formatEther(wei)} MON`;

/**
 * B's reasons, in the order `mandate-v1` reports them (validators/mandate/src/rules.ts): an unlisted target and a
 * value over the per-tx cap always; and `DAILY_CAP_EXCEEDED` once the spend B's own evidence counts plus B's value
 * is over the daily cap (from the third run in any 25 h).
 */
export function expectedReasonsB(o: { spendTotal: bigint; value: bigint; maxValuePerDay: bigint }): string[] {
  const reasons = ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"];
  if (o.spendTotal + o.value > o.maxValuePerDay) reasons.push("DAILY_CAP_EXCEEDED");
  return reasons;
}

/**
 * Why A (`value`) can't be approved under the daily cap given the agent's counted spend, or `null` when it fits
 * (spend + value at most the cap). The message says when the oldest counted approval leaves the 25 h window.
 */
export function dailyCapShortfall(o: {
  spend: { total: bigint; entries: readonly SpendEntry[] };
  value: bigint;
  maxValuePerDay: bigint;
}): string | null {
  const { spend, value, maxValuePerDay } = o;
  if (spend.total + value <= maxValuePerDay) return null;
  let oldest: bigint | undefined;
  for (const entry of spend.entries) {
    if (entry.counted && (oldest === undefined || entry.approvedAt < oldest)) oldest = entry.approvedAt;
  }
  const leaves = oldest === undefined ? "an unknown time" : new Date(Number(oldest + MANDATE_V1.spendWindowSeconds) * 1000).toISOString();
  return (
    `A (${mon(value)}) would exceed the daily cap (${mon(spend.total)} of ${mon(maxValuePerDay)} already counted); ` +
    `the oldest counted approval leaves the 25 h window at ${leaves}, or raise the mandate's cap with set-mandate ` +
    "(and E2E_MANDATE in e2e.ts)"
  );
}
