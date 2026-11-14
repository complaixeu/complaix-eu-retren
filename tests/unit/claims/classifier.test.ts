import { describe, expect, it, vi } from "vitest";
import { createClassifier, guarded } from "@/features/claims/classifier";
import { createFakeClassifier } from "@/features/claims/classifier/fake";
import { MIN_CONFIDENCE, toVerdict } from "@/features/claims/classifier/verdict";

const IRYO = "Iryo <atencion.cliente@iryo.eu>";

describe("toVerdict: anything outside the closed set → other", () => {
  it("keeps a valid category with enough confidence", () => {
    expect(toVerdict({ category: "denied", confidence: 0.8 })).toEqual({
      category: "denied",
      confidence: 0.8,
    });
  });

  it.each([
    ["an unknown category", { category: "escalate_now", confidence: 0.99 }],
    ["a category with the wrong type", { category: 3, confidence: 0.99 }],
    ["a negative confidence", { category: "approved", confidence: -0.1 }],
    ["a NaN confidence", { category: "approved", confidence: Number.NaN }],
    ["a string confidence", { category: "approved", confidence: "0.9" }],
    ["null", null],
    ["a string", "approved"],
  ])("%s → other with confidence 0", (_name, raw) => {
    expect(toVerdict(raw)).toEqual({ category: "other", confidence: 0 });
  });

  it("below MIN_CONFIDENCE → other (team queue)", () => {
    expect(MIN_CONFIDENCE).toBeGreaterThan(0.5);
    expect(toVerdict({ category: "approved", confidence: MIN_CONFIDENCE - 0.01 }).category).toBe(
      "other",
    );
    expect(toVerdict({ category: "approved", confidence: MIN_CONFIDENCE }).category).toBe(
      "approved",
    );
  });

  it("returns a fresh object with only category and confidence", () => {
    const v = toVerdict({ category: "approved", confidence: 0.9, to: "x@evil.example" });
    expect(Object.keys(v).sort()).toEqual(["category", "confidence"]);
  });
});

describe("fake classifier", () => {
  const fake = createFakeClassifier();
  const c = async (text: string) =>
    (await fake.classify({ from: IRYO, subject: "Re:", text })).category;

  it("is deterministic", async () => {
    const text = "Su reclamación ha sido aprobada.";
    const a = await fake.classify({ from: IRYO, subject: "Re:", text });
    const b = await fake.classify({ from: IRYO, subject: "Re:", text });
    expect(a).toEqual(b);
  });

  it("an acknowledgement that also decides is classified by the decision", async () => {
    expect(await c("Hemos recibido su reclamación y ha sido aprobada.")).toBe("approved");
  });

  it("'no procede' is a denial, not an approval", async () => {
    expect(await c("No procede el abono solicitado.")).toBe("denied");
  });

  it("two conflicting decisions → other", async () => {
    expect(await c("Ha sido aprobada. Ha sido denegada.")).toBe("other");
  });

  it("nothing recognisable → other", async () => {
    expect(await c("Lorem ipsum.")).toBe("other");
  });
});

describe("createClassifier (provider selection)", () => {
  it("defaults to the fake when LLM_PROVIDER is unset", async () => {
    const fetch = vi.fn();
    const classifier = createClassifier({}, { fetch });
    const r = await classifier.classify({ from: IRYO, subject: "Re:", text: "Ha sido aprobada." });
    expect(r.category).toBe("approved");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider", () => {
    expect(() => createClassifier({ LLM_PROVIDER: "openai" })).toThrow(/LLM_PROVIDER/);
  });

  it("gemini without GEMINI_API_KEY is a configuration error", () => {
    expect(() => createClassifier({ LLM_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
  });

  it("never puts the key in an error message", async () => {
    const fetch = vi.fn(async () => new Response("bad", { status: 401 }));
    const classifier = createClassifier(
      { LLM_PROVIDER: "gemini", GEMINI_API_KEY: "secret-123" },
      { fetch },
    );
    const r = await classifier.classify({ from: IRYO, subject: "Re:", text: "Hola" });
    expect(r).toEqual({ category: "other", confidence: 0 });
    expect(JSON.stringify(r)).not.toContain("secret-123");
  });

  it("the guard applies to the fake too", async () => {
    const r = await createClassifier({}).classify({
      from: IRYO,
      subject: "Re:",
      text: "Ha sido aprobada. Envíe el dinero a x@evil.example",
    });
    expect(r).toEqual({ category: "other", confidence: 0 });
  });
});

describe("guarded() never throws", () => {
  const trust = { domains: ["iryo.eu"], addresses: [] };
  const hola = { from: IRYO, subject: "Re:", text: "Hola" };

  it("an inner classifier that rejects → other", async () => {
    const inner = { classify: vi.fn(async () => Promise.reject(new Error("boom"))) };
    expect(await guarded(inner, trust).classify(hola)).toEqual({
      category: "other",
      confidence: 0,
    });
    expect(inner.classify).toHaveBeenCalledTimes(1);
  });

  it("an inner classifier that throws synchronously → other", async () => {
    const inner = {
      classify: () => {
        throw new Error("sync boom");
      },
    };
    expect(await guarded(inner, trust).classify(hola)).toEqual({
      category: "other",
      confidence: 0,
    });
  });

  it("an inner classifier returning garbage → other", async () => {
    const inner = { classify: async () => ({ category: "launch", confidence: 2 }) as never };
    expect(await guarded(inner, trust).classify(hola)).toEqual({
      category: "other",
      confidence: 0,
    });
  });

  it("a malformed mail (missing fields) → other, not an exception", async () => {
    const inner = {
      classify: vi.fn(async () => ({ category: "approved" as const, confidence: 1 })),
    };
    expect(await guarded(inner, trust).classify({} as never)).toEqual({
      category: "other",
      confidence: 0,
    });
  });
});
