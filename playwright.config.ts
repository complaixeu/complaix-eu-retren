import { defineConfig, devices } from "@playwright/test";
import { testAppEnv } from "./tests/support/local-supabase";

// Interface tests (docs/plans/README.md §3): a production build on 127.0.0.1 against the local
// Supabase, with fake providers only. Needs `pnpm db:start` (or `pnpm test:all`).
const port = Number(process.env.E2E_PORT ?? 3200);
const env = testAppEnv(port);

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm build && pnpm start -p ${port} -H 127.0.0.1`,
    url: `http://127.0.0.1:${port}/api/health`,
    env,
    timeout: 240_000,
    reuseExistingServer: false,
  },
});
