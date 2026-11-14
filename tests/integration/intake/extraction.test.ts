import { beforeAll, describe, expect, it, vi } from "vitest";
import { TicketExtraction, type Extractor, type OcrProvider } from "@/shared/contracts";
import type { DraftCookieJar } from "@/features/intake/draft/cookie";
import { beginTicketUpload, getCurrentDraft } from "@/features/intake/draft/session";
import { createDraft, getDraft, mergeDraftData } from "@/features/intake/draft/store";
import { TICKET_FIELDS } from "@/features/intake/extraction/schema";
import { createFakeExtractor } from "@/features/intake/extraction/fake";
import {
  finishUploadAndRead,
  readCurrentTicket,
  readUploadedTicket,
} from "@/features/intake/extraction/read-ticket";
import { createOcr } from "@/features/intake/ocr";
import { readTicketUpload } from "@/features/intake/upload/read";
import { fixedClock } from "@/shared/clock";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { waitForDb } from "../../fixtures/claims/db-ready";
import {
  expectedData,
  expectedMissing,
  modelOutputsByTextHash,
} from "../../fixtures/intake/extraction";
import { uploadTextsByHash } from "../../fixtures/intake/ocr";
import {
  PLACEHOLDER_HEIC,
  PLACEHOLDER_JPEG,
  PLACEHOLDER_JPEG_UNREADABLE,
  PLACEHOLDER_PDF,
  PLACEHOLDER_PNG,
} from "../../fixtures/intake/tickets";

// [A3] draft → OCR fake → extractor fake → `intake_drafts.data`, against the local Supabase.
const clock = fixedClock("2026-03-12T10:00:00.000Z");
let db: ServiceClient;
const ocr = () => createOcr({}, { fixtures: uploadTextsByHash() });
const extractor = () => createFakeExtractor({ fixtures: modelOutputsByTextHash() });

beforeAll(async () => {
  db = createServiceClient();
  await waitForDb(db);
});

async function draftOf(bytes: Uint8Array, name: string) {
  const read = await readTicketUpload(new File([Buffer.from(bytes)], name));
  if (!read.ok) throw new Error(`fixture ${name} was refused: ${read.error}`);
  return createDraft(read.ticket, { db, clock });
}

function memoryJar(): DraftCookieJar {
  const values = new Map<string, string>();
  return {
    get: (name) => (values.has(name) ? { name, value: values.get(name)! } : undefined),
    set: (name, value, options) => {
      if (options.maxAge === 0) values.delete(name);
      else values.set(name, value);
    },
  };
}

/** What the browser does: begin, PUT to the signed URL; then the server finishes and reads. */
async function uploadAndRead(
  jar: DraftCookieJar,
  bytes: Uint8Array,
  name: string,
  type: string,
  deps: { ocr?: OcrProvider; extractor?: Extractor } = { ocr: ocr(), extractor: extractor() },
) {
  const begun = await beginTicketUpload({ name, type, size: bytes.length }, { db, jar });
  if (!begun.ok) throw new Error(begun.error);
  const res = await fetch(begun.uploadUrl, {
    method: "PUT",
    headers: { "content-type": begun.contentType, "x-upsert": "false" },
    body: Buffer.from(bytes),
  });
  expect(res.status).toBe(200);
  return finishUploadAndRead({ db, clock, jar, ...deps });
}

