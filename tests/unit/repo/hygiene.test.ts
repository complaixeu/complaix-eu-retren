import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Repo hygiene that no linter covers. Runs in `pnpm test`, so in CI too.
const gitGrep = (args: string[]): string => {
  try {
    return execFileSync("git", ["grep", "-n", "-I", ...args], { encoding: "utf8" });
  } catch {
    return ""; // git grep exits 1 when nothing matches
  }
};

describe("repository hygiene", () => {
  it("has no merge-conflict markers in any tracked file", () => {
    const hits = gitGrep(["-E", "^(<<<<<<< |=======$|>>>>>>> )", "--", ".", ":!pnpm-lock.yaml"]);
    expect(hits, `conflict markers found:\n${hits}`).toBe("");
  });

  it("commits no env file other than .env.example", () => {
    const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n");
    const envFiles = files.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && f !== ".env.example");
    expect(envFiles).toEqual([]);
  });

  it("commits no PDF outside templates/ and docs/ (filled forms or tickets never go in git)", () => {
    const files = execFileSync("git", ["ls-files", "*.pdf"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(files.filter((f) => !/^(templates|docs)\/[^/]+\.pdf$/.test(f))).toEqual([]);
  });
});
