import { describe, expect, expectTypeOf, it } from "vitest";

// Each domain's public entry point and its mock export exactly the same names, so swapping the
// mock for the real implementation never breaks a consumer (docs/plans/README.md §2).
const domains = {
  rules: [() => import("@/features/rules"), () => import("@/features/rules/mock")],
  documents: [() => import("@/features/documents"), () => import("@/features/documents/mock")],
  claims: [() => import("@/features/claims"), () => import("@/features/claims/mock")],
} as const;

describe("mock parity", () => {
  for (const [name, [real, mock]] of Object.entries(domains)) {
    it(`${name}: index.ts and mock.ts export the same names`, async () => {
      const [r, m] = await Promise.all([real(), mock()]);
      expect(Object.keys(r).sort()).toEqual(Object.keys(m).sort());
    });
  }

  it("documents: public API and mock functions have matching types", async () => {
    const [real, mock] = await Promise.all([
      import("@/features/documents"),
      import("@/features/documents/mock"),
    ]);

    expectTypeOf(real.buildEuForm).toEqualTypeOf(mock.buildEuForm);
    expectTypeOf(real.buildMandate).toEqualTypeOf(mock.buildMandate);
    expectTypeOf(real.renderTemplate).toEqualTypeOf(mock.renderTemplate);
  });
});
