import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { acceptConsent } from "@/features/intake/consent/accept";
import { latestConsent, toConsentRef } from "@/features/intake/consent/store";
import { CONSENT_TEXT_VERSION } from "@/features/intake/consent/texts";
import { createDraft, deleteDraft, mergeDraftData } from "@/features/intake/draft/store";
import type { IntakeDraft } from "@/features/intake/draft/store";
import { readTicketUpload } from "@/features/intake/upload/read";
import { fixedClock } from "@/shared/clock";
import { ConsentRef } from "@/shared/contracts";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { waitForDb } from "../../fixtures/claims/db-ready";
import { ANSWERS, REVIEW, REVIEWED_TICKET } from "../../fixtures/intake/review";
import { PLACEHOLDER_PNG } from "../../fixtures/intake/tickets";

// [A6] Accepting the mandate and the privacy notice stores the evidence (time, text version, IP
// from the request headers, trip snapshot) in `consents`, against the local Supabase.
const NOW = new Date("2026-03-12T10:00:00.000Z");
const clock = fixedClock(NOW);
const BOTH = { mandate: true, privacy: true };
let db: ServiceClient;

beforeAll(async () => {
  db = createServiceClient();
  await waitForDb(db);
});

async function draftWith(data: Record<string, unknown>): Promise<IntakeDraft> {
  const read = await readTicketUpload(
    new File([Buffer.from(PLACEHOLDER_PNG)], "billete.png", { type: "image/png" }),
  );
  if (!read.ok) throw new Error("placeholder refused");
  const draft = await createDraft(read.ticket, { db, clock });
  const merged = await mergeDraftData(draft.id, data as never, { db, clock });
  return merged!;
}

async function consentRows(draftId: string) {
  const { data, error } = await db
    .from("consents" as never)
    .select("*")
    .eq("draft_id", draftId);
  expect(error).toBeNull();
  return data as Record<string, unknown>[];
}

