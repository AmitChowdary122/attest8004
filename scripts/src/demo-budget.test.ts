import { MANDATE_REASONS } from "@attest8004/validator-mandate";
import { describe, expect, it } from "vitest";
import {
  DEMO_VALUES,
  expectedRogueReasons,
  fundingPlan,
  groqRoom,
  perTakeGas,
  takesAffordable,
  takesByCap,
  takesLeft,
  tokensInWindow,
  type KeyRole,
} from "./demo-budget.ts";

const GWEI = 1_000_000_000n;
const MON = 10n ** 18n;

describe("perTakeGas", () => {
  it("is each key's gas for one take at the caps", () => {
    expect(perTakeGas()).toEqual({ hotKey: 630_000n, rogueKey: 630_000n, deployer: 1_347_000n, validatorA: 1_660_000n, validatorB: 2_860_000n });
  });
});

describe("takesAffordable", () => {
  it("is the whole takes a balance pays for at the max fee", () => {
    expect(takesAffordable(MON, 630_000n, 100n * GWEI)).toBe(15);
    expect(takesAffordable(0n, 630_000n, 100n * GWEI)).toBe(0);
  });
});

describe("fundingPlan", () => {
  const fee = 100n * GWEI;
  const vaultTopUp = MON / 100n;
  const transferGas = 26_000n;
  const target = (role: KeyRole) => 4n * perTakeGas()[role] * fee;
  const deployerNeed = 4n * 1_347_000n * fee + vaultTopUp;

  it("tops up each short key by exactly its shortfall, in the order hot key, rogue key, A, B, and leaves funded keys alone", () => {
    const balances = { deployer: 10n * MON, hotKey: target("hotKey") - 5n, rogueKey: 0n, validatorA: target("validatorA"), validatorB: target("validatorB") - 7n };
    const plan = fundingPlan({ balances, maxFeePerGas: fee, takes: 4, vaultTopUp, transferGas });
    expect(plan.topUps).toEqual([
      { role: "hotKey", amount: 5n },
      { role: "rogueKey", amount: target("rogueKey") },
      { role: "validatorB", amount: 7n },
    ]);
    expect(plan.deployerAfter).toBe(10n * MON - 5n - target("rogueKey") - 7n - 3n * transferGas * fee);
    expect(plan.refused).toBeNull();
  });

  it("refuses, naming both amounts, when the deployer would be left below its own takes plus a vault top-up; one wei above is accepted", () => {
    const short = { hotKey: 0n, rogueKey: target("rogueKey"), validatorA: target("validatorA"), validatorB: target("validatorB") };
    const spent = target("hotKey") + transferGas * fee;
    const below = fundingPlan({ balances: { ...short, deployer: deployerNeed + spent - 1n }, maxFeePerGas: fee, takes: 4, vaultTopUp, transferGas });
    expect(below.refused).toMatch(/0\.\d+ MON/);
    expect(below.refused).toContain(`${Number(deployerNeed) / 1e18}`);
    const above = fundingPlan({ balances: { ...short, deployer: deployerNeed + spent + 1n }, maxFeePerGas: fee, takes: 4, vaultTopUp, transferGas });
    expect(above.refused).toBeNull();
    expect(above.deployerAfter).toBe(deployerNeed + 1n);
  });

  it("has nothing to send when every key is funded", () => {
    const balances = { deployer: 10n * MON, hotKey: MON, rogueKey: MON, validatorA: 10n * MON, validatorB: 10n * MON };
    expect(fundingPlan({ balances, maxFeePerGas: fee, takes: 4, vaultTopUp, transferGas })).toEqual({ topUps: [], deployerAfter: 10n * MON, refused: null });
  });
});

describe("takesByCap", () => {
  const o = { cap: 5_000_000_000_000_000n, benign: DEMO_VALUES.benign, rogue: DEMO_VALUES.rogue };
  it("counts the takes whose rogue action still gets exactly the two replay reasons (benign spend added, never negative)", () => {
    expect(DEMO_VALUES).toEqual({ benign: 500_000_000_000_000n, rogue: 1_000_000_000_000_000n });
    expect(takesByCap({ ...o, spend: 0n })).toBe(8);
    expect(takesByCap({ ...o, spend: 3_500_000_000_000_000n })).toBe(1);
    expect(takesByCap({ ...o, spend: 3_600_000_000_000_000n })).toBe(0);
    expect(takesByCap({ ...o, spend: 6_000_000_000_000_000n })).toBe(0);
  });
});

