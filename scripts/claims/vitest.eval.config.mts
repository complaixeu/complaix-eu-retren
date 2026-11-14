import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

// `pnpm eval:classifier` only: the golden set against real Gemini (docs/plans/README.md §4.5).
// Never part of `pnpm test` or CI. Reads GEMINI_* from the shell or from .env.local; nothing else
// from the env file is passed through, and nothing is printed.
const root = fileURLToPath(new URL("../../", import.meta.url));
const envFile = `${root}.env.local`;
const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
const gemini = (vars: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries(vars).filter(
      (e): e is [string, string] =>
        (e[0].startsWith("GEMINI_") || e[0] === "MAIL_SENDING_DOMAIN") && Boolean(e[1]),
    ),
  );

export default defineConfig({
  root,
  resolve: { alias: { "@": root } },
  test: {
    include: ["features/claims/classifier/eval-classifier.eval.ts"],
    environment: "node",
    silent: false,
    reporters: ["verbose"],
    env: { ...gemini(fromFile), ...gemini(process.env) },
  },
});
