import { defineConfig } from "vitest/config";

// Resolve the workspace packages (@attest8004/sdk and both validators) to their TypeScript source, as
// the CLI does at run time (node --conditions=@attest8004/source), so tests need no build.
export default defineConfig({
  resolve: { conditions: ["@attest8004/source"] },
  ssr: { resolve: { conditions: ["@attest8004/source"] } },
});
