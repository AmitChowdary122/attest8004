import { defineConfig } from "vitest/config";

// Resolve @attest8004/sdk to its TypeScript source, as this validator does at run time
// (node --conditions=@attest8004/source), so tests need no SDK build.
export default defineConfig({
  resolve: { conditions: ["@attest8004/source"] },
  ssr: { resolve: { conditions: ["@attest8004/source"] } },
});
