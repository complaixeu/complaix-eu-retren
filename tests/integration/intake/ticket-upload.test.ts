import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { DRAFT_COOKIE, type DraftCookieJar } from "@/features/intake/draft/cookie";
import {
  getCurrentDraft,
  requireDraft,
  startDraft,
  updateCurrentDraft,
} from "@/features/intake/draft/session";
import {
  DRAFT_TTL_MS,
  TICKET_BUCKET,
  createDraft,
  deleteDraft,
  getDraft,
  mergeDraftData,
  ticketPreview,
  ticketVersion,
} from "@/features/intake/draft/store";
import { readTicketUpload } from "@/features/intake/upload/read";
import { fixedClock } from "@/shared/clock";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { waitForDb } from "../../fixtures/claims/db-ready";
import { PLACEHOLDER_HEIC, PLACEHOLDER_PDF, PLACEHOLDER_PNG } from "../../fixtures/intake/tickets";

// [A1] Upload a placeholder file → the object is stored in the private `tickets` bucket and an
// `intake_drafts` row is created, against the local Supabase (127.0.0.1, fake providers).
const NOW = new Date("2026-03-12T10:00:00.000Z");
const clock = fixedClock(NOW);
let db: ServiceClient;

beforeAll(async () => {
  db = createServiceClient();
  await waitForDb(db);
});

const file = (bytes: Uint8Array, name: string, type = "") =>
  new File([Buffer.from(bytes)], name, { type });

async function uploaded(bytes: Uint8Array, name: string) {
  const read = await readTicketUpload(file(bytes, name));
  if (!read.ok) throw new Error(`fixture ${name} was refused: ${read.error}`);
  return read.ticket;
}

async function row(id: string) {
  const { data, error } = await db
    .from("intake_drafts" as never)
    .select("*")
    .eq("id", id);
  expect(error).toBeNull();
  return (data as Record<string, unknown>[])[0];
}

async function stored(path: string) {
  const { data, error } = await db.storage.from(TICKET_BUCKET).download(path);
  if (error) return null;
  return new Uint8Array(await data.arrayBuffer());
}

/** A cookie jar like Next's `cookies()`, kept in memory. */
function memoryJar(initial?: string) {
  const values = new Map<string, string>(initial ? [[DRAFT_COOKIE, initial]] : []);
  const sets: { name: string; value: string; options: Record<string, unknown> }[] = [];
  const jar: DraftCookieJar = {
    get: (name) => (values.has(name) ? { name, value: values.get(name)! } : undefined),
    set: (name, value, options) => {
      sets.push({ name, value, options: { ...options } });
      if (options.maxAge === 0) values.delete(name);
      else values.set(name, value);
    },
  };
  return { jar, sets, values };
}

describe("createDraft (local Supabase)", () => {
  it("stores the placeholder in the private bucket and creates the draft row", async () => {
    const ticket = await uploaded(PLACEHOLDER_PNG, "billete.png");
    const draft = await createDraft(ticket, { db, clock });

    expect(draft).toMatchObject({
      status: "uploaded",
      data: {},
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + DRAFT_TTL_MS).toISOString(),
      ticket: {
        contentType: "image/png",
        filename: "billete.png",
        sizeBytes: PLACEHOLDER_PNG.length,
      },
    });
    // The object key is random and does not carry the draft id (the id stays in the cookie).
    expect(draft.ticket!.path).toMatch(/^drafts\/[0-9a-f-]{36}\.png$/);
    expect(draft.ticket!.path).not.toContain(draft.id);

    const r = await row(draft.id);
    expect(r).toMatchObject({
      status: "uploaded",
      ticket_path: draft.ticket!.path,
      ticket_content_type: "image/png",
      ticket_filename: "billete.png",
      ticket_size_bytes: PLACEHOLDER_PNG.length,
      data: {},
    });
    expect(Date.parse(r.expires_at as string)).toBe(NOW.getTime() + DRAFT_TTL_MS);
    expect(await stored(draft.ticket!.path)).toEqual(PLACEHOLDER_PNG);
  });

  it.each([
    ["billete.pdf", PLACEHOLDER_PDF, "application/pdf", "pdf"],
    ["IMG_0001.HEIC", PLACEHOLDER_HEIC, "image/heic", "heic"],
  ])("stores %s with its detected type", async (name, bytes, contentType, ext) => {
    const draft = await createDraft(await uploaded(bytes, name), { db, clock });
    expect(draft.ticket).toMatchObject({ contentType, filename: name });
    expect(draft.ticket!.path.endsWith(`.${ext}`)).toBe(true);
    expect(await stored(draft.ticket!.path)).toEqual(bytes);
  });

  it("anon can't read the draft row or download the ticket", async () => {
    const draft = await createDraft(await uploaded(PLACEHOLDER_PNG, "billete.png"), { db, clock });
    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } },
    );
    const rows = await anon.from("intake_drafts").select("*").eq("id", draft.id);
    expect(rows.data ?? []).toHaveLength(0);
    const object = await anon.storage.from(TICKET_BUCKET).download(draft.ticket!.path);
    expect(object.data).toBeNull();
  });
});

