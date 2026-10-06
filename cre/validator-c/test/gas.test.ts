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

// P12 (a P11 deferred minor): at the evidence cap the inner estimate is itself floor-bound (EIP-7623 covers the
// estimated onReport call too), so "inner + routing" exceeds the outer floor there. gas.max must still admit it.
describe("gas.max admits a report at the evidence cap (the live config)", () => {
  test("gas_maxCoversTheEvidenceCap: an all-non-zero 16,384-byte evidence document isn't GAS_OVER_CAP", async () => {
    const { encodeCanonicalJsonDataUri } = await import("../../../packages/sdk/src/canonical.ts");
    const { onReportCalldata, reportPayload, RAW_REPORT_HEADER_BYTES } = await import("../src/report.ts");
    const cfg = (await import("../config.monad-testnet.json")).default as { maxEvidenceBytes: number; gas: typeof GAS };
    const doc = { pad: "x".repeat(cfg.maxEvidenceBytes - '{"pad":""}'.length) };
    const { uri, hash } = encodeCanonicalJsonDataUri(doc);
    const payload = reportPayload({ requestHash: `0x${"ab".repeat(32)}`, score: 100, responseURI: uri, responseHash: hash });
    const calldata = onReportCalldata(`0x${"aa".repeat(64)}`, payload);
    const bytes = Buffer.from(calldata.slice(2), "hex");
    const zeros = bytes.filter((b) => b === 0).length;
    const innerFloor = 21_000n + 10n * BigInt(zeros + 4 * (bytes.length - zeros));
    const rawReportBytes = RAW_REPORT_HEADER_BYTES + (payload.length - 2) / 2;
    expect(gasLimitFor({ innerGas: innerFloor, rawReportBytes, gas: cfg.gas })).toHaveProperty("limit");
  });
});
