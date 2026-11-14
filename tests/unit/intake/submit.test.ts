import { describe, expect, it } from "vitest";
import { draftToSubmission } from "@/features/intake/submit/mapping";
import { IntakeSubmission, type ConsentRef } from "@/shared/contracts";
import type { IntakeDraft } from "@/features/intake/draft/store";
import { ANSWERS, REVIEW } from "../../fixtures/intake/review";

// [A7] The pure mapping from a draft (and its consent) to the claims engine's submission. It
// never throws on what a user stored: each missing part is a typed error that names the step.

const DRAFT_ID = "6f1f3d5e-0b57-4b7e-8d51-6a0c1c1d7a10";
const CONSENT: ConsentRef = {
  consentId: "c0ffee00-0000-4000-8000-000000000001",
  mandateAccepted: true,
  gdprAccepted: true,
  textVersion: "mandato-2026-11-14-borrador-2",
  acceptedAt: "2026-03-12T10:00:00.000Z",
};
const TICKET = {
  path: "drafts/2b0d5f16-6d0c-4d5e-9a7e-0d4d5a2c9f11.png",
  contentType: "image/png" as const,
  filename: "billete.png",
  sizeBytes: 100,
};

function draft(data: Record<string, unknown>, ticket: IntakeDraft["ticket"] = TICKET): IntakeDraft {
  return {
    id: DRAFT_ID,
    createdAt: "2026-03-12T09:00:00.000Z",
    updatedAt: "2026-03-12T09:30:00.000Z",
    expiresAt: "2026-03-13T09:00:00.000Z",
    status: "uploaded",
    ticket,
    data: data as IntakeDraft["data"],
  };
}
const COMPLETE = { review: REVIEW, answers: ANSWERS };

describe("draftToSubmission", () => {
  it("builds a valid IntakeSubmission from a complete draft", () => {
    const out = draftToSubmission(draft(COMPLETE), CONSENT);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(IntakeSubmission.safeParse(out.submission).success).toBe(true);
    expect(out.submission).toMatchObject({
      draftId: DRAFT_ID,
      ticketPath: TICKET.path,
      ticket: REVIEW.ticket,
      answers: ANSWERS,
      consent: CONSENT,
    });
  });

  it("uses the ticket path it is given instead of the draft's", () => {
    const out = draftToSubmission(draft(COMPLETE), CONSENT, { ticketPath: "submitted/x.png" });
    expect(out.ok && out.submission.ticketPath).toBe("submitted/x.png");
  });

  it("keeps only the contract's fields (no extraction, no extra keys)", () => {
    const out = draftToSubmission(
      draft({
        ...COMPLETE,
        extraction: { raw: "secret ocr text" },
        ocrAttempts: 2,
        review: { ...REVIEW, ticket: { ...REVIEW.ticket, stray: "x" } },
      }),
      CONSENT,
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(JSON.stringify(out.submission)).not.toMatch(/secret|stray|ocrAttempts/);
  });

  it("asks for the upload when the draft has no ticket file", () => {
    expect(draftToSubmission(draft(COMPLETE, null), CONSENT)).toEqual({
      ok: false,
      reason: "ticket_missing",
      step: "foto",
    });
  });

  it.each([
    ["no review", { answers: ANSWERS }],
    ["a review that is not an object", { ...COMPLETE, review: "x" }],
    ["a review without a ticket", { ...COMPLETE, review: { bookingRefConfirmed: true } }],
    [
      "a ticket missing a required field",
      {
        ...COMPLETE,
        review: { ...REVIEW, ticket: { ...REVIEW.ticket, scheduledArrival: undefined } },
      },
    ],
    [
      "a booking reference nobody confirmed",
      { ...COMPLETE, review: { ...REVIEW, bookingRefConfirmed: false } },
    ],
  ])("sends you to the review for %s", (_name, data) => {
    expect(draftToSubmission(draft(data), CONSENT)).toEqual({
      ok: false,
      reason: "review_invalid",
      step: "revision",
    });
  });

  it.each([
    ["no answers", { review: REVIEW }],
    ["answers that are null", { ...COMPLETE, answers: null }],
    ["an invalid email", { ...COMPLETE, answers: { ...ANSWERS, email: "no" } }],
    ["a missing document number", { ...COMPLETE, answers: { ...ANSWERS, documentNumber: "" } }],
  ])("sends you to the questions for %s", (_name, data) => {
    expect(draftToSubmission(draft(data), CONSENT)).toEqual({
      ok: false,
      reason: "answers_invalid",
      step: "preguntas",
    });
  });

  it("sends you to the authorization when there is no consent", () => {
    expect(draftToSubmission(draft(COMPLETE), null)).toEqual({
      ok: false,
      reason: "consent_missing",
      step: "mandato",
    });
  });

  it("reports the earliest missing step first", () => {
    expect(draftToSubmission(draft({}, null), null)).toMatchObject({ step: "foto" });
    expect(draftToSubmission(draft({}), null)).toMatchObject({ step: "revision" });
    expect(draftToSubmission(draft({ review: REVIEW }), null)).toMatchObject({ step: "preguntas" });
    expect(draftToSubmission(draft(COMPLETE), null)).toMatchObject({ step: "mandato" });
  });

  it("never throws on garbage", () => {
    for (const data of [{ review: 5, answers: [] }, { review: null, answers: "x" }, {}]) {
      expect(() => draftToSubmission(draft(data), CONSENT)).not.toThrow();
    }
  });
});
