// Entry point of `pnpm eval:classifier` (run through Vitest for the `@/` alias and TypeScript).
// Calls the real Gemini API only when GEMINI_API_KEY is set; otherwise it skips with a message.
import { expect, it } from "vitest";
import { runClassifierEval } from "./eval";

it("golden set against the real classifier model", { timeout: 600_000 }, async () => {
  const result = await runClassifierEval({ env: process.env });
  if (result.status === "skipped") return;
  expect(result.wrong, "fixtures classified into a wrong category").toEqual([]);
});
