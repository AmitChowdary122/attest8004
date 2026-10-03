import { describe, expect, it } from "vitest";
import { readEnvValue, upsertEnv } from "./env-file.ts";

describe("upsertEnv", () => {
  it("fills an empty NAME= line in place", () => {
    expect(upsertEnv("A=1\nB=\nC=3\n", { B: "x" })).toBe("A=1\nB=x\nC=3\n");
  });

  it('treats NAME="" as empty', () => {
    expect(upsertEnv('B=""\n', { B: "x" })).toBe("B=x\n");
  });

  it("appends missing names, keeping a trailing newline", () => {
    expect(upsertEnv("A=1\n", { B: "x", C: "y" })).toBe("A=1\nB=x\nC=y\n");
    expect(upsertEnv("A=1", { B: "x" })).toBe("A=1\nB=x\n");
  });

  it("never overwrites a value, and never repeats it in the error", () => {
    const attempt = () => upsertEnv("DEMO_KEY=0xabc123\n", { DEMO_KEY: "0xdef" });
    expect(attempt).toThrow(/DEMO_KEY already has a value/);
    expect(attempt).not.toThrow(/abc123/);
  });

  it("leaves comments, blank lines and other names byte-identical", () => {
    const text = "# keys\nA=1\n\n  # indented comment\nB=\nAB=\n";
    expect(upsertEnv(text, { B: "x" })).toBe("# keys\nA=1\n\n  # indented comment\nB=x\nAB=\n");
  });

  it("matches the whole name, not a prefix", () => {
    expect(upsertEnv("AB=\n", { A: "x" })).toBe("AB=\nA=x\n");
  });
});

describe("readEnvValue", () => {
  it("returns the value, or undefined when the name is missing or empty", () => {
    const text = "A=1\nB=\nC=\"q\"\n# D=4\n";
    expect(readEnvValue(text, "A")).toBe("1");
    expect(readEnvValue(text, "B")).toBeUndefined();
    expect(readEnvValue(text, "C")).toBe("q");
    expect(readEnvValue(text, "D")).toBeUndefined();
    expect(readEnvValue(text, "E")).toBeUndefined();
  });
});
