"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  acceptConsent,
  intakeStepHref,
  readConsentChoices,
  requireDraft,
  type AcceptConsentResult,
} from "@/features/intake";
import { submitClaim } from "../enviado/actions";
import type { ConsentFormState } from "./consent-state";

/**
 * The authorization step's form action. The server decides: without both boxes nothing is
 * stored. On success it goes to the last step; the case itself is created there ([A7]).
 */
export async function acceptMandate(
  _previous: ConsentFormState,
  formData: FormData,
): Promise<ConsentFormState> {
  const draft = await requireDraft();
  let result: AcceptConsentResult;
  try {
    result = await acceptConsent(draft, readConsentChoices(formData), {
      headers: await headers(),
    });
  } catch (error) {
    // Only the error code: never the IP or the trip.
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    console.error(`[intake] consent insert failed (${code})`);
    return { status: "failed" };
  }
  // The case is created there ([A7]); it always ends on the last step.
  if (result.ok) return submitClaim();
  if (result.reason === "not_accepted") return { status: "missing", missing: result.missing };
  redirect(intakeStepHref(result.reason === "answers_invalid" ? "preguntas" : "revision"));
}