describe("readUploadedTicket", () => {
  for (const [name, bytes, file] of [
    ["iryo", PLACEHOLDER_PNG, "billete.png"],
    ["renfe", PLACEHOLDER_PDF, "billete.pdf"],
    ["ouigo", PLACEHOLDER_JPEG, "billete.jpg"],
  ] as const) {
    it(`reads the stored ${name} ticket and saves the extraction in the draft`, async () => {
      const draft = await draftOf(bytes, file);
      const outcome = await readUploadedTicket(draft, {
        db,
        clock,
        ocr: ocr(),
        extractor: extractor(),
      });
      expect(outcome.next).toBe("review");

      const saved = await getDraft(draft.id, { db, clock });
      const extraction = TicketExtraction.parse(saved!.data.extraction);
      expect(extraction.quality).toBe("ok");
      expect(extraction.data).toEqual(expectedData[name]);
      expect([...extraction.missing].sort()).toEqual([...expectedMissing[name]].sort());
      expect(saved!.data.ocrAttempts).toBe(0);
      expect(saved!.status).toBe("uploaded");
    });
  }

  it("OCRs the bytes stored in Storage, with their detected content type", async () => {
    const draft = await draftOf(PLACEHOLDER_PNG, "billete.png");
    const readText = vi.fn<OcrProvider["readText"]>(async () => ({
      text: "",
      quality: "unreadable",
    }));
    await readUploadedTicket(draft, { db, clock, ocr: { readText }, extractor: extractor() });
    expect(readText).toHaveBeenCalledTimes(1);
    const file = readText.mock.calls[0][0];
    expect(new Uint8Array(file.bytes)).toEqual(PLACEHOLDER_PNG);
    expect(file.contentType).toBe("image/png");
  });

  it("an unreadable photo is not sent to the extractor and stores only the count", async () => {
    const draft = await draftOf(PLACEHOLDER_JPEG_UNREADABLE, "borrosa.jpg");
    const extract = vi.fn<Extractor["extract"]>();
    const outcome = await readUploadedTicket(draft, {
      db,
      clock,
      ocr: ocr(),
      extractor: { extract },
    });
    expect(outcome.next).toBe("retry");
    expect(extract).not.toHaveBeenCalled();
    const saved = await getDraft(draft.id, { db, clock });
    expect(saved!.data).toEqual({ ocrAttempts: 1 });
  });

  it("text the extractor finds nothing in counts as unreadable", async () => {
    const draft = await draftOf(PLACEHOLDER_PNG, "billete.png");
    const outcome = await readUploadedTicket(draft, {
      db,
      clock,
      ocr: ocr(),
      extractor: createFakeExtractor({ fixtures: {} }),
    });
    expect(outcome.next).toBe("retry");
  });

  it("the second unreadable photo stores manual entry: every field missing", async () => {
    const draft = await draftOf(PLACEHOLDER_JPEG_UNREADABLE, "borrosa.jpg");
    const outcome = await readUploadedTicket(draft, {
      db,
      clock,
      ocr: ocr(),
      extractor: extractor(),
      priorAttempts: 1,
    });
    expect(outcome.next).toBe("manual");
    const saved = await getDraft(draft.id, { db, clock });
    expect(saved!.data).toEqual({
      ocrAttempts: 2,
      extraction: { quality: "unreadable", data: {}, missing: [...TICKET_FIELDS] },
    });
  });

  it("keeps the other steps' keys in the draft", async () => {
    const draft = await draftOf(PLACEHOLDER_PNG, "billete.png");
    await mergeDraftData(draft.id, { review: { confirmed: false } }, { db, clock });
    await readUploadedTicket(draft, { db, clock, ocr: ocr(), extractor: extractor() });
    const saved = await getDraft(draft.id, { db, clock });
    expect(saved!.data.review).toEqual({ confirmed: false });
    expect(saved!.data.extraction).toBeDefined();
  });

  it("a failing extractor throws and leaves the draft unread", async () => {
    const draft = await draftOf(PLACEHOLDER_PNG, "billete.png");
    const failing: Extractor = {
      extract: async () => {
        throw new Error("Gemini extraction request failed with HTTP 503");
      },
    };
    await expect(
      readUploadedTicket(draft, { db, clock, ocr: ocr(), extractor: failing }),
    ).rejects.toThrow(/HTTP 503/);
    expect((await getDraft(draft.id, { db, clock }))!.data).toEqual({});
  });
});

