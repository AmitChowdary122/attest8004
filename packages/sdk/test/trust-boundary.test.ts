import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The indexer is a convenience, never a trust root (ARCHITECTURE §7, the P8 brief): no verdict and no `verify` may
// read it. mandate-v1, risk-v1 and the CLI keep reading chain state at the pin, so their sources never mention it.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const VERDICT_SOURCES = ["validators/mandate/src", "validators/risk/src", "packages/cli/src"];
// Every name trust-api.ts exports (its readers, its queries, its re-checks), plus the module and the indexer itself.
const TRUST_API = readFileSync(join(ROOT, "packages/sdk/src/trust-api.ts"), "utf8");
const EXPORTED = [...TRUST_API.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)].map((m) => m[1] as string);
const FORBIDDEN = new RegExp(`trust-api|graphql|hyperindex|envio|\\b(?:${EXPORTED.join("|")})\\b`, "i");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|mts|js|mjs)$/.test(name) ? [path] : [];
  });
}

describe("the trust boundary", () => {
  const files = VERDICT_SOURCES.flatMap((dir) => sourceFiles(join(ROOT, dir)));

  it("forbids every reader the trust API exports", () => {
    expect(EXPORTED).toEqual(expect.arrayContaining(["getAgentTrust", "getIndexedVerdicts", "getTrustOverview", "findIndexedReports", "confirmIndexedVerdict", "confirmIndexedReport", "TRUST_API_QUERIES"]));
    expect(FORBIDDEN.test("const v = await getIndexedVerdicts({ agentId })")).toBe(true);
  });

  it("scans every verdict and verify source", () => {
    expect(files.map((f) => relative(ROOT, f))).toEqual(expect.arrayContaining(["validators/mandate/src/verify.ts", "validators/risk/src/verify.ts", "packages/cli/src/cli.ts"]));
  });

  it("no validator or CLI source reads the indexer", () => {
    for (const file of files) expect(FORBIDDEN.test(readFileSync(file, "utf8")), relative(ROOT, file)).toBe(false);
  });
});