describe("acceptConsent (local Supabase)", () => {
  it("stores the IP from x-forwarded-for, the text version, the time and the trip", async () => {
    const draft = await draftWith({ review: REVIEW });
    const result = await acceptConsent(draft, BOTH, {
      db,
      clock,
      headers: new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1", "x-real-ip": "10.0.0.9" }),
    });
    expect(result.ok).toBe(true);

    const rows = await consentRows(draft.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      draft_id: draft.id,
      text_version: CONSENT_TEXT_VERSION,
      ip: "203.0.113.7",
      trip_snapshot: { ticket: REVIEWED_TICKET },
    });
    expect(Date.parse(rows[0].accepted_at as string)).toBe(NOW.getTime());
    if (result.ok) expect(result.consent.id).toBe(rows[0].id);
  });

  it("falls back to x-real-ip", async () => {
    const draft = await draftWith({ review: REVIEW });
    await acceptConsent(draft, BOTH, {
      db,
      clock,
      headers: new Headers({ "x-real-ip": "198.51.100.23" }),
    });
    expect((await consentRows(draft.id))[0].ip).toBe("198.51.100.23");
  });

  it("stores a null IP when neither header is there", async () => {
    const draft = await draftWith({ review: REVIEW });
    await acceptConsent(draft, BOTH, { db, clock, headers: new Headers() });
    expect((await consentRows(draft.id))[0].ip).toBeNull();
  });

  it("stores an IPv6 address", async () => {
    const draft = await draftWith({ review: REVIEW });
    await acceptConsent(draft, BOTH, {
      db,
      clock,
      headers: new Headers({ "x-forwarded-for": "2001:db8::42" }),
    });
    expect((await consentRows(draft.id))[0].ip).toBe("2001:db8::42");
  });

  it("adds the claim's answers to the snapshot, never the identity ones", async () => {
    const draft = await draftWith({ review: REVIEW, answers: ANSWERS });
    await acceptConsent(draft, BOTH, { db, clock, headers: new Headers() });
    const snapshot = (await consentRows(draft.id))[0].trip_snapshot;
    expect(snapshot).toEqual({
      ticket: REVIEWED_TICKET,
      answers: {
        actualArrival: ANSWERS.actualArrival,
        previousClaim: ANSWERS.previousClaim,
        paymentPreference: ANSWERS.paymentPreference,
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(ANSWERS.documentNumber);
    expect(JSON.stringify(snapshot)).not.toContain(ANSWERS.email);
  });

  it("prefers x-vercel-forwarded-for", async () => {
    const draft = await draftWith({ review: REVIEW });
    await acceptConsent(draft, BOTH, {
      db,
      clock,
      headers: new Headers({
        "x-vercel-forwarded-for": "192.0.2.10",
        "x-forwarded-for": "203.0.113.7",
      }),
    });
    expect((await consentRows(draft.id))[0].ip).toBe("192.0.2.10");
  });

  it.each([
    [{ mandate: false, privacy: false }, ["mandate", "privacy"]],
    [{ mandate: true, privacy: false }, ["privacy"]],
    [{ mandate: false, privacy: true }, ["mandate"]],
  ])("refuses %o and stores nothing", async (choice, missing) => {
    const draft = await draftWith({ review: REVIEW });
    const result = await acceptConsent(draft, choice, {
      db,
      clock,
      headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
    });
    expect(result).toEqual({ ok: false, reason: "not_accepted", missing });
    expect(await consentRows(draft.id)).toHaveLength(0);
  });

  it("refuses a draft without a review and stores nothing", async () => {
    const draft = await draftWith({});
    const result = await acceptConsent(draft, BOTH, { db, clock, headers: new Headers() });
    expect(result).toEqual({ ok: false, reason: "review_missing" });
    expect(await consentRows(draft.id)).toHaveLength(0);
  });

  it("gives A7 the latest consent of a draft as a ConsentRef", async () => {
    const draft = await draftWith({ review: REVIEW });
    await acceptConsent(draft, BOTH, { db, clock, headers: new Headers() });
    const later = fixedClock(new Date(NOW.getTime() + 60_000));
    await acceptConsent(draft, BOTH, { db, clock: later, headers: new Headers() });

    const latest = await latestConsent(draft.id, { db });
    expect(latest?.acceptedAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    const ref = ConsentRef.parse(toConsentRef(latest!));
    expect(ref).toMatchObject({ mandateAccepted: true, gdprAccepted: true });
    expect(await latestConsent("00000000-0000-0000-0000-000000000000", { db })).toBeNull();
  });

  it("breaks a tie on accepted_at by insertion order: the newest row wins", async () => {
    const draft = await draftWith({ review: REVIEW });
    // Same fixed clock, so both rows have the same accepted_at.
    const first = await acceptConsent(draft, BOTH, { db, clock, headers: new Headers() });
    const second = await acceptConsent(draft, BOTH, { db, clock, headers: new Headers() });
    if (!first.ok || !second.ok) throw new Error("not stored");
    expect(first.consent.acceptedAt).toBe(second.consent.acceptedAt);

    for (let i = 0; i < 3; i++) {
      expect((await latestConsent(draft.id, { db }))?.id).toBe(second.consent.id);
    }
    const rows = await consentRows(draft.id);
    const created = Object.fromEntries(rows.map((r) => [r.id, Date.parse(r.created_at as string)]));
    expect(created[second.consent.id]).toBeGreaterThan(created[first.consent.id]);
  });

  it("keeps the evidence when the draft is deleted", async () => {
    const draft = await draftWith({ review: REVIEW });
    const result = await acceptConsent(draft, BOTH, { db, clock, headers: new Headers() });
    if (!result.ok) throw new Error("not stored");
    await deleteDraft(draft.id, { db });

    const { data, error } = await db
      .from("consents" as never)
      .select("*")
      .eq("id", result.consent.id);
    expect(error).toBeNull();
    expect(data).toEqual([
      expect.objectContaining({ draft_id: null, trip_snapshot: { ticket: REVIEWED_TICKET } }),
    ]);
  });

  it("anon can't read or add consents", async () => {
    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } },
    );
    const read = await anon.from("consents").select("*");
    expect(read.error).not.toBeNull();
    const insert = await anon.from("consents").insert({
      accepted_at: NOW.toISOString(),
      text_version: "x",
      trip_snapshot: {},
    });
    expect(insert.error).not.toBeNull();
  });
});