describe("finishUploadAndRead: the upload step's server flow", () => {
  it("a readable upload ends with the extraction in the new draft", async () => {
    const jar = memoryJar();
    const done = await uploadAndRead(jar, PLACEHOLDER_PNG, "billete.png", "image/png");
    expect(done).toMatchObject({ ok: true, next: "review" });
    const current = await getCurrentDraft({ db, clock, jar });
    expect(TicketExtraction.parse(current!.data.extraction).data).toEqual(expectedData.iryo);
  });

  it("unreadable twice in a row → retry, then manual; the count survives the new draft", async () => {
    const jar = memoryJar();
    const first = await uploadAndRead(jar, PLACEHOLDER_JPEG_UNREADABLE, "a.jpg", "image/jpeg");
    expect(first).toMatchObject({ ok: true, next: "retry" });
    const firstDraft = await getCurrentDraft({ db, clock, jar });

    const second = await uploadAndRead(jar, PLACEHOLDER_JPEG_UNREADABLE, "b.jpg", "image/jpeg");
    expect(second).toMatchObject({ ok: true, next: "manual" });
    const current = await getCurrentDraft({ db, clock, jar });
    expect(current!.id).not.toBe(firstDraft!.id);
    expect(current!.data).toEqual({
      ocrAttempts: 2,
      extraction: { quality: "unreadable", data: {}, missing: [...TICKET_FIELDS] },
    });
  });

  it("a readable photo after an unreadable one goes to review and resets the count", async () => {
    const jar = memoryJar();
    await uploadAndRead(jar, PLACEHOLDER_JPEG_UNREADABLE, "a.jpg", "image/jpeg");
    const done = await uploadAndRead(jar, PLACEHOLDER_PDF, "billete.pdf", "application/pdf");
    expect(done).toMatchObject({ ok: true, next: "review" });
    expect((await getCurrentDraft({ db, clock, jar }))!.data.ocrAttempts).toBe(0);
  });

  it("a HEIC photo is unreadable (Vision can't read it) and asks for another", async () => {
    const jar = memoryJar();
    const done = await uploadAndRead(jar, PLACEHOLDER_HEIC, "IMG_0001.HEIC", "image/heic");
    expect(done).toMatchObject({ ok: true, next: "retry" });
  });

  it("a reading failure keeps the upload: the draft is current and unread", async () => {
    const jar = memoryJar();
    const failing: Extractor = {
      extract: async () => {
        throw new Error("boom");
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const done = await uploadAndRead(jar, PLACEHOLDER_PNG, "billete.png", "image/png", {
      ocr: ocr(),
      extractor: failing,
    });
    error.mockRestore();
    expect(done).toMatchObject({ ok: true, next: "failed" });
    const current = await getCurrentDraft({ db, clock, jar });
    expect(current!.data).toEqual({});

    // The step's "Leer el billete" reads it again.
    const again = await readCurrentTicket({ db, clock, jar, ocr: ocr(), extractor: extractor() });
    expect(again).toEqual({ ok: true, next: "review" });
    const read = await getCurrentDraft({ db, clock, jar });
    expect(TicketExtraction.parse(read!.data.extraction).data).toEqual(expectedData.iryo);
  });

  it("a refused upload is passed through and reads nothing", async () => {
    const jar = memoryJar();
    const done = await finishUploadAndRead({ db, clock, jar, ocr: ocr(), extractor: extractor() });
    expect(done).toEqual({ ok: false, error: "not_received" });
  });

  it("with the app's defaults (fake providers, bundled fixtures) the demo tickets are read", async () => {
    const jar = memoryJar();
    const done = await uploadAndRead(jar, PLACEHOLDER_JPEG, "billete.jpg", "image/jpeg", {});
    expect(done).toMatchObject({ ok: true, next: "review" });
    const current = await getCurrentDraft({ db, clock, jar });
    expect(TicketExtraction.parse(current!.data.extraction).data).toEqual(expectedData.ouigo);
  });
});
