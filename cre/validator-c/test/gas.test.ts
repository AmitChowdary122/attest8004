import { describe, expect, test } from "bun:test";
import { gasLimitFor } from "../src/gas.ts";

// Monad prices calldata with EIP-7623's floor, which covers the whole transaction: total = max(floor, standard). The
// inner estimate (onReport as the forwarder calls it) already carries intrinsic gas and its calldata, so the write
// needs max(inner + the forwarder's routing, the floor line for the raw report's size), not their sum.
const GAS = { outerBase: 49_000, outerPerByte: 40, routing: 50_000, headroomPercent: 20, max: 1_000_000 };

describe("gasLimitFor: max(inner estimate + routing, outerBase + outerPerByte × raw bytes) × (1 + headroom), capped", () => {
  test("gas_limitFormula: execution dominates", () => {
    // max(300,000 + 50,000, 49,000 + 40 × 5,000 = 249,000) = 350,000; × 1.2 = 420,000
    expect(gasLimitFor({ innerGas: 300_000n, rawReportBytes: 5_000, gas: GAS })).toEqual({ limit: 420_000n });
  });

  test("gas_limitFormula: the calldata floor dominates", () => {
    // max(100,000 + 50,000, 249,000) = 249,000; × 1.2 = 298,800
    expect(gasLimitFor({ innerGas: 100_000n, rawReportBytes: 5_000, gas: GAS })).toEqual({ limit: 298_800n });
  });

  test("gas_limitFormula: rounded up", () => {
    // max(100,001 + 0, 0) × 1.2 = 120,001.2 → 120,002
    expect(gasLimitFor({ innerGas: 100_001n, rawReportBytes: 0, gas: { ...GAS, outerBase: 0, routing: 0 } })).toEqual({ limit: 120_002n });
  });

  test("gas_declinesOverCap: a limit above max is a decline, never a write", () => {
    expect(gasLimitFor({ innerGas: 900_000n, rawReportBytes: 5_000, gas: GAS })).toMatchObject({ decline: "GAS_OVER_CAP" });
    // max(783,333 + 50,000, …) × 1.2 = 999,999.6 → 1,000,000: exactly the cap is allowed
    expect(gasLimitFor({ innerGas: 783_333n, rawReportBytes: 0, gas: GAS })).toEqual({ limit: 1_000_000n });
  });
});
