import { describe, expect, test } from "bun:test";
import { gasLimitFor } from "../src/gas.ts";

const GAS = { outerBase: 40_000, outerPerByte: 20, headroomPercent: 20, max: 1_000_000 };

describe("gasLimitFor: (inner estimate + outer base + per byte × raw report bytes) × (1 + headroom), capped", () => {
  test("gas_limitFormula: exact, rounded up", () => {
    // (300,000 + 40,000 + 20 × 5,000) × 1.2 = 528,000
    expect(gasLimitFor({ innerGas: 300_000n, rawReportBytes: 5_000, gas: GAS })).toEqual({ limit: 528_000n });
    // (100,001 + 40,000 + 0) × 1.2 = 168,001.2 → 168,002
    expect(gasLimitFor({ innerGas: 100_001n, rawReportBytes: 0, gas: GAS })).toEqual({ limit: 168_002n });
  });

  test("gas_declinesOverCap: a limit above max is a decline, never a write", () => {
    expect(gasLimitFor({ innerGas: 900_000n, rawReportBytes: 5_000, gas: GAS })).toMatchObject({ decline: "GAS_OVER_CAP" });
    expect(gasLimitFor({ innerGas: 793_333n, rawReportBytes: 0, gas: { ...GAS, outerBase: 0, max: 952_000 } })).toEqual({ limit: 952_000n });
  });
});
