import { readFileSync } from "node:fs";
import { DEPLOYMENTS, type Deployment } from "@attest8004/sdk/browser";
import { describe, expect, it } from "vitest";

// The page where the passkey signs must not be framable (clickjacking) and must load no third-party code
// (amendment 1 to the P6 plan). vercel.json is the production source of these headers; vite preview reuses it.
interface VercelConfig {
  headers: { source: string; headers: { key: string; value: string }[] }[];
}

const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as VercelConfig;
const block = vercel.headers.find((h) => h.source === "/(.*)");
// The pages connect to the testnet RPC and, once recorded, exactly the hosted indexer's GraphQL URL (P8): the one
// source is DEPLOYMENTS, so vercel.json can't drift from it.
const trustApi = (DEPLOYMENTS[10143] as Deployment).trustApi;
const CONNECT = ["'self'", "https://testnet-rpc.monad.xyz", ...(trustApi ? [trustApi.graphqlUrl] : [])];
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

  it("CSP: self only, the testnet RPC and the recorded indexer for connections, never framed, no plugins, no base", () => {
    const csp = directives(header("Content-Security-Policy") ?? "");
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("connect-src")).toEqual(CONNECT);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
    // default-src doesn't cover form submissions.
    expect(csp.get("form-action")).toEqual(["'none'"]);
  });

  it("CSP names no source other than 'self', 'none', the testnet RPC and the recorded indexer", () => {
    const allowed = new Set(["'none'", ...CONNECT]);
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

describe("Permissions-Policy (P12 AUD-12)", () => {
  const policy = new Map(
    (header("Permissions-Policy") ?? "")
      .split(",")
      .map((d) => d.trim().split("="))
      .filter((parts) => parts[0])
      .map(([name, allow]) => [name as string, allow ?? ""]),
  );

  it("keeps passkeys and clipboard writes to this origin, the only powerful features the pages use", () => {
    expect(policy.get("publickey-credentials-get")).toBe("(self)");
    expect(policy.get("publickey-credentials-create")).toBe("(self)");
    expect(policy.get("clipboard-write")).toBe("(self)");
  });

  it("denies every other powerful feature outright", () => {
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb", "serial", "hid", "display-capture"]) {
      expect(policy.get(feature), feature).toBe("()");
    }
  });
});

describe("the indexer's URL", () => {
  it("is https and a full GraphQL path when recorded, so connect-src allows exactly it", () => {
    if (trustApi === null) return;
    expect(trustApi.graphqlUrl).toMatch(/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9._~/-]+\/v1\/graphql$/);
  });
});
