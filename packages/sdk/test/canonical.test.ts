import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { canonicalJson, decodeJsonDataUri, encodeCanonicalJsonDataUri } from "../src/index.ts";

describe("canonicalJson", () => {
  it("sorts object keys by UTF-16 code unit and writes no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: "x" } })).toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
  });

  it("writes a bigint as a decimal string", () => {
    expect(canonicalJson({ v: 2n ** 70n })).toBe('{"v":"1180591620717411303424"}');
  });

  it("round-trips plain values", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson("hé")).toBe('"hé"');
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({})).toBe("{}");
  });

  it("keeps array element order (only object keys are sorted)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  describe("throws", () => {
    it("on a fractional number", () => expect(() => canonicalJson(1.5)).toThrow());
    it("on a number above Number.MAX_SAFE_INTEGER", () => expect(() => canonicalJson(2 ** 53)).toThrow());
    it("on NaN", () => expect(() => canonicalJson(Number.NaN)).toThrow());
    it("on Infinity", () => expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow());
    it("on an object with an undefined value", () => expect(() => canonicalJson({ x: undefined })).toThrow());
    it("on top-level undefined", () => expect(() => canonicalJson(undefined)).toThrow());
    it("on a function", () => expect(() => canonicalJson(() => {})).toThrow());
    it("on a symbol", () => expect(() => canonicalJson(Symbol("x"))).toThrow());
    it("on a non-plain object (Date)", () => expect(() => canonicalJson(new Date())).toThrow());
    it("on a non-plain object (Map)", () => expect(() => canonicalJson(new Map())).toThrow());
  });
});

describe("encodeCanonicalJsonDataUri", () => {
  it("is the same URI form as encodeJsonDataUri, over canonical bytes", () => {
    const { uri, hash } = encodeCanonicalJsonDataUri({ b: 1, a: 2 });
    const bytes = stringToBytes('{"a":2,"b":1}');
    expect(uri).toBe(`data:application/json;base64,${Buffer.from(bytes).toString("base64")}`);
    expect(hash).toBe(keccak256(bytes));
  });

  it("gives the same hash for the same document built in two key orders", () => {
    const a = encodeCanonicalJsonDataUri({ b: 1, a: { d: [2, 1], c: "x" } });
    const b = encodeCanonicalJsonDataUri({ a: { c: "x", d: [2, 1] }, b: 1 });
    expect(a).toEqual(b);
  });

  it("a non-ASCII string round-trips through decodeJsonDataUri", () => {
    const doc = { name: "héllo 世界" };
    const { uri } = encodeCanonicalJsonDataUri(doc);
    expect(decodeJsonDataUri(uri)).toEqual({ ok: true, text: canonicalJson(doc) });
  });
});
