import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFakeOcr } from "@/features/intake/ocr/fake";
import { createOcr } from "@/features/intake/ocr";
import { classifyQuality, MIN_TEXT_LENGTH } from "@/features/intake/ocr/quality";
import { createVisionOcr } from "@/features/intake/ocr/vision";
import { fixtureTextsByHash, ocrFixtureFiles, ocrFixtureTexts } from "@/tests/fixtures/intake/ocr";

const json = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../fixtures/intake/${name}`, import.meta.url), "utf8"));
const reply = (body: unknown, status = 200) =>
  vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }));

describe("classifyQuality", () => {
  it("empty or very short text is unreadable", () => {
    expect(classifyQuality("")).toBe("unreadable");
    expect(classifyQuality("  \n ")).toBe("unreadable");
    expect(classifyQuality("a".repeat(MIN_TEXT_LENGTH - 1))).toBe("unreadable");
    expect(classifyQuality("a".repeat(MIN_TEXT_LENGTH))).toBe("ok");
  });
});

describe("fake OCR", () => {
  const ocr = createFakeOcr({ fixtures: fixtureTextsByHash() });
  for (const name of ["iryo", "renfe", "ouigo"] as const) {
    it(`returns the ${name} fixture keyed by file hash`, async () => {
      const r = await ocr.readText({ bytes: ocrFixtureFiles[name], contentType: "image/jpeg" });
      expect(r).toEqual({ text: ocrFixtureTexts[name], quality: "ok" });
    });
  }
  it("the unreadable fixture is unreadable", async () => {
    const r = await ocr.readText({ bytes: ocrFixtureFiles.unreadable, contentType: "image/png" });
    expect(r.quality).toBe("unreadable");
  });
  it("an unknown file gets the safe default: unreadable, empty", async () => {
    const r = await ocr.readText({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" });
    expect(r).toEqual({ text: "", quality: "unreadable" });
  });
});

describe("vision OCR", () => {
  const file = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" };

  it("maps an image response and never puts the key in the URL", async () => {
    const fetch = reply(json("vision-image-response.json"));
    const r = await createVisionOcr({ apiKey: "k-secret", fetch }).readText(file);
    expect(r.quality).toBe("ok");
    expect(r.text).toContain("Localizador: ABC123");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain("images:annotate");
    expect(url).not.toContain("k-secret");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k-secret");
    const body = JSON.parse(init.body as string);
    expect(body.requests[0].features[0].type).toBe("DOCUMENT_TEXT_DETECTION");
    expect(body.requests[0].image.content).toBe(Buffer.from(file.bytes).toString("base64"));
  });

  it("maps a PDF response (files:annotate), joining pages", async () => {
    const fetch = reply(json("vision-pdf-response.json"));
    const r = await createVisionOcr({ apiKey: "k", fetch }).readText({
      bytes: file.bytes,
      contentType: "application/pdf",
    });
    expect(fetch.mock.calls[0][0]).toContain("files:annotate");
    expect(r.quality).toBe("ok");
    expect(r.text).toContain("Pagina uno");
    expect(r.text).toContain("Pagina dos");
  });

  it("no text found is unreadable", async () => {
    const fetch = reply(json("vision-empty-response.json"));
    const r = await createVisionOcr({ apiKey: "k", fetch }).readText(file);
    expect(r).toEqual({ text: "", quality: "unreadable" });
  });

  it("a content type Vision cannot read is unreadable without calling it", async () => {
    const fetch = reply({});
    const r = await createVisionOcr({ apiKey: "k", fetch }).readText({
      ...file,
      contentType: "image/heic",
    });
    expect(r.quality).toBe("unreadable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("an HTTP error throws without leaking the key", async () => {
    const fetch = reply({ error: { message: "echo k-secret" } }, 403);
    const err = await createVisionOcr({ apiKey: "k-secret", fetch })
      .readText(file)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("403");
    expect((err as Error).message).not.toContain("k-secret");
  });
});

describe("createOcr", () => {
  it("defaults to the fake", () => {
    expect(createOcr({})).toBeDefined();
  });
  it("vision without a key is a configuration error", () => {
    expect(() => createOcr({ OCR_PROVIDER: "vision" })).toThrow(/GOOGLE_CLOUD_VISION_API_KEY/);
  });
  it("vision with a key builds", () => {
    expect(() =>
      createOcr({ OCR_PROVIDER: "vision", GOOGLE_CLOUD_VISION_API_KEY: "k" }),
    ).not.toThrow();
  });
  it("an unknown provider throws", () => {
    expect(() => createOcr({ OCR_PROVIDER: "nope" })).toThrow();
  });
});
