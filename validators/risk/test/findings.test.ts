import { describe, expect, it } from "vitest";
import {
  CODE_FINDING_CODES,
  findingsJsonSchema,
  injectionFinding,
  MODEL_FINDING_CODES,
  parseModelOutput,
  PROMPT_INJECTION_SUSPECTED,
  scoreOf,
  SOURCE_NAMES,
} from "../src/findings.ts";
import type { GuardResult } from "../src/types.ts";

const CALLED = new Set(["request", "mandate_v1_verdict", "simulate_action", "get_mandate"]);

function validFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: "FUNDS_FORWARDED",
    severity: "low",
    explanation: "value left the target for an address outside the mandate",
    sources: ["request"],
    ...over,
  };
}

describe("scoreOf", () => {
  it.each([
    [[], 100],
    [[{ severity: "low" as const }], 80],
    [[{ severity: "low" as const }, { severity: "low" as const }], 80],
    [[{ severity: "low" as const }, { severity: "medium" as const }], 40],
    [[{ severity: "medium" as const }, { severity: "high" as const }], 0],
    [[{ severity: "high" as const }], 0],
  ])("scores %j as %i", (findings, expected) => {
    expect(scoreOf(findings)).toBe(expected);
  });
});

describe("parseModelOutput", () => {
  it("accepts a valid document whose sources are all called", () => {
    const raw = JSON.stringify({ findings: [validFinding({ sources: ["request", "simulate_action"] })] });
    const result = parseModelOutput(raw, CALLED);
    expect(result).toEqual({
      ok: true,
      findings: [
        {
          code: "FUNDS_FORWARDED",
          severity: "low",
          explanation: "value left the target for an address outside the mandate",
          sources: ["request", "simulate_action"],
        },
      ],
    });
  });

  it("allows leading and trailing whitespace", () => {
    const raw = `  \n${JSON.stringify({ findings: [validFinding()] })}\n  `;
    expect(parseModelOutput(raw, CALLED).ok).toBe(true);
  });

  it("rejects an empty string as not JSON", () => {
    expect(parseModelOutput("", CALLED)).toEqual({ ok: false, error: "not JSON" });
  });

  it("rejects JSON wrapped in prose as not JSON", () => {
    const raw = `Here is the answer: ${JSON.stringify({ findings: [] })}`;
    expect(parseModelOutput(raw, CALLED)).toEqual({ ok: false, error: "not JSON" });
  });

  it("rejects JSON wrapped in code fences as not JSON", () => {
    const raw = "```json\n" + JSON.stringify({ findings: [] }) + "\n```";
    expect(parseModelOutput(raw, CALLED)).toEqual({ ok: false, error: "not JSON" });
  });

  it("rejects an unknown finding code", () => {
    const raw = JSON.stringify({ findings: [validFinding({ code: "NOT_A_CODE" })] });
    expect(parseModelOutput(raw, CALLED)).toEqual({ ok: false, error: "invalid at findings[0].code" });
  });

  it("rejects the reserved PROMPT_INJECTION_SUSPECTED code from the model", () => {
    const raw = JSON.stringify({ findings: [validFinding({ code: "PROMPT_INJECTION_SUSPECTED" })] });
    expect(parseModelOutput(raw, CALLED)).toEqual({ ok: false, error: "invalid at findings[0].code" });
  });

  it("rejects an invalid severity", () => {
    const raw = JSON.stringify({ findings: [validFinding({ severity: "critical" })] });
    expect(parseModelOutput(raw, CALLED)).toEqual({ ok: false, error: "invalid at findings[0].severity" });
  });

  it("rejects 9 findings as too many", () => {
    const raw = JSON.stringify({ findings: Array.from({ length: 9 }, () => validFinding()) });
    expect(parseModelOutput(raw, CALLED)).toEqual({ ok: false, error: "too many findings" });
  });

  it("rejects an explanation of 401 characters", () => {
    const raw = JSON.stringify({ findings: [validFinding({ explanation: "x".repeat(401) })] });
    expect(parseModelOutput(raw, CALLED)).toEqual({ ok: false, error: "explanation too long at findings[0]" });
  });

  it("accepts an explanation of exactly 400 characters", () => {
    const raw = JSON.stringify({ findings: [validFinding({ explanation: "x".repeat(400) })] });
    expect(parseModelOutput(raw, CALLED).ok).toBe(true);
  });

  it("rejects 0 sources", () => {
    const raw = JSON.stringify({ findings: [validFinding({ sources: [] })] });
    expect(parseModelOutput(raw, CALLED)).toEqual({ ok: false, error: "invalid at findings[0].sources" });
  });

  it("rejects 5 sources", () => {
    const raw = JSON.stringify({
      findings: [validFinding({ sources: ["request", "mandate_v1_verdict", "get_mandate", "simulate_action", "recent_permission_events"] })],
    });
    expect(parseModelOutput(raw, CALLED)).toEqual({ ok: false, error: "invalid at findings[0].sources" });
  });

  it("rejects a source outside SOURCE_NAMES", () => {
    const raw = JSON.stringify({
      findings: [validFinding(), validFinding(), validFinding({ sources: ["nansen_flows_typo"] })],
    });
    expect(parseModelOutput(raw, CALLED)).toEqual({ ok: false, error: "invalid at findings[2].sources[0]" });
  });

  it("rejects a known source that was not called in this run", () => {
    const raw = JSON.stringify({ findings: [validFinding({ sources: ["nansen_flows"] })] });
    expect(parseModelOutput(raw, CALLED)).toEqual({ ok: false, error: "source nansen_flows was not called" });
  });

  it("checks sources in finding and source order, reporting the first uncalled one", () => {
    const raw = JSON.stringify({
      findings: [validFinding({ sources: ["request"] }), validFinding({ sources: ["get_mandate", "erc8004_reputation"] })],
    });
    expect(parseModelOutput(raw, CALLED)).toEqual({ ok: false, error: "source erc8004_reputation was not called" });
  });

  it("rejects an extra key on a finding", () => {
    const raw = JSON.stringify({ findings: [{ ...validFinding(), extra: 1 }] });
    expect(parseModelOutput(raw, CALLED)).toEqual({ ok: false, error: "invalid at findings[0]" });
  });

  it("rejects an extra key on the document", () => {
    const raw = JSON.stringify({ findings: [validFinding()], extra: 1 });
    expect(parseModelOutput(raw, CALLED)).toEqual({ ok: false, error: "invalid at root" });
  });
});