describe("expectedRogueReasons", () => {
  const caps = { maxValuePerTx: 2_000_000_000_000_000n, maxValuePerDay: 5_000_000_000_000_000n };
  it("is the target and the permission change with nothing counted", () => {
    expect(expectedRogueReasons({ ...caps, spendTotal: 0n, value: 1_000_000_000_000_000n })).toEqual(["TARGET_NOT_ALLOWED", "PERMISSION_CHANGED_AFTER_MANDATE"]);
  });
  it("adds DAILY_CAP_EXCEEDED once the spend plus the value passes the cap", () => {
    expect(expectedRogueReasons({ ...caps, spendTotal: 4_500_000_000_000_000n, value: 1_000_000_000_000_000n })).toEqual([
      "TARGET_NOT_ALLOWED",
      "DAILY_CAP_EXCEEDED",
      "PERMISSION_CHANGED_AFTER_MANDATE",
    ]);
  });
  it("adds VALUE_OVER_TX_CAP right after TARGET_NOT_ALLOWED, always in MANDATE_REASONS order", () => {
    const reasons = expectedRogueReasons({ ...caps, spendTotal: 0n, value: 3_000_000_000_000_000n });
    expect(reasons.slice(0, 2)).toEqual(["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"]);
    const order = reasons.map((r) => MANDATE_REASONS.indexOf(r));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("tokensInWindow", () => {
  it("excludes a row exactly at the window's start, counts unread rows apart, and averages read rows only", () => {
    const now = 100_000n;
    const window = 86_400n;
    const result = tokensInWindow(
      [
        { time: now - window, tokens: 50_000 },
        { time: now - window + 1n, tokens: 10_000 },
        { time: now - 10n, tokens: 12_000 },
        { time: now - 5n, tokens: null },
      ],
      now,
      window,
    );
    expect(result).toEqual({ used: 22_000, checks: 2, unread: 1, average: 11_000 });
    expect(tokensInWindow([], now, window)).toEqual({ used: 0, checks: 0, unread: 0, average: null });
  });
});

describe("groqRoom", () => {
  it("says how many takes the rest of the day's tokens cover", () => {
    const room = groqRoom({ used: 176_000, perCheck: 12_000, checksPerTake: 2 });
    expect(room).toMatchObject({ remaining: 24_000, takes: 1, warn: false });
    expect(room.line).toContain("176,000 of 200,000");
    expect(room.line).toContain("1 take");
    expect(room.line).not.toContain("1 takes");
  });
  it("warns with fewer than one take left", () => {
    expect(groqRoom({ used: 190_000, perCheck: 12_000, checksPerTake: 2 })).toMatchObject({ takes: 0, warn: true });
  });
  it("warns, never guesses, when the use is unknown", () => {
    const room = groqRoom({ used: null, perCheck: 12_000, checksPerTake: 2 });
    expect(room).toMatchObject({ remaining: null, takes: null, warn: true });
    expect(room.line).toContain("unknown");
  });
});

describe("takesLeft", () => {
  it("is the smallest known limit, naming it", () => {
    expect(takesLeft([{ name: "Groq", takes: 1 }, { name: "daily cap", takes: 8 }, { name: "hot key", takes: 3 }])).toEqual({ takes: 1, limitedBy: "Groq", unknown: [] });
  });
  it("lists unknown limits and leaves them out of the minimum", () => {
    expect(takesLeft([{ name: "Groq", takes: null }, { name: "hot key", takes: 3 }])).toEqual({ takes: 3, limitedBy: "hot key", unknown: ["Groq"] });
    expect(takesLeft([{ name: "Groq", takes: null }])).toEqual({ takes: null, limitedBy: null, unknown: ["Groq"] });
  });
});
