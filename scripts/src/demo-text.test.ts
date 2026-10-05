import { readFileSync } from "node:fs";
import type { OperatorReport } from "@attest8004/sdk";
import { parseEther, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  EXPLORER,
  elapsed,
  findP256Calls,
  narrateLog,
  monShort,
  plainText,
  shortKeyLine,
  txLine,
  verdictLines,
  wrap,
  type TraceFrame,
} from "./demo-text.ts";

const H = `0x${"ab".repeat(32)}` as Hex;
const T = `0x${"CD".repeat(32)}` as Hex;

describe("plainText", () => {
  it("strips escape sequences and turns newlines into spaces", () => {
    expect(plainText("a\u001b[31mred\u001b[0m\nb")).toBe("ared b");
  });
  it("removes C1 controls and bidi overrides", () => {
    expect(plainText("x\u0085y\u009bz\u202eevil\u2066q")).toBe("xyzevilq");
  });
  it("clips a long text to 600 characters, ending with …", () => {
    const out = plainText("w ".repeat(350));
    expect(Array.from(out).length).toBeLessThanOrEqual(600);
    expect(out.endsWith("…")).toBe(true);
    expect(plainText("")).toBe("");
  });
});

describe("wrap", () => {
  it("keeps every line within the width, starting with the indent, and loses no word", () => {
    const text = "The validator re-runs every onchain fact at the pinned block and records the score with the evidence hash so anyone can check it later.";
    const lines = wrap(text, 80, "    ");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(line.startsWith("    ")).toBe(true);
    }
    expect(lines.join(" ").split(/\s+/).filter(Boolean)).toEqual(text.split(" "));
  });
});

describe("links", () => {
  it("uses the same explorer as the web app", () => {
    const web = readFileSync(new URL("../../web/src/explorer.ts", import.meta.url), "utf8");
    expect(web).toContain(`export const EXPLORER = "${EXPLORER}"`);
  });
  it("links a transaction by its lower-case hash, and refuses anything that isn't one", () => {
    expect(txLine("setMandate", T)).toContain(`${EXPLORER}/tx/${T.toLowerCase()}`);
    expect(() => txLine("bad", "0x12" as Hex)).toThrow();
  });
});

function report(o: Partial<OperatorReport>): OperatorReport {
  return {
    schema: "attest8004.report.v1",
    tag: "mandate-v1",
    requestHash: H,
    agentId: "1984",
    score: 0,
    responseHash: H,
    summary: "Refused: 2 mandate rule(s) failed (score 0).",
    items: [],
    notes: [],
    ...o,
  } as OperatorReport;
}

describe("verdictLines", () => {
  it("shows a refused mandate-v1 verdict, then one line per reason with its code and sanitized text", () => {
    const lines = verdictLines({
      minScore: 100,
      report: report({
        items: [
          { code: "TARGET_NOT_ALLOWED", severity: null, text: "The target \u001b[31m0xabc\u001b[0m isn't allowed.", action: "x" },
          { code: "PERMISSION_CHANGED_AFTER_MANDATE", severity: null, text: "AgentKeySet came after the mandate.", action: "y" },
        ],
      }),
    });
    expect(lines[0]).toContain("mandate-v1");
    expect(lines[0]).toContain("0/100");
    expect(lines[0]).toContain("refused (needs 100)");
    const body = lines.slice(1).join("\n");
    expect(body).toContain("TARGET_NOT_ALLOWED");
    expect(body).toContain("The target 0xabc isn't allowed.");
    expect(body).not.toContain("\u001b");
    expect(body).toContain("PERMISSION_CHANGED_AFTER_MANDATE");
  });
  it("shows a passing risk-v1 verdict with no findings", () => {
    const lines = verdictLines({ minScore: 80, report: report({ tag: "risk-v1", score: 100, summary: "Score 100: no findings." }) });
    expect(lines[0]).toContain("risk-v1");
    expect(lines[0]).toContain("passed");
    expect(lines[1]).toContain("no findings");
  });
  it("shows a finding's severity", () => {
    const lines = verdictLines({
      minScore: 80,
      report: report({ tag: "risk-v1", score: 40, items: [{ code: "FRESH_COUNTERPARTY", severity: "medium", text: "Never sent a transaction.", action: "z" }] }),
    });
    expect(lines.join("\n")).toMatch(/medium.*FRESH_COUNTERPARTY|FRESH_COUNTERPARTY.*medium/);
  });
});

