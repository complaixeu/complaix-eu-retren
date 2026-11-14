import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests: pure logic, no database, no network (docs/plans/README.md §3).
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
