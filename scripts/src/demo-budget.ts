/**
 * What one take of `pnpm demo` costs, and how many takes are left (P9, Decisions 4, 10, 15 and 16): the demo's MON
 * values, each key's gas at the caps, what the deployer's top-ups would be, the daily cap's room, the Groq tokens
 * left in a rolling day, and the smallest of those limits. Pure: the runner reads the chain and passes numbers in.
 */
import { DEFAULT_GAS, OPERATOR_REPORT_GAS_CAP, e2eMandate } from "@attest8004/sdk";
import { MANDATE_REASONS, type MandateReason } from "@attest8004/validator-mandate";
import { formatEther, parseEther } from "viem";
import { setMandateGasCap } from "./approval-plan.ts";
import { GAS, MANDATE_RESPONSE_GAS, RISK_RESPONSE_GAS } from "./live-validators.ts";

/** Scene 2's transfer to the owner, and scene 3's to the unknown address: the rogue one is inside the per-tx cap. */
export const DEMO_VALUES = { benign: parseEther("0.0005"), rogue: parseEther("0.001") } as const;
/** `forwarder.setAgentKey`'s limit (setup-demo-agents' measured basis, 3 Oct 2026). */
export const DEMO_GAS = { setAgentKey: 143_000n } as const;
/** `setMandate`'s cap for the e2e mandate (its three entries; the cap depends on the count, not the addresses). */
const SET_MANDATE_GAS = setMandateGasCap(e2eMandate({ owner: `0x${"01".repeat(20)}`, demoPassThrough: `0x${"02".repeat(20)}` }));

/** Groq's free tier for openai/gpt-oss-120b: tokens a day (console.groq.com/docs/rate-limits, read 5 Oct 2026). */
export const GROQ_DAILY_TOKENS = 200_000;
/** A risk-v1 check's tokens when no recorded verdict says better (the highest measured check was 11,497). */
export const TOKENS_PER_CHECK_FALLBACK = 12_000;
/** risk-v1 checks in a take: scene 2's and scene 3's. */
export const CHECKS_PER_TAKE = 2;
/** How many takes `--fund` tops each key up to. */
export const FUNDED_TAKES = 4;

export type KeyRole = "deployer" | "hotKey" | "rogueKey" | "validatorA" | "validatorB";
export type FundedRole = Exclude<KeyRole, "deployer">;
const FUNDED_ORDER: readonly FundedRole[] = ["hotKey", "rogueKey", "validatorA", "validatorB"];

/**
 * Each key's gas for one full take, at the caps (Monad charges the limit): two forwarded requests for each agent key;
 * two `setMandate`s (scenes 1 and 3b), two `setAgentKey`s (rogue, then back) and one `execute` for the deployer; two
 * responses and two operator reports for each validator.
 */
export function perTakeGas(): Record<KeyRole, bigint> {
  const requests = 2n * DEFAULT_GAS.forwarderRequest;
  return {
    hotKey: requests,
    rogueKey: requests,
    deployer: 2n * SET_MANDATE_GAS + 2n * DEMO_GAS.setAgentKey + GAS.execute,
    validatorA: 2n * (MANDATE_RESPONSE_GAS.max + OPERATOR_REPORT_GAS_CAP),
    validatorB: 2n * (RISK_RESPONSE_GAS.max + OPERATOR_REPORT_GAS_CAP),
  };
}

/** Whole takes `balance` pays for at `maxFeePerGas`. */
export function takesAffordable(balance: bigint, gasPerTake: bigint, maxFeePerGas: bigint): number {
  const perTake = gasPerTake * maxFeePerGas;
  return perTake === 0n ? 0 : Number(balance / perTake);
}

/**
 * The deployer's top-ups that bring every other key to `takes` takes at `maxFeePerGas`, and what the deployer keeps.
 * Refused (nothing to send) when the deployer would keep less than its own `takes` takes plus one vault top-up.
 */
