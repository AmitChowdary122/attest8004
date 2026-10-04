import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The page where the passkey signs must not be framable (clickjacking) and must load no third-party code
// (amendment 1 to the P6 plan). vercel.json is the production source of these headers; vite preview reuses it.
interface VercelConfig {
  headers: { source: string; headers: { key: string; value: string }[] }[];
}

const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as VercelConfig;
const block = vercel.headers.find((h) => h.source === "/(.*)");
const header = (key: string) => block?.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...sources]) => [name as string, sources]),
  );
}

describe("security headers (web/vercel.json)", () => {
  it("apply to every route", () => {
    expect(block).toBeDefined();
  });

  it("CSP: self only, the testnet RPC for connections, never framed, no plugins, no base", () => {
    const csp = directives(header("Content-Security-Policy") ?? "");
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("connect-src")).toEqual(["'self'", "https://testnet-rpc.monad.xyz"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
    // default-src doesn't cover form submissions.
    expect(csp.get("form-action")).toEqual(["'none'"]);
  });

  it("CSP names no source other than 'self', 'none' and the testnet RPC", () => {
    const allowed = new Set(["'self'", "'none'", "https://testnet-rpc.monad.xyz"]);
    for (const [name, sources] of directives(header("Content-Security-Policy") ?? "")) {
      for (const source of sources) expect(allowed.has(source), `${name} ${source}`).toBe(true);
    }
  });

  it("X-Frame-Options DENY, Referrer-Policy no-referrer, nosniff and a same-origin opener policy", () => {
    expect(header("X-Frame-Options")).toBe("DENY");
    expect(header("Referrer-Policy")).toBe("no-referrer");
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });
});
