import { z } from "zod";
import {
  IntakeSubmission,
  SubmittedTicket,
  UserAnswers,
  type ConsentRef,
} from "@/shared/contracts";
import type { IntakeDraft } from "../draft/store";
import type { IntakeStepId } from "../steps";

/** What is missing from a draft that someone tries to submit, and the step that fixes it. */
export type SubmissionError =
  | { ok: false; reason: "ticket_missing"; step: Extract<IntakeStepId, "foto"> }
  | { ok: false; reason: "review_invalid"; step: Extract<IntakeStepId, "revision"> }
  | { ok: false; reason: "answers_invalid"; step: Extract<IntakeStepId, "preguntas"> }
  | { ok: false; reason: "consent_missing"; step: Extract<IntakeStepId, "mandato"> };

export type DraftToSubmissionResult = { ok: true; submission: IntakeSubmission } | SubmissionError;

/** `data.review` as the review step ([A4]) stores it: the ticket the user confirmed. */
const Review = z.object({
  ticket: SubmittedTicket,
  bookingRefConfirmed: z.literal(true),
});

/**
 * The claims engine's input from a draft and its consent ([A7]). Pure: reads only what it is
 * given, validates every part with the contract's schema and never throws on what a user stored.
 * The first missing part, in the order of the flow, comes back as a typed error that names the
 * step to send the user to.
 *
 * `options.ticketPath` is where the ticket file lives for the case (the submit step moves it out
 * of `drafts/`); it defaults to the draft's own path.
 */
export function draftToSubmission(
  draft: IntakeDraft,
  consent: ConsentRef | null,
  options: { ticketPath?: string } = {},
): DraftToSubmissionResult {
  if (!draft.ticket) return { ok: false, reason: "ticket_missing", step: "foto" };

  const review = Review.safeParse(draft.data.review);
  if (!review.success) return { ok: false, reason: "review_invalid", step: "revision" };

  const answers = UserAnswers.safeParse(draft.data.answers);
  if (!answers.success) return { ok: false, reason: "answers_invalid", step: "preguntas" };

  if (!consent) return { ok: false, reason: "consent_missing", step: "mandato" };

  const submission = IntakeSubmission.safeParse({
    draftId: draft.id,
    ticketPath: options.ticketPath ?? draft.ticket.path,
    ticket: review.data.ticket,
    answers: answers.data,
    consent,
  });
  // Every part parsed on its own; only a consent that is not a valid ConsentRef gets here.
  if (!submission.success) return { ok: false, reason: "consent_missing", step: "mandato" };
  return { ok: true, submission: submission.data };
}
