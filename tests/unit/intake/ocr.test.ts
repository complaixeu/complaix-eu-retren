import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFakeOcr } from "@/features/intake/ocr/fake";
import { createOcr } from "@/features/intake/ocr";
import { classifyQuality, MIN_TEXT_LENGTH } from "@/features/intake/ocr/quality";
import { createVisionOcr, type FetchLike } from "@/features/intake/ocr/vision";
import { createGeminiOcr } from "@/features/intake/ocr/gemini";
import { fixtureTextsByHash, ocrFixtureFiles, ocrFixtureTexts } from "@/tests/fixtures/intake/ocr";

const json = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../fixtures/intake/${name}`, import.meta.url), "utf8"));
const reply = (body: unknown, status = 200) =>
  vi.fn<FetchLike>(async () => new Response(JSON.stringify(body), { status }));

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
    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain("files:annotate");
    const req = JSON.parse(init.body as string).requests[0];
    expect(req.inputConfig.mimeType).toBe("application/pdf");
    expect(req.pages).toEqual([1, 2, 3, 4, 5]);
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

describe("vision OCR errors in a 200 response", () => {
  it("throws with only the error code, never the message or key", async () => {
    const fetch = reply({
      responses: [{ error: { code: 3, message: "bad k-secret payload" } }],
    });
    const err = await createVisionOcr({ apiKey: "k-secret", fetch })
      .readText({ bytes: new Uint8Array([1]), contentType: "image/png" })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("3");
    expect((err as Error).message).not.toContain("k-secret");
    expect((err as Error).message).not.toContain("payload");
  });
});

describe("createOcr", () => {
  it("passes defaultText to the fake", async () => {
    const ocr = createOcr({}, { defaultText: "Billete de ejemplo con texto legible suficiente" });
    const r = await ocr.readText({ bytes: new Uint8Array([9]), contentType: "image/png" });
    expect(r.quality).toBe("ok");
  });
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
  it("accepts gemini when its key is present", () => {
    expect(() =>
      createOcr({ OCR_PROVIDER: "gemini", GEMINI_API_KEY: "k" }, { fetch: reply({}) }),
    ).not.toThrow();
  });
  it("gemini without a key names the missing variable", () => {
    expect(() => createOcr({ OCR_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
  });
});

describe("gemini OCR", () => {
  const file = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" };
  const response = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });

  it("sends inline image bytes and the exact transcription instruction", async () => {
    const fetch = reply(response("Billete de tren legible para probar OCR"));
    await createGeminiOcr({ apiKey: "k-secret", fetch }).readText(file);
    const [url, init] = fetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(url).toContain(":generateContent");
    expect(body.contents[0].parts).toContainEqual({
      inlineData: { mimeType: file.contentType, data: Buffer.from(file.bytes).toString("base64") },
    });
    expect(body.contents[0].parts).toContainEqual({
      text: "Transcribe ALL the visible text of this train ticket exactly as printed, line by line. Do not interpret, translate, add or correct anything. If you cannot read it, answer exactly UNREADABLE.",
    });
  });
  it("sends PDFs inline with application/pdf", async () => {
    const fetch = reply(response("PDF ticket text"));
    await createGeminiOcr({ apiKey: "k", fetch }).readText({
      ...file,
      contentType: "application/pdf",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(
      body.contents[0].parts.find((part: { inlineData?: unknown }) => part.inlineData)?.inlineData,
    ).toMatchObject({ mimeType: "application/pdf" });
  });
  it("keeps the API key in the header and out of URLs and logs, and returns text", async () => {
    const fetch = reply(response("Transcribed ticket text exactly"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await createGeminiOcr({ apiKey: "k-secret", fetch }).readText(file);
    expect(result).toEqual({ text: "Transcribed ticket text exactly", quality: "ok" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).not.toContain("k-secret");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k-secret");
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it.each([
    ["HTTP error", async () => new Response("private", { status: 503 })],
    ["empty response", async () => new Response(JSON.stringify(response("")))],
    ["UNREADABLE response", async () => new Response(JSON.stringify(response("UNREADABLE")))],
    [
      "timeout",
      async () => {
        throw new DOMException("timeout", "TimeoutError");
      },
    ],
  ])("returns unreadable for %s", async (_name, impl) => {
    const fetch = vi.fn<FetchLike>(impl);
    const result = await createGeminiOcr({ apiKey: "k", fetch }).readText(file);
    expect(result.quality).toBe("unreadable");
  });
});
