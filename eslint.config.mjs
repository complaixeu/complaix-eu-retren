import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Domain boundaries (docs/TEAM_WORKFLOW.md §1): other domains only through @/features/<domain>,
// and dependencies only go A (intake) → C (claims) → B (rules, documents).
const internals = {
  group: ["@/features/*/*"],
  message: "Import other domains only through @/features/<domain> (TEAM_WORKFLOW §1).",
};
const forbid = (domains, why) => ({
  group: domains.map((d) => `@/features/${d}`),
  message: why,
});
const boundary = (...patterns) => ({
  "no-restricted-imports": ["error", { patterns: [internals, ...patterns] }],
});

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  { files: ["**/*.{ts,tsx,mts}"], rules: boundary() },
  {
    files: ["features/rules/**", "features/documents/**"],
    rules: boundary(
      forbid(["intake", "claims"], "Domain B depends on no other domain (A → C → B)."),
    ),
  },
  {
    files: ["features/claims/**", "app/api/claims/**", "app/(team)/**"],
    rules: boundary(forbid(["intake"], "Domain C never imports intake (A → C → B).")),
  },
  {
    files: ["shared/**"],
    rules: boundary(
      forbid(["intake", "rules", "documents", "claims"], "shared/ must not depend on any domain."),
    ),
  },
  // Tests may reach into their own domain's internals.
  { files: ["tests/**"], rules: { "no-restricted-imports": "off" } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
