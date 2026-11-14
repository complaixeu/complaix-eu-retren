import { describe, expect, it } from "vitest";
import { getOperatorConfig } from "@/features/rules";
import { createClassifier } from "@/features/claims/classifier";
import { OperatorId, ReplyCategory } from "@/shared/contracts";
import { loadGoldenSet } from "@/tests/fixtures/mail/golden";

// C5: the golden set of operator replies, classified by the fake (docs/plans/README.md §4.4).
const golden = loadGoldenSet();
const activeOperators = OperatorId.options.filter((id) => getOperatorConfig(id).active);
const classifier = createClassifier({ LLM_PROVIDER: "fake" });

const EMAIL = /[^\s<>@]+@[^\s<>@]+/;

describe("golden set coverage", () => {
  it("has at least one active operator", () => {
    expect(activeOperators.length).toBeGreaterThan(0);
  });

  for (const operator of activeOperators) {
    for (const category of ReplyCategory.options) {
      it(`${operator}: at least 3 fixtures for ${category}`, () => {
        const n = golden.filter(
          (f) => f.operator === operator && f.kind === "category" && f.accept[0] === category,
        ).length;
        expect(n).toBeGreaterThanOrEqual(3);
      });
    }

    for (const kind of ["injection", "wrong-sender", "spoofed-ref"] as const) {
      it(`${operator}: has ${kind} fixtures`, () => {
        expect(
          golden.filter((f) => f.operator === operator && f.kind === kind).length,
        ).toBeGreaterThan(0);
      });
    }

    it(`${operator}: every injection fixture contains an address outside the operator's domain`, () => {
      const injections = golden.filter((f) => f.operator === operator && f.kind === "injection");
      for (const f of injections) expect(f.mail.text, f.file).toMatch(EMAIL);
    });
  }
});

describe("fake classifier on the golden set", () => {
  for (const fixture of golden) {
    it(`${fixture.operator}/${fixture.file} → ${fixture.accept.join(" | ")}`, async () => {
      const result = await classifier.classify(fixture.mail);
      expect(fixture.accept).toContain(result.category);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  }

  it("classifies every ordinary fixture as exactly its category (no fallback)", async () => {
    for (const fixture of golden.filter((f) => f.kind === "category")) {
      const result = await classifier.classify(fixture.mail);
      expect(result.category, fixture.file).toBe(fixture.accept[0]);
    }
  });
});

describe("prompt injection: classified, team queue, no action", () => {
  const injections = golden.filter((f) => f.kind === "injection");

  for (const fixture of injections) {
    it(`${fixture.operator}/${fixture.file} goes to the team queue (other)`, async () => {
      expect(await classifier.classify(fixture.mail)).toEqual({ category: "other", confidence: 0 });
    });

    it(`${fixture.operator}/${fixture.file} yields no action towards the address it contains`, async () => {
      const address = EMAIL.exec(fixture.mail.text)![0];
      const result = await classifier.classify(fixture.mail);
      // The verdict is only a category and a confidence: nothing to send, no recipient, no
      // instruction the caller could act on.
      expect(Object.keys(result).sort()).toEqual(["category", "confidence"]);
      expect(JSON.stringify(result)).not.toContain(address);
      expect(JSON.stringify(result)).not.toContain("@");
    });
  }
});
