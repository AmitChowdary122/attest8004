import { describe, expect, test } from "bun:test";
import { installBase64Polyfill } from "../src/polyfills.ts";

// CRE's QuickJS runtime declares atob/btoa in its types but doesn't provide them (P11 spike), and the repo SDK's
// data: URI codec calls them. Bun has the native ones, which these tests use as the oracle.
const nativeAtob = globalThis.atob;
const nativeBtoa = globalThis.btoa;
const runtime: { atob?: (s: string) => string; btoa?: (s: string) => string } = {};
const installed = installBase64Polyfill(runtime);
const atob = runtime.atob as (s: string) => string;
const btoa = runtime.btoa as (s: string) => string;

/** The base64 payload of agent 1984's real request URI (tx 0x428a7fd2…4d297ed, block 68,438,285). */
const REAL_REQUEST_PAYLOAD =
  "eyJzY2hlbWEiOiJhdHRlc3Q4MDA0LnJlcXVlc3QudjEiLCJjaGFpbklkIjoxMDE0MywiZ2F0ZSI6IjB4MTJmQWIzRTNjQTgxMENjNDRiRDlmNTM3NjEzYTIzMGEyYmU4RDYxNCIsInZhbGlkYXRvciI6IjB4YTYyRGFCMjFFMEMwRjU3ZTk0QjNlZDZlNjc1RjIxNDE5OTk4OWU5MiIsImFnZW50SWQiOiIxOTg0IiwiYWN0aW9uIjp7InRhcmdldCI6IjB4M0VGRUIzQ2YyRkI1NEE3RDk5YWJFOTBBYUI3ODZjRTVBODMxYThDRiIsInZhbHVlIjoiNTAwMDAwMDAwMDAwMDAwIiwiZGF0YSI6IjB4IiwiZGVhZGxpbmUiOiIxNzkxMjE2MjQzIiwic2FsdCI6IjB4NTI2MmM2MjI3Y2RkNTNmZGIxYmY5MTNkZjIzNWYzZDlkZTQyMjA0Y2I5MTg5YzIwZDFlNzQ0NGFlZjMxNzY3MCJ9fQ==";

const allBytes = String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i));

describe("installBase64Polyfill on a runtime without atob/btoa", () => {
  test("installs both", () => {
    expect(installed).toEqual(["atob", "btoa"]);
  });

  test("btoa matches the native one on short inputs and every byte value", () => {
    for (const s of ["", "f", "fo", "foo", "foob", "fooba", "foobar", allBytes]) expect(btoa(s)).toBe(nativeBtoa(s));
  });

  test("atob matches the native one, including the real request URI's payload", () => {
    for (const s of ["", "Zg==", "Zm8=", "Zm9v", "Zm9vYg==", nativeBtoa(allBytes), REAL_REQUEST_PAYLOAD]) {
      expect(atob(s)).toBe(nativeAtob(s));
    }
    expect(atob(REAL_REQUEST_PAYLOAD)).toStartWith('{"schema":"attest8004.request.v1"');
  });

  test("atob(btoa(x)) round-trips every byte value", () => {
    expect(atob(btoa(allBytes))).toBe(allBytes);
  });

  test("atob throws on characters outside base64, a stray '=' and an impossible length", () => {
    expect(() => atob("@@@@")).toThrow();
    expect(() => atob("Zg=a")).toThrow();
    expect(() => atob("Zm9vY")).toThrow(); // length % 4 === 1 can't come from any byte string
  });

  test("btoa throws above U+00FF, like the native one", () => {
    expect(() => btoa("Ā")).toThrow();
    expect(() => nativeBtoa("Ā")).toThrow();
  });
});

describe("installBase64Polyfill on a runtime that has them", () => {
  test("leaves the existing functions untouched", () => {
    const own = { atob: (s: string) => `a:${s}`, btoa: (s: string) => `b:${s}` };
    const before = { ...own };
    expect(installBase64Polyfill(own)).toEqual([]);
    expect(own.atob).toBe(before.atob);
    expect(own.btoa).toBe(before.btoa);
  });
});
