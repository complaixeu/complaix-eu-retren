import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Client components must never pull server code into the browser bundle. `@/features/intake`
// re-exports server-only code (the OCR adapters), so no "use client" file in intake's pages or in
// shared/ui may import any domain entry point.
const files = execFileSync("git", ["ls-files", "app/(intake)", "shared/ui"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.tsx?$/.test(f));

const clientFiles = files.filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));

describe("intake client boundary", () => {
  it("finds the client components to check", () => {
    expect(clientFiles).toContain("app/(intake)/reclamar/_components/intake-stepper.tsx");
  });

  it.each(clientFiles)("%s imports no domain code", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).not.toMatch(/from\s+["']@\/features/);
    expect(src).not.toMatch(/from\s+["'](\.\.\/)+features/);
  });
});
