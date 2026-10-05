import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Nothing the pages handle is ever stored (SPEC §4.7, P6's /approve and P7's /inbox): no web storage, no IndexedDB,
// no cookie, no Cache API, no service worker. A decrypted report lives in React state until "Forget" or a reload.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const FORBIDDEN = /\b(localStorage|sessionStorage|indexedDB|caches)\b|document\s*\.\s*cookie|serviceWorker/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("no storage", () => {
  const files = sourceFiles(SRC).map((path) => ({ name: relative(SRC, path), text: readFileSync(path, "utf8") }));

  it("scans both pages' sources, the inbox's included", () => {
    expect(files.map((f) => f.name)).toEqual(expect.arrayContaining(["inbox/InboxPage.tsx", "approve/InboxKey.tsx", "approve/ApprovePage.tsx"]));
  });

  it("no source touches web storage, IndexedDB, cookies, the Cache API or a service worker", () => {
    for (const file of files) expect(FORBIDDEN.test(file.text), `${file.name} matches ${FORBIDDEN}`).toBe(false);
  });

  it("every chain client goes through the SDK's rate-limited fetch", () => {
    const chain = files.find((f) => f.name === "approve/chain.ts")?.text ?? "";
    expect(chain).toMatch(/rateLimitedFetch\(\{ requestsPerSecond: 8,/);
    for (const file of files.filter((f) => f.name !== "approve/chain.ts")) {
      expect(/\bcreatePublicClient\s*\(/.test(file.text), `${file.name} builds its own client`).toBe(false);
    }
  });
});
