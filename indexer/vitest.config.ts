import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // createTestIndexer starts the real indexer runtime in-process for each test.
    testTimeout: 30_000,
  },
});
