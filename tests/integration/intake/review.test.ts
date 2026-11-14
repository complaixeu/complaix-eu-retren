import { beforeAll, describe, expect, it } from "vitest";
import type { DraftCookieJar } from "@/features/intake/draft/cookie";
import { startDraft } from "@/features/intake/draft/session";
import { getDraft, mergeDraftData } from "@/features/intake/draft/store";
import { readReview } from "@/features/intake/review/read";
import { submitReview } from "@/features/intake/review/submit";
import { readTicketUpload } from "@/features/intake/upload/read";
import { fixedClock } from "@/shared/clock";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { waitForDb } from "../../fixtures/claims/db-ready";
import { fullTicket, partialExtraction, reviewForm } from "../../fixtures/intake/extraction";
import { PLACEHOLDER_PNG } from "../../fixtures/intake/tickets";

// [A4] The review action against the local Supabase: a valid review is stored in the current
// draft as `data.review` (next to the extraction it came from); an invalid one stores nothing.
const NOW = new Date("2026-03-20T11:00:00.000Z");
const clock = fixedClock(NOW);
let db: ServiceClient;

beforeAll(async () => {
  db = createServiceClient();
  await waitForDb(db);
});

function memoryJar(): DraftCookieJar {
  const values = new Map<string, string>();
  return {
    get: (name) => (values.has(name) ? { name, value: values.get(name)! } : undefined),
    set: (name, value) => void values.set(name, value),
  };
}

async function draftWithExtraction() {
  const jar = memoryJar();
  const read = await readTicketUpload(new File([Buffer.from(PLACEHOLDER_PNG)], "billete.png"));
  if (!read.ok) throw new Error("placeholder refused");
  const draft = await startDraft(read.ticket, { db, clock, jar });
  await mergeDraftData(draft.id, { extraction: partialExtraction }, { db, clock });
  return { jar, id: draft.id };
}

describe("submitReview (local Supabase)", () => {
  it("stores the reviewed ticket as data.review and keeps the extraction", async () => {
    const { jar, id } = await draftWithExtraction();
    const result = await submitReview(reviewForm({ origin: "Estación Corregida" }), {
      db,
      clock,
      jar,
    });
    expect(result.ok).toBe(true);

    const stored = await getDraft(id, { db, clock });
    expect(stored?.data).toEqual({
      extraction: partialExtraction,
      review: {
        ticket: { ...fullTicket, origin: "Estación Corregida" },
        bookingRefConfirmed: true,
        reviewedAt: NOW.toISOString(),
      },
    });
    // The status is not this step's to move.
    expect(stored?.status).toBe("uploaded");
    // What the page shows on the way back.
    expect(readReview(stored!.data)).toMatchObject({
      source: "review",
      ticket: { origin: "Estación Corregida" },
    });
  });

  it("stores nothing when the review is invalid or the localizador isn't confirmed", async () => {
    const { jar, id } = await draftWithExtraction();
    const invalid = await submitReview(
      reviewForm({ scheduledDeparture: "12:00", scheduledArrival: "12:00" }),
      { db, clock, jar },
    );
    expect(invalid).toMatchObject({
      ok: false,
      errors: { scheduledArrival: "same_time" },
    });
    const unconfirmed = await submitReview(reviewForm({ bookingRefConfirmed: null }), {
      db,
      clock,
      jar,
    });
    expect(unconfirmed).toMatchObject({
      ok: false,
      errors: { bookingRefConfirmed: "unconfirmed" },
    });

    const stored = await getDraft(id, { db, clock });
    expect(stored?.data).toEqual({ extraction: partialExtraction });
  });

  it("a second review replaces the first", async () => {
    const { jar, id } = await draftWithExtraction();
    await submitReview(reviewForm(), { db, clock, jar });
    const later = fixedClock(new Date(NOW.getTime() + 60_000));
    await submitReview(reviewForm({ bookingRef: "ZZZ999" }), { db, clock: later, jar });

    const review = (await getDraft(id, { db, clock }))?.data.review as Record<string, unknown>;
    expect(review).toMatchObject({
      ticket: { bookingRef: "ZZZ999" },
      reviewedAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
  });

  it("redirects to the upload step without a current draft", async () => {
    await expect(submitReview(reviewForm(), { db, clock, jar: memoryJar() })).rejects.toMatchObject(
      { digest: expect.stringContaining("/reclamar/foto") },
    );
  });

  it("checks for a draft before the form: invalid input without a draft redirects too", async () => {
    // No draft, no validation: the form's contents (and their errors) are never looked at.
    await expect(
      submitReview(reviewForm({ origin: "", bookingRefConfirmed: null }), {
        db,
        clock,
        jar: memoryJar(),
      }),
    ).rejects.toMatchObject({ digest: expect.stringContaining("/reclamar/foto") });
  });

  it("stores an arrival after midnight as the times given", async () => {
    const { jar, id } = await draftWithExtraction();
    const result = await submitReview(
      reviewForm({ scheduledDeparture: "23:10", scheduledArrival: "01:40" }),
      { db, clock, jar },
    );
    expect(result.ok).toBe(true);
    const review = (await getDraft(id, { db, clock }))?.data.review as Record<string, unknown>;
    expect(review.ticket).toMatchObject({ scheduledDeparture: "23:10", scheduledArrival: "01:40" });
  });
});
