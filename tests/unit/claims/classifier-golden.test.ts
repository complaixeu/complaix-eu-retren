import { describe, expect, it } from "vitest";
import { getOperatorConfig } from "@/features/rules";
import { createClassifier } from "@/features/claims/classifier";
import { OperatorId, ReplyCategory } from "@/shared/contracts";
import { loadGoldenSet, type GoldenFixture } from "@/tests/fixtures/mail/golden";

// C5: the golden set of operator replies, classified by the fake (docs/plans/README.md §4.4).
const golden = loadGoldenSet();
const activeOperators = OperatorId.options.filter((id) => getOperatorConfig(id).active);
const classifier = createClassifier({ LLM_PROVIDER: "fake" });
const classify = (f: GoldenFixture) =>
  classifier.forCase({ operator: OperatorId.parse(f.operator) }).classify(f.mail);

/** Plain (non-obfuscated) addresses in a text, independent of the guard's own parsing. */
const ADDRESSES = /[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
const addressesIn = (text: string) => [...text.matchAll(ADDRESSES)];

function operatorDomain(operator: string): string {
  const channel = getOperatorConfig(OperatorId.parse(operator)).channel;
  if (channel.type !== "email") throw new Error(`${operator} has no email channel`);
  return channel.address.split("@")[1].toLowerCase();
}
const inDomain = (domain: string, base: string) => domain === base || domain.endsWith(`.${base}`);

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

    it(`${operator}: injection fixtures with an address name one outside the operator's domain`, () => {
      const domain = operatorDomain(operator);
      const withAddress = golden.filter(
        (f) => f.operator === operator && f.kind === "injection" && addressesIn(f.mail.text).length,
      );
      expect(withAddress.length).toBeGreaterThan(0);
      for (const f of withAddress) {
        for (const [address, addressDomain] of addressesIn(f.mail.text)) {
          expect(inDomain(addressDomain.toLowerCase(), domain), `${f.file}: ${address}`).toBe(
            false,
          );
        }
      }
    });
  }
});

describe("fake classifier on the golden set", () => {
  for (const fixture of golden) {
    it(`${fixture.operator}/${fixture.file} → ${fixture.accept.join(" | ")}`, async () => {
      const result = await classify(fixture);
      expect(fixture.accept).toContain(result.category);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  }

  it("classifies every ordinary fixture as exactly its category (no fallback)", async () => {
    for (const fixture of golden.filter((f) => f.kind === "category")) {
      const result = await classify(fixture);
      expect(result.category, fixture.file).toBe(fixture.accept[0]);
    }
  });
});

describe("prompt injection: classified, team queue, no action", () => {
  const injections = golden.filter((f) => f.kind === "injection");

  for (const fixture of injections) {
    it(`${fixture.operator}/${fixture.file} goes to the team queue (other)`, async () => {
      expect(await classify(fixture)).toEqual({ category: "other", confidence: 0 });
    });

    it(`${fixture.operator}/${fixture.file} yields no action towards anything it names`, async () => {
      const result = await classify(fixture);
      // The verdict is only a category and a confidence: nothing to send, no recipient, no
      // instruction the caller could act on.
      expect(Object.keys(result).sort()).toEqual(["category", "confidence"]);
      for (const [address] of addressesIn(fixture.mail.text)) {
        expect(JSON.stringify(result)).not.toContain(address);
      }
      expect(JSON.stringify(result)).not.toMatch(/@|＠|https?:|\[at\]/i);
    });
  }
});
