import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests: server code against the local Supabase (127.0.0.1), fake providers.
// Needs `pnpm db:start` (or `pnpm test:all`, which handles it).
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/integration/setup/env.ts"],
    // One database for everyone: run files one at a time so tests don't race on shared rows.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
