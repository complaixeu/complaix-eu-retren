import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { purgeExpiredDrafts } from "@/features/intake/draft/purge";
import { DRAFT_TTL_MS, TICKET_BUCKET, createDraft } from "@/features/intake/draft/store";
import { UPLOAD_PREFIX } from "@/features/intake/upload/direct";
import { readTicketUpload } from "@/features/intake/upload/read";
import { fixedClock } from "@/shared/clock";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { waitForDb } from "../../fixtures/claims/db-ready";
import { PLACEHOLDER_PNG } from "../../fixtures/intake/tickets";

// [A1 follow-up] purgeExpiredDrafts: expired drafts go with their tickets, and so do objects
// under drafts/ or uploads/ older than the TTL that no draft points at. Nothing schedules it yet.
const MINUTE = 60_000;
let db: ServiceClient;

beforeAll(async () => {
  db = createServiceClient();
  await waitForDb(db);
});

async function draftAt(at: number) {
  const read = await readTicketUpload(new File([Buffer.from(PLACEHOLDER_PNG)], "billete.png"));
  if (!read.ok) throw new Error(read.error);
  return createDraft(read.ticket, { db, clock: fixedClock(new Date(at)) });
}

async function orphan(prefix: string) {
  const path = `${prefix}${randomUUID()}${prefix === UPLOAD_PREFIX ? "" : ".png"}`;
  const up = await db.storage
    .from(TICKET_BUCKET)
    .upload(path, PLACEHOLDER_PNG, { contentType: "image/png" });
  if (up.error) throw up.error;
  return path;
}

async function rowExists(id: string) {
  const { data } = await db
    .from("intake_drafts" as never)
    .select("id")
    .eq("id", id);
  return (data as unknown[]).length > 0;
}

async function objectExists(path: string) {
  return (await db.storage.from(TICKET_BUCKET).exists(path)).data === true;
}

describe("purgeExpiredDrafts (local Supabase)", () => {
  it("deletes expired drafts and their tickets, and keeps live ones", async () => {
    const now = Date.now();
    const expired = await draftAt(now - DRAFT_TTL_MS - MINUTE);
    const live = await draftAt(now);

    const out = await purgeExpiredDrafts(new Date(now), { db });
    expect(out.drafts).toBeGreaterThanOrEqual(1);

    expect(await rowExists(expired.id)).toBe(false);
    expect(await objectExists(expired.ticket!.path)).toBe(false);
    expect(await rowExists(live.id)).toBe(true);
    expect(await objectExists(live.ticket!.path)).toBe(true);
  });

  it("deletes orphan objects older than the TTL, under drafts/ and uploads/", async () => {
    const draftsOrphan = await orphan("drafts/");
    const stagedOrphan = await orphan(UPLOAD_PREFIX);
    // A draft that is still live at purge time, whose object is already older than the TTL.
    const later = Date.now() + DRAFT_TTL_MS + MINUTE;
    const live = await draftAt(later - MINUTE);

    // Right now they are fresh: kept.
    await purgeExpiredDrafts(new Date(), { db });
    expect(await objectExists(draftsOrphan)).toBe(true);
    expect(await objectExists(stagedOrphan)).toBe(true);

    const out = await purgeExpiredDrafts(new Date(later), { db });
    expect(out.objects).toBeGreaterThanOrEqual(2);
    expect(await objectExists(draftsOrphan)).toBe(false);
    expect(await objectExists(stagedOrphan)).toBe(false);
    expect(await rowExists(live.id)).toBe(true);
    expect(await objectExists(live.ticket!.path)).toBe(true);
  });

  it("leaves objects outside drafts/ and uploads/ alone", async () => {
    const other = `test-a1/${randomUUID()}.png`;
    await db.storage
      .from(TICKET_BUCKET)
      .upload(other, PLACEHOLDER_PNG, { contentType: "image/png" });
    await purgeExpiredDrafts(new Date(Date.now() + 2 * DRAFT_TTL_MS), { db });
    expect(await objectExists(other)).toBe(true);
    await db.storage.from(TICKET_BUCKET).remove([other]);
  });
});
