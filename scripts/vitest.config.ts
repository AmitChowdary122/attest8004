import { defineConfig } from "vitest/config";

// Resolve @attest8004/sdk to its TypeScript source, as the scripts do at run time
// (node --conditions=@attest8004/source), so tests need no SDK build.
export default defineConfig({
  resolve: { conditions: ["@attest8004/source"] },
  ssr: { resolve: { conditions: ["@attest8004/source"] } },
});