describe("getDraft, mergeDraftData, deleteDraft", () => {
  it("gets an unexpired draft, and nothing for an expired, unknown or malformed id", async () => {
    const draft = await createDraft(await uploaded(PLACEHOLDER_PNG, "billete.png"), { db, clock });
    expect(await getDraft(draft.id, { db, clock })).toEqual(draft);

    const later = fixedClock(new Date(NOW.getTime() + DRAFT_TTL_MS));
    expect(await getDraft(draft.id, { db, clock: later })).toBeNull();
    expect(await getDraft("6f1c2a1e-6d9b-4d0e-9a51-6f0b8f1b2c3d", { db, clock })).toBeNull();
    expect(await getDraft("not-a-uuid", { db, clock })).toBeNull();
  });

  it("merges a patch into data (top-level keys) and can move the status", async () => {
    const draft = await createDraft(await uploaded(PLACEHOLDER_PNG, "billete.png"), { db, clock });
    const first = await mergeDraftData(
      draft.id,
      { extraction: { operator: "iryo" } },
      { db, clock },
    );
    expect(first?.data).toEqual({ extraction: { operator: "iryo" } });

    const second = await mergeDraftData(
      draft.id,
      { review: { confirmed: true } },
      { status: "uploaded", db, clock },
    );
    expect(second?.data).toEqual({
      extraction: { operator: "iryo" },
      review: { confirmed: true },
    });
    expect(second?.status).toBe("uploaded");
    expect((await row(draft.id)).data).toEqual(second?.data);

    const later = fixedClock(new Date(NOW.getTime() + DRAFT_TTL_MS + 1));
    expect(await mergeDraftData(draft.id, { late: true }, { db, clock: later })).toBeNull();
  });

  it("deletes the row and the stored ticket", async () => {
    const draft = await createDraft(await uploaded(PLACEHOLDER_PNG, "billete.png"), { db, clock });
    await deleteDraft(draft.id, { db });
    expect(await row(draft.id)).toBeUndefined();
    expect(await stored(draft.ticket!.path)).toBeNull();
  });

  it("previews an image through a short-lived signed URL, and a PDF by name only", async () => {
    const png = await createDraft(await uploaded(PLACEHOLDER_PNG, "billete.png"), { db, clock });
    const image = await ticketPreview(png, { db });
    expect(image).toMatchObject({
      key: ticketVersion(png),
      filename: "billete.png",
      typeLabel: "PNG",
      sizeBytes: PLACEHOLDER_PNG.length,
    });
    // The key handed to the browser is opaque: neither the storage key nor the draft id.
    expect(image!.key).toMatch(/^[0-9a-f]{16}$/);
    for (const secret of [png.id, png.ticket!.path, png.ticket!.path.slice(7, 43)]) {
      expect(image!.key).not.toContain(secret);
    }
    expect(image?.imageUrl).toMatch(/\/storage\/v1\/object\/sign\/tickets\//);
    const res = await fetch(image!.imageUrl!);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PLACEHOLDER_PNG);

    const pdf = await createDraft(await uploaded(PLACEHOLDER_PDF, "billete.pdf"), { db, clock });
    expect(await ticketPreview(pdf, { db })).toMatchObject({ typeLabel: "PDF", imageUrl: null });
  });
});

describe("the draft session (cookie)", () => {
  it("startDraft sets the httpOnly cookie, and getCurrentDraft reads it back", async () => {
    const { jar, sets } = memoryJar();
    const ticket = await uploaded(PLACEHOLDER_PNG, "billete.png");
    const draft = await startDraft(ticket, { db, clock, jar, host: "127.0.0.1:3200" });

    expect(sets).toEqual([
      {
        name: DRAFT_COOKIE,
        value: draft.id,
        options: {
          httpOnly: true,
          sameSite: "lax",
          secure: false,
          path: "/reclamar",
          maxAge: DRAFT_TTL_MS / 1000,
        },
      },
    ]);
    expect(await getCurrentDraft({ db, clock, jar })).toEqual(draft);
  });

  it("a new upload replaces the previous draft and deletes its ticket", async () => {
    const { jar } = memoryJar();
    const first = await startDraft(await uploaded(PLACEHOLDER_PNG, "a.png"), { db, clock, jar });
    const second = await startDraft(await uploaded(PLACEHOLDER_PDF, "b.pdf"), { db, clock, jar });

    expect(second.id).not.toBe(first.id);
    expect(await getCurrentDraft({ db, clock, jar })).toEqual(second);
    expect(await row(first.id)).toBeUndefined();
    expect(await stored(first.ticket!.path)).toBeNull();
  });

  it("getCurrentDraft is null without a cookie, with a bad one, or once expired", async () => {
    expect(await getCurrentDraft({ db, clock, jar: memoryJar().jar })).toBeNull();
    expect(await getCurrentDraft({ db, clock, jar: memoryJar("nope").jar })).toBeNull();

    const { jar } = memoryJar();
    await startDraft(await uploaded(PLACEHOLDER_PNG, "a.png"), { db, clock, jar });
    const later = fixedClock(new Date(NOW.getTime() + DRAFT_TTL_MS));
    expect(await getCurrentDraft({ db, clock: later, jar })).toBeNull();
  });

  it("requireDraft returns the draft, or redirects to the upload step", async () => {
    const { jar } = memoryJar();
    const draft = await startDraft(await uploaded(PLACEHOLDER_PNG, "a.png"), { db, clock, jar });
    expect(await requireDraft({ db, clock, jar })).toEqual(draft);

    await expect(requireDraft({ db, clock, jar: memoryJar().jar })).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_REDIRECT;replace;\/reclamar\/foto;/),
    });
  });

  it("updateCurrentDraft merges into the current draft, or redirects without one", async () => {
    const { jar } = memoryJar();
    const draft = await startDraft(await uploaded(PLACEHOLDER_PNG, "a.png"), { db, clock, jar });
    const updated = await updateCurrentDraft({ answers: { email: "x" } }, { db, clock, jar });
    expect(updated.id).toBe(draft.id);
    expect(updated.data).toEqual({ answers: { email: "x" } });

    await expect(
      updateCurrentDraft({ answers: {} }, { db, clock, jar: memoryJar().jar }),
    ).rejects.toMatchObject({ digest: expect.stringContaining("/reclamar/foto") });
  });
});
