import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The pages read the trust API's URL from the recorded deployment only. A local indexer can stand in under `vite dev`
// (VITE_TRUST_API_URL), never in a production build: the override sits behind import.meta.env.DEV, which Vite
// compiles to false there. It is a build setting, not URL input (the page still reads nothing from its own URL).
const text = readFileSync(new URL("../src/trust-api-url.ts", import.meta.url), "utf8");

describe("trustApiUrl", () => {
  it("reads the recorded deployment", () => {
    expect(text).toContain("deployment.trustApi?.graphqlUrl");
  });

  it("allows the local override only under import.meta.env.DEV", () => {
    const uses = [...text.matchAll(/import\.meta\.env\.VITE_TRUST_API_URL/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      const line = text.slice(text.lastIndexOf("\n", use.index) + 1, text.indexOf("\n", use.index));
      expect(line, line).toMatch(/import\.meta\.env\.DEV &&/);
    }
  });
});
