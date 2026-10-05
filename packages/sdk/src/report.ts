// `attest8004.report.v1` (SPEC §4.7, ARCHITECTURE §6): the operator report a validator encrypts to an agent's inbox
// key after its verdict lands. Plain words for the operator, built from the validator's own public evidence; the
// verdict data itself stays public at `responseURI`. Browser-safe: zod and the SDK's canonical JSON only.
import { z } from "zod";
import { canonicalJson } from "./canonical.ts";
import { MAX_REPORT_PLAINTEXT_BYTES } from "./inbox-crypto.ts";
import { zBytes32, zDecimal } from "./request.ts";

export const REPORT_SCHEMA_V1 = "attest8004.report.v1";

const UINT256_MAX = 2n ** 256n - 1n;
/** What `fitReport` clips an item's text to, in characters (code points), before giving up. */
const FIT_TEXT_CHARS = 200;

const reportItem = z.strictObject({
  code: z.string().regex(/^[A-Z0-9_]{1,64}$/, "must be an upper-case code"),
  severity: z.enum(["low", "medium", "high"]).nullable(),
  text: z.string().max(600),
  action: z.string().max(300),
});

/**
 * The report's strict schema: unknown keys are rejected anywhere. `responseHash` is the public evidence's hash, so
 * a reader can tell whether the report belongs to the verdict that is onchain now.
 */
export const operatorReportSchema = z.strictObject({
  schema: z.literal(REPORT_SCHEMA_V1),
  tag: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,31}$/, "must be a validator tag such as mandate-v1"),
  requestHash: zBytes32,
  agentId: zDecimal(UINT256_MAX),
  score: z.number().int().min(0).max(100),
  responseHash: zBytes32,
  summary: z.string().max(400),
  items: z.array(reportItem).max(12),
  notes: z.array(z.string().max(400)).max(4),
});
export type OperatorReport = z.output<typeof operatorReportSchema>;

/** The report's canonical JSON is longer than an envelope can carry. */
export class ReportTooLargeError extends Error {
  readonly bytes: number;

  constructor(bytes: number) {
    super(`the report is ${bytes} bytes; an envelope carries at most ${MAX_REPORT_PLAINTEXT_BYTES}`);
    this.name = "ReportTooLargeError";
    this.bytes = bytes;
  }
}

/** The report as canonical JSON in UTF-8, after a strict parse. Throws `ReportTooLargeError` above 8,131 bytes. */
export function encodeReport(report: OperatorReport): Uint8Array {
  const bytes = new TextEncoder().encode(canonicalJson(operatorReportSchema.parse(report)));
  if (bytes.length > MAX_REPORT_PLAINTEXT_BYTES) throw new ReportTooLargeError(bytes.length);
  return bytes;
}

/**
 * `report` unchanged when it encodes; otherwise every item's text clipped to 200 characters plus `…` (never splitting
 * a character). Throws `ReportTooLargeError` when even that doesn't fit, so the caller posts nothing.
 */
export function fitReport(report: OperatorReport): OperatorReport {
  try {
    encodeReport(report);
    return report;
  } catch (error) {
    if (!(error instanceof ReportTooLargeError)) throw error;
  }
  const clipped: OperatorReport = {
    ...report,
    items: report.items.map((item) => {
      const chars = Array.from(item.text);
      return chars.length > FIT_TEXT_CHARS ? { ...item, text: `${chars.slice(0, FIT_TEXT_CHARS).join("")}…` } : item;
    }),
  };
  encodeReport(clipped);
  return clipped;
}

/** A decrypted plaintext back to a report: strict UTF-8, JSON, then the strict schema. Never throws. */
export function decodeReport(bytes: Uint8Array): { ok: true; report: OperatorReport } | { ok: false; problem: "NOT_UTF8" | "NOT_JSON" | "SCHEMA" } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, problem: "NOT_UTF8" };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: "NOT_JSON" };
  }
  const parsed = operatorReportSchema.safeParse(json);
  return parsed.success ? { ok: true, report: parsed.data } : { ok: false, problem: "SCHEMA" };
}
