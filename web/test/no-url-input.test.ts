import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The page never reads an agent, a mandate or any other value from the URL (amendment 2 to the P6 plan), so a
// phishing link can't pre-fill a malicious mandate. Every URL access lives in src/approve/url.ts, which only reads the
// hostname (for the rpId guard) and checks whether a query or fragment exists in order to strip it unread.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const URL_MODULE = "approve/url.ts";

const FORBIDDEN = [
  /\blocation\s*\.\s*(search|hash|href|origin|host)\b/,
  /\bURLSearchParams\b/,
  /\bdocument\s*\.\s*(URL|location|referrer|baseURI)\b/,
  /\buseSearchParams\b/,
  /\bnew\s+URL\s*\(/,
  /\bonhashchange\b|\bhashchange\b|\bpopstate\b/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("no URL input", () => {
  const files = sourceFiles(SRC).map((path) => ({ name: relative(SRC, path), text: readFileSync(path, "utf8") }));

  it("scans the page's sources", () => {
    expect(files.map((f) => f.name)).toContain(URL_MODULE);
    expect(files.length).toBeGreaterThan(5);
  });

  it("no source except url.ts touches the query, the fragment, the full URL or the referrer", () => {
    for (const file of files.filter((f) => f.name !== URL_MODULE)) {
      for (const pattern of FORBIDDEN) expect(pattern.test(file.text), `${file.name} matches ${pattern}`).toBe(false);
      expect(/\blocation\s*\.\s*hostname\b/.test(file.text), `${file.name} reads location.hostname`).toBe(false);
      expect(/\bhistory\s*\.\s*(replaceState|pushState)\b/.test(file.text), `${file.name} rewrites the URL`).toBe(false);
    }
  });

  it("url.ts reads only the hostname, and the query and fragment only to test whether they are empty", () => {
    const text = files.find((f) => f.name === URL_MODULE)?.text ?? "";
    const reads = [...text.matchAll(/\blocation\s*\.\s*(\w+)/g)].map((m) => m[1]);
    expect(new Set(reads)).toEqual(new Set(["hostname", "search", "hash", "pathname"]));
    expect(text).toContain('window.location.search !== "" || window.location.hash !== ""');
    expect(text.match(/location\.search/g)).toHaveLength(1);
    expect(text.match(/location\.hash/g)).toHaveLength(1);
    expect(text).toContain('window.history.replaceState(null, "", window.location.pathname)');
    for (const pattern of FORBIDDEN.slice(1)) expect(pattern.test(text), `url.ts matches ${pattern}`).toBe(false);
  });
});
