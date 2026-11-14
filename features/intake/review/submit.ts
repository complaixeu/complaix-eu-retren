import { redirect } from "next/navigation";
import { systemClock } from "@/shared/clock";
import { intakeStepHref } from "../steps";
import { requireDraft, type DraftSessionDeps } from "../draft/session";
import { mergeDraftData, type IntakeDraft } from "../draft/store";
import type { ReviewErrors, ReviewWarnings } from "./fields";
import type { StoredReview } from "./read";
import { validateReview, type ReviewValues } from "./validate";

export type ReviewSubmitResult =
  | { ok: true; draft: IntakeDraft }
  | { ok: false; values: ReviewValues; errors: ReviewErrors; warnings: ReviewWarnings };

/**
 * Server actions only. Without a current draft it redirects to the upload step before reading
 * the form at all. Otherwise it checks the review form and, if it is valid, stores it in that
 * draft as `data.review` (the extraction stays as it was). Nothing is stored when it is invalid.
 */
export async function submitReview(
  form: Pick<FormData, "get">,
  deps: DraftSessionDeps = {},
): Promise<ReviewSubmitResult> {
  const draft = await requireDraft(deps);
  const now = (deps.clock ?? systemClock).now();
  const checked = validateReview(form, { now });
  if (!checked.ok) return checked;

  const review: StoredReview = {
    ticket: checked.ticket,
    bookingRefConfirmed: true,
    reviewedAt: now.toISOString(),
  };
  const updated = await mergeDraftData(draft.id, { review }, deps);
  // The draft expired between the check and the write.
  if (!updated) redirect(intakeStepHref("foto"));
  return { ok: true, draft: updated };
}
