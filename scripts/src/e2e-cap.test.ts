import { MANDATE_V1, type SpendEntry } from "@attest8004/validator-mandate";
import { getAddress, keccak256, parseEther, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { dailyCapShortfall, expectedReasonsO } from "./e2e-cap.ts";

const CAP = parseEther("0.005");
const S = parseEther("0.001");
const R = parseEther("0.001");
const O = parseEther("0.003");
const GATE = getAddress("0x12fab3e3ca810cc44bd9f537613a230a2be8d614");

function entry(n: number, approvedAt: bigint, counted = true): SpendEntry {
  return {
    requestHash: keccak256(toHex(`approval ${n}`)),
    approvedAt,
    gate: GATE,
    value: S,
    deadline: approvedAt + 1_800n,
    consumed: counted,
    counted,
  };
}

describe("expectedReasonsO", () => {
  // O's own evidence counts S and R (both approved, their deadlines still ahead), plus every earlier counted approval.
  it.each([
    { prior: "0", spend: "0.002", reasons: ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"] },
    { prior: "0.001", spend: "0.003", reasons: ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP", "DAILY_CAP_EXCEEDED"] },
    { prior: "0.003", spend: "0.005", reasons: ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP", "DAILY_CAP_EXCEEDED"] },
  ])("earlier spend $prior MON (O's spend $spend MON): $reasons", ({ spend, reasons }) => {
    expect(expectedReasonsO({ spendTotal: parseEther(spend), value: O, maxValuePerDay: CAP })).toEqual(reasons);
  });

  it("expected O reasons add DAILY_CAP_EXCEEDED when spend + 0.003 > cap", () => {
    // At the cap exactly, mandate-v1 still passes the daily rule (it fails spend + value > cap).
    expect(expectedReasonsO({ spendTotal: CAP - O, value: O, maxValuePerDay: CAP })).toEqual(["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"]);
    expect(expectedReasonsO({ spendTotal: CAP - O + 1n, value: O, maxValuePerDay: CAP })).toEqual([
      "TARGET_NOT_ALLOWED",
      "VALUE_OVER_TX_CAP",
      "DAILY_CAP_EXCEEDED",
    ]);
  });
});

describe("dailyCapShortfall", () => {
  it("two in-mandate actions must both fit: spend 0.003 + 0.001 + 0.001 = 0.005 fits, 0.004 doesn't", () => {
    const three = [1, 2, 3].map((n) => entry(n, 1_790_000_000n + BigInt(n)));
    expect(dailyCapShortfall({ spend: { total: parseEther("0.003"), entries: three }, inMandateValues: [S, R], maxValuePerDay: CAP })).toBeNull();
    const four = [1, 2, 3, 4].map((n) => entry(n, 1_790_000_000n + BigInt(n)));
    expect(dailyCapShortfall({ spend: { total: parseEther("0.004"), entries: four }, inMandateValues: [S, R], maxValuePerDay: CAP })).not.toBeNull();
  });

  it("is null with no counted spend, and counts every in-mandate value (not just the first)", () => {
    expect(dailyCapShortfall({ spend: { total: 0n, entries: [] }, inMandateValues: [S, R], maxValuePerDay: CAP })).toBeNull();
    // S alone would fit at 0.004, but S and R together don't.
    const four = [1, 2, 3, 4].map((n) => entry(n, 1_790_000_000n + BigInt(n)));
    expect(dailyCapShortfall({ spend: { total: parseEther("0.004"), entries: four }, inMandateValues: [S], maxValuePerDay: CAP })).toBeNull();
    expect(dailyCapShortfall({ spend: { total: parseEther("0.004"), entries: four }, inMandateValues: [S, R], maxValuePerDay: CAP })).not.toBeNull();
  });

  it("names the values, the cap, when the oldest counted approval leaves the 25 h window, and how to raise the cap", () => {
    const oldest = 1_790_000_000n;
    const entries = [entry(1, oldest + 50n), entry(2, oldest - 10n, false), entry(3, oldest), entry(4, oldest + 70n)];
    const message = dailyCapShortfall({ spend: { total: 4n * S, entries }, inMandateValues: [S, R], maxValuePerDay: CAP });
    const leaves = new Date(Number(oldest + MANDATE_V1.spendWindowSeconds) * 1000).toISOString();
    expect(message).toBe(
      `the run's in-mandate actions (0.001 MON + 0.001 MON = 0.002 MON) would exceed the daily cap (0.004 MON of 0.005 MON ` +
        `already counted); the oldest counted approval leaves the 25 h window at ${leaves}, or approve a mandate with a ` +
        "higher cap at https://attest8004.vercel.app/approve (and change E2E_MANDATE_TERMS in the SDK)",
    );
  });
});
