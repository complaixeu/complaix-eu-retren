import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import {
  currentResult,
  describeResult,
  draftToSubmission,
  getCurrentDraft,
  intakeStepHref,
  latestConsent,
  toConsentRef,
} from "@/features/intake";
import { StepActions, StepPage, stepTitle } from "../_components/step-page";
import { submitClaim } from "./actions";
import { MissingScreen, ReadyScreen, ResultScreen } from "./screens";

export const metadata: Metadata = stepTitle("enviado");

export default function EnviadoPage({ searchParams }: PageProps<"/reclamar/enviado">) {
  return (
    <>
      <StepPage step="enviado">
        {/* The draft and the result come from the request's cookies: request time only. */}
        <Suspense>
          <Outcome searchParams={searchParams} />
        </Suspense>
      </StepPage>
      <StepActions step="enviado" />
    </>
  );
}

/**
 * A draft that is still there comes first (a new claim after a finished one): it is either
 * waiting to be sent or missing a step. Without one, the result of the last submission, which
 * the cookie keeps so a reload shows it again; without that, back to the upload.
 */
async function Outcome({
  searchParams,
}: {
  searchParams: PageProps<"/reclamar/enviado">["searchParams"];
}) {
  const draft = await getCurrentDraft();
  if (!draft) {
    const result = await currentResult();
    if (!result) redirect(intakeStepHref("foto"));
    return <ResultScreen view={describeResult(result)} />;
  }

  const consent = await latestConsent(draft.id);
  const check = draftToSubmission(draft, consent && toConsentRef(consent));
  if (!check.ok) return <MissingScreen reason={check.reason} href={intakeStepHref(check.step)} />;

  const { aviso } = await searchParams;
  return (
    <ReadyScreen
      action={submitClaim}
      notice={aviso === "fallo" || aviso === "ocupado" ? aviso : null}
    />
  );
}
