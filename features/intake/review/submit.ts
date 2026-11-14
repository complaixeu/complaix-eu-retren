import { systemClock } from "@/shared/clock";
import { updateCurrentDraft, type DraftSessionDeps } from "../draft/session";
import type { IntakeDraft } from "../draft/store";
import type { ReviewErrors } from "./fields";
import type { StoredReview } from "./read";
import { validateReview, type ReviewValues } from "./validate";

export type ReviewSubmitResult =
  { ok: true; draft: IntakeDraft } | { ok: false; values: ReviewValues; errors: ReviewErrors };

/**
 * Server actions only: checks the review form and, if it is valid, stores it in the current draft
 * as `data.review` (the extraction stays as it was). Nothing is stored when it is invalid.
 * Redirects to the upload step when there is no current draft.
 */
export async function submitReview(
  form: Pick<FormData, "get">,
  deps: DraftSessionDeps = {},
): Promise<ReviewSubmitResult> {
  const now = (deps.clock ?? systemClock).now();
  const checked = validateReview(form, { now });
  if (!checked.ok) return checked;

  const review: StoredReview = {
    ticket: checked.ticket,
    bookingRefConfirmed: true,
    reviewedAt: now.toISOString(),
  };
  const draft = await updateCurrentDraft({ review }, deps);
  return { ok: true, draft };
}
