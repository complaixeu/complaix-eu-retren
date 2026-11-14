"use server";

import { redirect } from "next/navigation";
import {
  intakeStepHref,
  intakeStepNeighbours,
  reviewErrorMessages,
  submitReview,
} from "@/features/intake";
import type { ReviewFormState } from "./review-state";

/**
 * The review step's form action: checks the reviewed ticket on the server and stores it in the
 * draft as `data.review`, then moves on to the questions. On an error the form comes back with
 * what the user typed and a message under each field to fix.
 */
export async function saveReview(
  previous: ReviewFormState,
  formData: FormData,
): Promise<ReviewFormState> {
  const result = await submitReview(formData);
  if (!result.ok) {
    return {
      status: "error",
      attempt: previous.status === "error" ? previous.attempt + 1 : 1,
      values: result.values as Record<string, string>,
      errors: reviewErrorMessages(result.errors) as Record<string, string>,
    };
  }
  redirect(intakeStepHref(intakeStepNeighbours("revision").next!));
}
