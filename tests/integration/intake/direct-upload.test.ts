import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DRAFT_COOKIE, UPLOAD_COOKIE, type DraftCookieJar } from "@/features/intake/draft/cookie";
import {
  beginTicketUpload,
  finishTicketUpload,
  getCurrentDraft,
} from "@/features/intake/draft/session";
import { TICKET_BUCKET } from "@/features/intake/draft/store";
import { UPLOAD_PREFIX } from "@/features/intake/upload/direct";
import { TICKET_MAX_BYTES } from "@/features/intake/upload/rules";
import { fixedClock } from "@/shared/clock";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { waitForDb } from "../../fixtures/claims/db-ready";
import {
  PLACEHOLDER_JPEG,
  PLACEHOLDER_PDF,
  PLACEHOLDER_PNG,
  PLACEHOLDER_TEXT,
  placeholderPngOfSize,
} from "../../fixtures/intake/tickets";

// [A1 follow-up] The direct upload against the local Supabase: the browser PUTs the file to a
// signed upload URL (here: fetch), then the server checks the stored object and makes the draft.
const clock = fixedClock("2026-03-12T10:00:00.000Z");
const BUCKET_TYPES = ["image/jpeg", "image/png", "image/heic", "application/pdf"];
let db: ServiceClient;

beforeAll(async () => {
  db = createServiceClient();
  await waitForDb(db);
});

function memoryJar() {
  const values = new Map<string, string>();
  const jar: DraftCookieJar = {
    get: (name) => (values.has(name) ? { name, value: values.get(name)! } : undefined),
    set: (name, value, options) => {
      if (options.maxAge === 0) values.delete(name);
      else values.set(name, value);
    },
  };
  return { jar, values };
}

/** What the browser does with the signed URL. */
function put(url: string, bytes: Uint8Array, contentType: string) {
  return fetch(url, {
    method: "PUT",
    headers: { "content-type": contentType, "x-upsert": "false" },
    body: Buffer.from(bytes),
  });
}

async function exists(path: string) {
  const { data } = await db.storage.from(TICKET_BUCKET).exists(path);
  return data === true;
}

