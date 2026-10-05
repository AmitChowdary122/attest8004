import { describe, expect, it } from "vitest";
import { fitOuterGas } from "./cre-demo-plan.ts";

describe("fitOuterGas: the forwarder's own gas as outerBase + outerPerByte × raw report bytes", () => {
  it("recovers an exact line, rounding the base up to the next 1,000", () => {
    const samples = [
      { rawReportBytes: 1_000, gas: 66_000n },
      { rawReportBytes: 5_000, gas: 130_000n },
      { rawReportBytes: 10_000, gas: 210_000n },
    ];
    expect(fitOuterGas(samples)).toEqual({ outerBase: 50_000, outerPerByte: 16 });
  });

  it("fitOuterGas_rounds_up_and_covers_every_sample", () => {
    const samples = [
      { rawReportBytes: 1_500, gas: 71_234n },
      { rawReportBytes: 5_600, gas: 140_111n },
      { rawReportBytes: 11_000, gas: 225_999n },
      { rawReportBytes: 22_000, gas: 404_321n },
    ];
    const { outerBase, outerPerByte } = fitOuterGas(samples);
    expect(Number.isInteger(outerPerByte)).toBe(true);
    expect(outerBase % 1_000).toBe(0);
    for (const s of samples) expect(BigInt(outerBase + outerPerByte * s.rawReportBytes)).toBeGreaterThanOrEqual(s.gas);
  });

  it("needs two sizes at least", () => {
    expect(() => fitOuterGas([{ rawReportBytes: 1_000, gas: 1n }])).toThrow();
  });
});
