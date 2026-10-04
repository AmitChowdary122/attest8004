import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

// The production security headers live in vercel.json; `vite preview` serves the same ones, so a local smoke test
// runs under the policy production enforces.
interface VercelConfig {
  headers: { source: string; headers: { key: string; value: string }[] }[];
}
const vercel = JSON.parse(readFileSync(new URL("./vercel.json", import.meta.url), "utf8")) as VercelConfig;
const securityHeaders = Object.fromEntries((vercel.headers[0]?.headers ?? []).map((h) => [h.key, h.value]));

export default defineConfig({
  plugins: [react()],
  // @attest8004/sdk resolves to its TypeScript source, as in the rest of the workspace.
  resolve: { conditions: ["@attest8004/source", ...defaultClientConditions] },
  // The deployed commit, shown in the footer so production can be matched to a commit before any passkey ceremony.
  define: { __BUILD_SHA__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA ?? "local") },
  preview: { headers: securityHeaders },
  // One page carrying viem, zod and Mera's curves (~615 kB, ~190 kB gzipped); splitting it buys nothing here.
  build: { chunkSizeWarningLimit: 700 },
});
