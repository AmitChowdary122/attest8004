import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defaultServerConditions, defineConfig } from "vite";

// The production security headers live in vercel.json; `vite preview` serves the same ones, so a local smoke test
// runs under the policy production enforces.
interface VercelConfig {
  headers: { source: string; headers: { key: string; value: string }[] }[];
}
const vercel = JSON.parse(readFileSync(new URL("./vercel.json", import.meta.url), "utf8")) as VercelConfig;
const securityHeaders = Object.fromEntries((vercel.headers[0]?.headers ?? []).map((h) => [h.key, h.value]));

export default defineConfig({
  plugins: [react()],
  // @attest8004/sdk resolves to its TypeScript source, as in the rest of the workspace: in the browser build, and in
  // vitest's node environment too (which uses the SSR conditions), so tests never read a stale dist/.
  resolve: { conditions: ["@attest8004/source", ...defaultClientConditions] },
  ssr: { resolve: { conditions: ["@attest8004/source", ...defaultServerConditions] } },
  // The deployed commit, shown in the footer so production can be matched to a commit before any passkey ceremony.
  define: { __BUILD_SHA__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA ?? "local") },
  preview: { headers: securityHeaders },
  // One bundle carrying viem, zod, Mera's curves and the three pages (~705 kB, ~218 kB gzipped); splitting it buys
  // nothing here.
  build: { chunkSizeWarningLimit: 760 },
});
