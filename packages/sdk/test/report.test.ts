import { describe, expect, it } from "vitest";
import {
  MAX_REPORT_PLAINTEXT_BYTES,
  REPORT_SCHEMA_V1,
  ReportTooLargeError,
  decodeReport,
  encodeReport,
  fitReport,
  operatorReportSchema,
  type OperatorReport,
} from "../src/index.ts";

const HASH = `0x${"ab".repeat(32)}` as const;
const EVIDENCE = `0x${"cd".repeat(32)}` as const;

function report(over: Partial<OperatorReport> = {}): OperatorReport {
  return {
    schema: REPORT_SCHEMA_V1,
    tag: "mandate-v1",
    requestHash: HASH,
    agentId: "1984",
    score: 0,
    responseHash: EVIDENCE,
    summary: "Refused: 2 mandate rule(s) failed (score 0).",
    items: [{ code: "TARGET_NOT_ALLOWED", severity: null, text: "The action sends to 0x1, which the mandate doesn't allow.", action: "Don't execute it." }],
    notes: ["Daily spend: 0 MON already counted against the 0.005 MON cap."],
    ...over,
  };
}

const item = (text: string) => ({ code: "OTHER", severity: "high" as const, text, action: "Read it." });

describe("operatorReportSchema", () => {
  it("rejects an unknown key, a bad tag, a 13th item, a 601-char text", () => {
    expect(operatorReportSchema.safeParse(report()).success).toBe(true);
    expect(operatorReportSchema.safeParse({ ...report(), extra: 1 }).success).toBe(false);
    expect(operatorReportSchema.safeParse(report({ tag: "Mandate V1" })).success).toBe(false);
    expect(operatorReportSchema.safeParse(report({ items: Array.from({ length: 13 }, () => item("x")) })).success).toBe(false);
    expect(operatorReportSchema.safeParse(report({ items: [item("x".repeat(601))] })).success).toBe(false);
    expect(operatorReportSchema.safeParse(report({ items: [item("x".repeat(600))] })).success).toBe(true);
    expect(operatorReportSchema.safeParse(report({ score: 101 })).success).toBe(false);
    expect(operatorReportSchema.safeParse(report({ notes: ["a", "b", "c", "d", "e"] })).success).toBe(false);
  });
});

describe("encodeReport", () => {
  it("encodes canonical JSON (sorted keys, no whitespace)", () => {
    const text = new TextDecoder().decode(encodeReport(report()));
    expect(text.startsWith('{"agentId":"1984","items":[{"action":')).toBe(true);
    expect(text).not.toMatch(/\s"|":\s/);
    expect(JSON.parse(text)).toEqual(report());
  });

  it("throws ReportTooLargeError above 8,131 bytes", () => {
    const big = report({ items: Array.from({ length: 12 }, () => item("x".repeat(600))), notes: ["y".repeat(400)] });
    expect(() => encodeReport(big)).toThrow(ReportTooLargeError);
    try {
      encodeReport(big);
    } catch (error) {
      expect((error as ReportTooLargeError).bytes).toBeGreaterThan(MAX_REPORT_PLAINTEXT_BYTES);
    }
  });
});

describe("fitReport", () => {
  it("clips texts to 200 chars + … and the result encodes", () => {
    const big = report({ items: Array.from({ length: 12 }, () => item("x".repeat(600))) });
    const fitted = fitReport(big);
    for (const it of fitted.items) expect(it.text).toBe(`${"x".repeat(200)}…`);
    expect(encodeReport(fitted).length).toBeLessThanOrEqual(MAX_REPORT_PLAINTEXT_BYTES);
  });

  it("leaves a report that already fits unchanged", () => {
    expect(fitReport(report())).toEqual(report());
  });

  it("never splits a surrogate pair when clipping", () => {
    const big = report({ items: Array.from({ length: 8 }, () => item("😀".repeat(300))) });
    const fitted = fitReport(big);
    for (const it of fitted.items) expect(it.text).toBe(`${"😀".repeat(200)}…`);
  });

  it("fitReport throws when clipping isn't enough", () => {
    const actions = Array.from({ length: 12 }, () => ({ code: "OTHER", severity: null, text: "x", action: "\u0001".repeat(300) }));
    expect(() => fitReport(report({ items: actions, notes: ["\u0001".repeat(400)] }))).toThrow(ReportTooLargeError);
  });
});

describe("decodeReport", () => {
  it("decodeReport: invalid UTF-8 → NOT_UTF8, \"{\" → NOT_JSON, wrong schema → SCHEMA, round trip", () => {
    expect(decodeReport(new Uint8Array([0xff, 0xfe]))).toEqual({ ok: false, problem: "NOT_UTF8" });
    expect(decodeReport(new TextEncoder().encode("{"))).toEqual({ ok: false, problem: "NOT_JSON" });
    expect(decodeReport(new TextEncoder().encode('{"schema":"attest8004.report.v1"}'))).toEqual({ ok: false, problem: "SCHEMA" });
    expect(decodeReport(new TextEncoder().encode('{"__proto__":{"x":1}}'))).toEqual({ ok: false, problem: "SCHEMA" });
    expect(decodeReport(encodeReport(report()))).toEqual({ ok: true, report: report() });
  });
});
