import { MANDATE_V1, type SpendEntry } from "@attest8004/validator-mandate";
import { getAddress, keccak256, parseEther, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { dailyCapShortfall, expectedReasonsB } from "./e2e-cap.ts";

const CAP = parseEther("0.005");
const A = parseEther("0.001");
const B = parseEther("0.003");
const GATE = getAddress("0x23bfbd12545ccd1501dda1b65a54518fd6212a96");

function entry(n: number, approvedAt: bigint, counted = true): SpendEntry {
  return {
    requestHash: keccak256(toHex(`approval ${n}`)),
    approvedAt,
    gate: GATE,
    value: A,
    deadline: approvedAt + 600n,
    consumed: counted,
    counted,
  };
}

describe("expectedReasonsB", () => {
  it.each([
    { runs: 1, spend: "0.001", reasons: ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"] },
    { runs: 2, spend: "0.002", reasons: ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"] },
    { runs: 3, spend: "0.003", reasons: ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP", "DAILY_CAP_EXCEEDED"] },
    { runs: 5, spend: "0.005", reasons: ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP", "DAILY_CAP_EXCEEDED"] },
  ])("run $runs in 25 h (B's spend $spend MON): $reasons", ({ spend, reasons }) => {
    expect(expectedReasonsB({ spendTotal: parseEther(spend), value: B, maxValuePerDay: CAP })).toEqual(reasons);
  });

  it("adds DAILY_CAP_EXCEEDED only past the cap, never at it (mandate-v1 fails spend + value > cap)", () => {
    expect(expectedReasonsB({ spendTotal: CAP - B, value: B, maxValuePerDay: CAP })).not.toContain("DAILY_CAP_EXCEEDED");
    expect(expectedReasonsB({ spendTotal: CAP - B + 1n, value: B, maxValuePerDay: CAP })).toContain("DAILY_CAP_EXCEEDED");
  });
});

describe("dailyCapShortfall", () => {
  it("is null while A still fits, up to exactly the cap", () => {
    const entries = [1, 2, 3, 4].map((n) => entry(n, 1_790_000_000n + BigInt(n)));
    expect(dailyCapShortfall({ spend: { total: 4n * A, entries }, value: A, maxValuePerDay: CAP })).toBeNull();
    expect(dailyCapShortfall({ spend: { total: 0n, entries: [] }, value: A, maxValuePerDay: CAP })).toBeNull();
  });

  it("names the cap and when the oldest counted approval leaves the 25 h window, and how to raise the cap", () => {
    const oldest = 1_790_000_000n;
    const entries = [entry(1, oldest + 50n), entry(2, oldest - 10n, false), entry(3, oldest), entry(4, oldest + 70n), entry(5, oldest + 90n)];
    const message = dailyCapShortfall({ spend: { total: 5n * A, entries }, value: A, maxValuePerDay: CAP });
    const leaves = new Date(Number(oldest + MANDATE_V1.spendWindowSeconds) * 1000).toISOString();
    expect(message).toBe(
      `A (0.001 MON) would exceed the daily cap (0.005 MON of 0.005 MON already counted); the oldest counted approval ` +
        `leaves the 25 h window at ${leaves}, or raise the mandate's cap with set-mandate (and E2E_MANDATE in e2e.ts)`,
    );
  });
});
