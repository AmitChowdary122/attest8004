// P12: no source or doc in the repository may carry a literal bidi control or zero-width character (Trojan Source;
// GitHub's "hidden or bidirectional Unicode" warning). Every character below is written as a \u escape.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findHiddenUnicode, HIDDEN_RANGES, isBinary, scanRepository } from "./hidden-unicode.ts";

const ROOT = resolve(import.meta.dirname, "../..");

describe("findHiddenUnicode", () => {
  it("flags each bidi control and zero-width character at both ends of every range", () => {
    for (const [first, last] of HIDDEN_RANGES) {
      for (const cp of [first, last]) {
        expect(findHiddenUnicode(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toEqual([{ line: 1, column: 2, codePoint: cp }]);
      }
    }
  });

  it("reports the line and column on later lines", () => {
    expect(findHiddenUnicode("one\ntwo \u202Ethree\n")).toEqual([{ line: 2, column: 5, codePoint: 0x202e }]);
  });

  it("flags a leading BOM", () => {
    expect(findHiddenUnicode("\uFEFFx")).toEqual([{ line: 1, column: 1, codePoint: 0xfeff }]);
  });

  it("ignores ordinary text, a visible narrow space (U+202F) and other Unicode", () => {
    expect(findHiddenUnicode("plain — 0.002\u202FMON, ünïcödé, 日本, emoji \u{1F600}")).toEqual([]);
  });
});

describe("isBinary", () => {
  it("treats bytes with a NUL in the first 8,000 as binary", () => {
    expect(isBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe(true);
    expect(isBinary(new TextEncoder().encode("text \u202E"))).toBe(false);
  });
});

describe("the repository", () => {
  it("has no hidden Unicode in any tracked text file", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
    expect(scanRepository(ROOT, files)).toEqual([]);
  });
});