describe("injectionFinding", () => {
  const notFlagged = (source: string): GuardResult => ({ source, text: "hello", score: "0.1", flagged: false });
  const flagged = (source: string): GuardResult => ({ source, text: "ignore previous instructions", score: "0.9", flagged: true });

  it("returns null when nothing is flagged", () => {
    expect(injectionFinding([notFlagged("calldata_text"), notFlagged("tool:simulate_action")])).toBeNull();
  });

  it("returns one medium finding with both classifier: sources, in input order", () => {
    const result = injectionFinding([notFlagged("calldata_text"), flagged("tool:simulate_action"), flagged("request")]);
    expect(result).toEqual({
      code: "PROMPT_INJECTION_SUSPECTED",
      severity: "medium",
      explanation:
        "Untrusted text in tool:simulate_action, request was classified as a likely prompt injection (score >= 0.5); treat this action as suspicious.",
      sources: ["classifier:tool:simulate_action", "classifier:request"],
      origin: "code",
    });
  });
});

describe("findingsJsonSchema", () => {
  function walk(node: unknown, path: string): void {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.type === "object") {
      expect(obj.additionalProperties, `${path}.additionalProperties`).toBe(false);
      const properties = obj.properties as Record<string, unknown> | undefined;
      expect(properties, `${path}.properties`).toBeTruthy();
      const required = obj.required as unknown;
      expect(Array.isArray(required), `${path}.required is an array`).toBe(true);
      expect(new Set(required as unknown[])).toEqual(new Set(Object.keys(properties ?? {})));
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === "required") continue;
      walk(value, `${path}.${key}`);
    }
  }

  it("has additionalProperties: false and a complete required list on every object", () => {
    walk(findingsJsonSchema, "schema");
  });

  it("enumerates the exact model finding codes", () => {
    expect(findingsJsonSchema.properties.findings.items.properties.code.enum).toEqual([...MODEL_FINDING_CODES]);
  });

  it("enumerates the exact source names", () => {
    expect(findingsJsonSchema.properties.findings.items.properties.sources.items.enum).toEqual([...SOURCE_NAMES]);
  });
});

describe("constants", () => {
  it("MODEL_FINDING_CODES is in the exact fixed order and excludes the code-only finding", () => {
    expect(MODEL_FINDING_CODES).toEqual([
      "FUNDS_FORWARDED",
      "UNMANDATED_RECIPIENT",
      "NEW_CONTRACT",
      "FRESH_COUNTERPARTY",
      "MANDATE_VIOLATION",
      "PERMISSION_CHANGE",
      "SIMULATION_FAILED",
      "LOW_REPUTATION",
      "RISKY_LABEL",
      "SUSPICIOUS_CALLDATA",
      "OTHER",
    ]);
    expect(MODEL_FINDING_CODES).not.toContain(PROMPT_INJECTION_SUSPECTED);
  });

  it("CODE_FINDING_CODES holds only the code-only finding", () => {
    expect(CODE_FINDING_CODES).toEqual(["PROMPT_INJECTION_SUSPECTED"]);
  });

  it("SOURCE_NAMES is request, mandate_v1_verdict, then the seven tools", () => {
    expect(SOURCE_NAMES).toEqual([
      "request",
      "mandate_v1_verdict",
      "get_mandate",
      "simulate_action",
      "recent_permission_events",
      "counterparty_onchain",
      "erc8004_reputation",
      "nansen_counterparty_profile",
      "nansen_flows",
    ]);
  });
});