export function fundingPlan(o: {
  balances: Record<KeyRole, bigint>;
  maxFeePerGas: bigint;
  takes: number;
  vaultTopUp: bigint;
  transferGas: bigint;
}): { topUps: { role: FundedRole; amount: bigint }[]; deployerAfter: bigint; refused: string | null } {
  const gas = perTakeGas();
  const takes = BigInt(o.takes);
  const topUps: { role: FundedRole; amount: bigint }[] = [];
  for (const role of FUNDED_ORDER) {
    const target = takes * gas[role] * o.maxFeePerGas;
    if (o.balances[role] < target) topUps.push({ role, amount: target - o.balances[role] });
  }
  const sent = topUps.reduce((sum, t) => sum + t.amount + o.transferGas * o.maxFeePerGas, 0n);
  const deployerAfter = o.balances.deployer - sent;
  const need = takes * gas.deployer * o.maxFeePerGas + o.vaultTopUp;
  const refused =
    deployerAfter < need
      ? `the top-ups would leave the deployer ${formatEther(deployerAfter)} MON, below the ${formatEther(need)} MON it needs for its own ${o.takes} takes and a vault top-up`
      : null;
  return { topUps, deployerAfter, refused };
}

/**
 * Takes left under the daily cap: each take's benign action adds `benign` to the counted spend before its rogue action
 * is checked, and a take counts while its rogue action still fits (so mandate-v1 gives exactly the two replay reasons).
 */
export function takesByCap(o: { spend: bigint; cap: bigint; benign: bigint; rogue: bigint }): number {
  const room = o.cap - o.spend - o.rogue;
  return room < 0n || o.benign === 0n ? 0 : Number(room / o.benign);
}

/**
 * mandate-v1's reasons for scene 3's rogue action, from the spend its own evidence counted: the target always, the
 * per-tx cap and the daily cap when they apply, and the permission change always. In MANDATE_REASONS order.
 */
export function expectedRogueReasons(o: { spendTotal: bigint; value: bigint; maxValuePerTx: bigint; maxValuePerDay: bigint }): MandateReason[] {
  const applies: Partial<Record<MandateReason, boolean>> = {
    TARGET_NOT_ALLOWED: true,
    VALUE_OVER_TX_CAP: o.value > o.maxValuePerTx,
    DAILY_CAP_EXCEEDED: o.spendTotal + o.value > o.maxValuePerDay,
    PERMISSION_CHANGED_AFTER_MANDATE: true,
  };
  return MANDATE_REASONS.filter((reason) => applies[reason] === true);
}

/** The tokens validator B recorded in the window `(now − windowSeconds, now]`; a row whose evidence couldn't be read is `unread`. */
export function tokensInWindow(
  rows: readonly { time: bigint; tokens: number | null }[],
  now: bigint,
  windowSeconds: bigint,
): { used: number; checks: number; unread: number; average: number | null } {
  let used = 0;
  let checks = 0;
  let unread = 0;
  for (const row of rows) {
    if (row.time <= now - windowSeconds || row.time > now) continue;
    if (row.tokens === null) unread += 1;
    else {
      used += row.tokens;
      checks += 1;
    }
  }
  return { used, checks, unread, average: checks === 0 ? null : Math.round(used / checks) };
}

const thousands = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The Groq line of the preflight: what's used, what's left, and how many takes that is. Warns, never refuses. */
export function groqRoom(o: { used: number | null; perCheck: number; checksPerTake: number; dailyLimit?: number }): {
  remaining: number | null;
  takes: number | null;
  warn: boolean;
  line: string;
} {
  const limit = o.dailyLimit ?? GROQ_DAILY_TOKENS;
  const perTake = o.perCheck * o.checksPerTake;
  if (o.used === null) {
    return {
      remaining: null,
      takes: null,
      warn: true,
      line: `Groq: today's use is unknown (validator B's recorded verdicts couldn't be read); a take needs about ${thousands(perTake)} of the ${thousands(limit)} tokens a day`,
    };
  }
  const remaining = Math.max(0, limit - o.used);
  const takes = Math.floor(remaining / perTake);
  return {
    remaining,
    takes,
    warn: takes < 1,
    line: `Groq: ${thousands(o.used)} of ${thousands(limit)} tokens used in the last 24 h, about ${thousands(remaining)} left: ${plural(takes, "take")} at about ${thousands(perTake)} a take`,
  };
}

/** The smallest known limit on takes, and which one it is; unknown limits are listed and left out. */
export function takesLeft(limits: readonly { name: string; takes: number | null }[]): {
  takes: number | null;
  limitedBy: string | null;
  unknown: string[];
} {
  let takes: number | null = null;
  let limitedBy: string | null = null;
  const unknown: string[] = [];
  for (const limit of limits) {
    if (limit.takes === null) unknown.push(limit.name);
    else if (takes === null || limit.takes < takes) {
      takes = limit.takes;
      limitedBy = limit.name;
    }
  }
  return { takes, limitedBy, unknown };
}