describe("beginTicketUpload → PUT → finishTicketUpload", () => {
  it("stores the file, makes it the current draft and leaves no staged copy", async () => {
    const { jar, values } = memoryJar();
    const begun = await beginTicketUpload(
      { name: "billete.png", type: "image/png", size: PLACEHOLDER_PNG.length },
      { db, jar },
    );
    expect(begun).toMatchObject({ ok: true, contentType: "image/png" });
    if (!begun.ok) return;
    expect(begun.uploadUrl).toMatch(/\/storage\/v1\/object\/upload\/sign\/tickets\/uploads\//);
    expect(values.has(UPLOAD_COOKIE)).toBe(true);

    const res = await put(begun.uploadUrl, PLACEHOLDER_PNG, begun.contentType);
    expect(res.status).toBe(200);

    const done = await finishTicketUpload({ db, clock, jar });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const draft = done.draft;
    expect(draft.ticket).toMatchObject({
      contentType: "image/png",
      filename: "billete.png",
      sizeBytes: PLACEHOLDER_PNG.length,
    });
    // The final key is new: the browser only ever knew the staging one.
    expect(draft.ticket!.path).toMatch(/^drafts\/[0-9a-f-]{36}\.png$/);
    expect(begun.uploadUrl).not.toContain(draft.ticket!.path);
    const stored = await db.storage.from(TICKET_BUCKET).download(draft.ticket!.path);
    expect(new Uint8Array(await stored.data!.arrayBuffer())).toEqual(PLACEHOLDER_PNG);

    expect(values.has(UPLOAD_COOKIE)).toBe(false);
    expect(values.get(DRAFT_COOKIE)).toBe(draft.id);
    expect(await getCurrentDraft({ db, clock, jar })).toEqual(draft);
    const staged = stagedPath(begun.uploadUrl);
    expect(staged.startsWith(UPLOAD_PREFIX)).toBe(true);
    expect(await exists(staged)).toBe(false);
  });

  it("refuses wrong magic bytes in Storage and deletes the object", async () => {
    const { jar, values } = memoryJar();
    const begun = await beginTicketUpload(
      { name: "billete.jpg", type: "image/jpeg", size: PLACEHOLDER_TEXT.length },
      { db, jar },
    );
    if (!begun.ok) throw new Error(begun.error);
    expect((await put(begun.uploadUrl, PLACEHOLDER_TEXT, "image/jpeg")).status).toBe(200);
    const staged = stagedPath(begun.uploadUrl);
    expect(await exists(staged)).toBe(true);

    expect(await finishTicketUpload({ db, clock, jar })).toEqual({
      ok: false,
      error: "wrong_type",
    });
    expect(await exists(staged)).toBe(false);
    expect(values.has(DRAFT_COOKIE)).toBe(false);
  });

  describe("an object over 10 MB in Storage", () => {
    // The bucket refuses it on its own; to reach the server check, raise its limit for a moment.
    afterEach(async () => {
      await db.storage.updateBucket(TICKET_BUCKET, {
        public: false,
        fileSizeLimit: TICKET_MAX_BYTES,
        allowedMimeTypes: BUCKET_TYPES,
      });
    });

    it("is refused by the bucket itself", async () => {
      const { jar } = memoryJar();
      const begun = await beginTicketUpload(
        { name: "a.png", type: "image/png", size: 100 },
        { db, jar },
      );
      if (!begun.ok) throw new Error(begun.error);
      const res = await put(
        begun.uploadUrl,
        placeholderPngOfSize(TICKET_MAX_BYTES + 1),
        "image/png",
      );
      expect(res.ok).toBe(false);
    });

    it("is refused by the server check and deleted", async () => {
      await db.storage.updateBucket(TICKET_BUCKET, {
        public: false,
        fileSizeLimit: 2 * TICKET_MAX_BYTES,
        allowedMimeTypes: BUCKET_TYPES,
      });
      const { jar } = memoryJar();
      // The declared size can lie: the server goes by what is stored.
      const begun = await beginTicketUpload(
        { name: "a.png", type: "image/png", size: 100 },
        { db, jar },
      );
      if (!begun.ok) throw new Error(begun.error);
      const big = placeholderPngOfSize(TICKET_MAX_BYTES + 1);
      expect((await put(begun.uploadUrl, big, "image/png")).status).toBe(200);
      const staged = stagedPath(begun.uploadUrl);

      expect(await finishTicketUpload({ db, clock, jar })).toEqual({
        ok: false,
        error: "too_large",
      });
      expect(await exists(staged)).toBe(false);
    });
  });

  it("stores the detected content type, not the one the PUT claimed", async () => {
    const { jar } = memoryJar();
    const begun = await beginTicketUpload(
      { name: "billete.png", type: "image/png", size: PLACEHOLDER_JPEG.length },
      { db, jar },
    );
    if (!begun.ok) throw new Error(begun.error);
    expect((await put(begun.uploadUrl, PLACEHOLDER_JPEG, "image/png")).status).toBe(200);
    const staged = stagedPath(begun.uploadUrl);

    const done = await finishTicketUpload({ db, clock, jar });
    if (!done.ok) throw new Error(done.error);
    expect(done.draft.ticket).toMatchObject({ contentType: "image/jpeg" });
    expect(done.draft.ticket!.path).toMatch(/\.jpg$/);
    const info = await db.storage.from(TICKET_BUCKET).info(done.draft.ticket!.path);
    expect(info.data?.contentType).toBe("image/jpeg");
    expect(await exists(staged)).toBe(false);
  });

  it("reports a missing object as not received", async () => {
    const { jar } = memoryJar();
    const begun = await beginTicketUpload(
      { name: "b.pdf", type: "application/pdf", size: PLACEHOLDER_PDF.length },
      { db, jar },
    );
    expect(begun.ok).toBe(true);
    expect(await finishTicketUpload({ db, clock, jar })).toEqual({
      ok: false,
      error: "not_received",
    });
  });

  it("without a begun upload there is nothing to finish", async () => {
    expect(await finishTicketUpload({ db, clock, jar: memoryJar().jar })).toEqual({
      ok: false,
      error: "not_received",
    });
  });

  it("refuses to begin an upload the check would refuse anyway", async () => {
    const { jar, values } = memoryJar();
    expect(
      await beginTicketUpload({ name: "a.txt", type: "text/plain", size: 10 }, { db, jar }),
    ).toEqual({ ok: false, error: "wrong_type" });
    expect(
      await beginTicketUpload(
        { name: "a.png", type: "image/png", size: TICKET_MAX_BYTES + 1 },
        { db, jar },
      ),
    ).toEqual({ ok: false, error: "too_large" });
    expect(values.has(UPLOAD_COOKIE)).toBe(false);
  });
});

/** The staged object's key, from the signed upload URL. */
function stagedPath(uploadUrl: string) {
  const path = new URL(uploadUrl).pathname.split(`/sign/${TICKET_BUCKET}/`)[1];
  return decodeURIComponent(path);
}