describe("findP256Calls", () => {
  const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/p6-setmandate-trace.json", import.meta.url), "utf8")) as { trace: TraceFrame };
  it("finds the setMandate's one P256VERIFY call, 6,900 gas, valid", () => {
    expect(findP256Calls(fixture.trace)).toEqual([{ gasUsed: 6_900n, valid: true, output: `0x${"00".repeat(31)}01` }]);
  });
  it("reports an empty return as invalid", () => {
    const copy = structuredClone(fixture.trace);
    const p256 = copy.calls?.find((c) => c.to === "0x0000000000000000000000000000000000000100");
    if (!p256) throw new Error("fixture has no 0x0100 frame");
    p256.output = "0x";
    expect(findP256Calls(copy)[0]?.valid).toBe(false);
  });
  it("finds nothing in a frame with no calls", () => {
    expect(findP256Calls({ type: "CALL", to: "0x0000000000000000000000000000000000000001", gasUsed: "0x5208", output: "0x" })).toEqual([]);
  });
});

describe("narrateLog", () => {
  it("says once that risk-v1 waits for mandate-v1", () => {
    const seen = new Set<string>();
    const entry = { level: "info", msg: "waiting for mandate-v1's verdict", validator: "risk-v1", requestHash: H };
    expect(narrateLog(entry, seen)).toBe("risk-v1 waits for mandate-v1's verdict on the same action");
    expect(narrateLog(entry, seen)).toBeNull();
  });
  it("keeps quiet about routine lines", () => {
    expect(narrateLog({ level: "info", msg: "caught up", validator: "mandate-v1" }, new Set())).toBeNull();
  });
  it("flags a warning with its reason", () => {
    expect(narrateLog({ level: "warn", msg: "request ignored; no response sent", validator: "risk-v1", reason: "ALREADY_RESPONDED" }, new Set())).toBe(
      "! risk-v1: request ignored; no response sent (ALREADY_RESPONDED)",
    );
  });
  it("links an operator report", () => {
    expect(narrateLog({ level: "info", msg: "operator report posted", validator: "mandate-v1", txHash: T }, new Set())).toContain(
      `${EXPLORER}/tx/${T.toLowerCase()}`,
    );
  });
  it("never prints a URL from an error", () => {
    const line = narrateLog({ level: "error", msg: "request failed; retrying next cycle", validator: "mandate-v1", error: "fetch failed at https://rpc.example/abc" }, new Set());
    expect(line).toContain("<url>");
    expect(line).not.toContain("rpc.example");
  });
});

describe("elapsed", () => {
  it("is m:ss", () => {
    expect(elapsed(65_000)).toBe("1:05");
    expect(elapsed(0)).toBe("0:00");
  });
});

describe("shortKeyLine", () => {
  it("prints the full address for the faucet, the balance and the need", () => {
    const address = "0xa43427fF51eEE66cc67C94Cb55f04C9432a96787";
    const line = shortKeyLine({ name: "hot key", address, balance: parseEther("0.0147"), need: parseEther("0.0769"), takes: 1 });
    expect(line).toContain(address);
    expect(line).toContain("https://faucet.monad.xyz");
    expect(line).toContain("pnpm demo --fund");
    expect(line).toContain("0.0147 MON");
    expect(line).toContain("0.0769 MON");
  });
});

describe("monShort", () => {
  it("rounds to 4 decimals for the screen, without trailing zeros, and never shows a balance as 0 that isn't", () => {
    expect(monShort(3_902_800_239_995_889_000n)).toBe("3.9028 MON");
    expect(monShort(parseEther("0.01"))).toBe("0.01 MON");
    expect(monShort(parseEther("0.0005"))).toBe("0.0005 MON");
    expect(monShort(parseEther("0.00004"))).toBe("<0.0001 MON");
    expect(monShort(0n)).toBe("0 MON");
  });
});
