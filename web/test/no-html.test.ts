import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Everything the pages show from the chain or the indexer is plain text (the P8 brief): React text nodes only, never
// HTML, and every link built from checked hex by src/explorer.ts, a fixed route or the docs link. A string an attacker
// put on chain (a tag, a reason, a report) or an indexer answer can't become markup or a link anywhere.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const FORBIDDEN = /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\s*\.\s*write|DOMParser|createContextualFragment|\bsrcdoc\b|\beval\s*\(|new\s+Function\s*\(/;
/** An href is a fixed route ("/…"), the docs link, or comes from the explorer builders (or a variable built from them). */
const ALLOWED_HREF = /^href=\{?(?:"\/[a-z]*"|`https:\/\/\$\{RP_ID\}\/[a-z]+`|"https:\/\/github\.com\/AmitChowdary122\/attest8004#readme"|\{?(?:explorerTx|explorerAddress)\(|\{?(?:c\.url|row\.txUrl|row\.addressUrl|txUrl|addressUrl|p\.path)\b)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("plain text only", () => {
  const files = sourceFiles(SRC).map((path) => ({ name: relative(SRC, path), text: readFileSync(path, "utf8") }));

  it("scans every page, the dashboard's included", () => {
    expect(files.map((f) => f.name)).toEqual(expect.arrayContaining(["dashboard/DashboardPage.tsx", "dashboard/view.ts", "inbox/InboxPage.tsx", "approve/ApprovePage.tsx"]));
  });

  it("no source renders HTML or evaluates strings", () => {
    for (const file of files) expect(FORBIDDEN.test(file.text), `${file.name} matches ${FORBIDDEN}`).toBe(false);
  });

  it("every href is a fixed route, the docs link, or an explorer link built from checked hex", () => {
    for (const file of files) {
      for (const [href] of file.text.matchAll(/href=\{?[^\s>]+/g)) expect(ALLOWED_HREF.test(href), `${file.name}: ${href}`).toBe(true);
    }
  });

  it("links only through explorer.ts's builders, never by hand", () => {
    for (const file of files.filter((f) => f.name !== "explorer.ts")) expect(/socialscan\.io/.test(file.text), file.name).toBe(false);
  });
});
