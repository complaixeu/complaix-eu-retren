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
import { MissingScreen, ReadyScreen, ReceivedScreen, ResultScreen } from "./screens";

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
  const { aviso } = await searchParams;
  const draft = await getCurrentDraft();
  if (!draft) {
    const result = await currentResult();
    if (result) return <ResultScreen view={describeResult(result)} />;
    // A submit that found the claim already made, before its result reached this browser.
    if (aviso === "recibida") return <ReceivedScreen />;
    redirect(intakeStepHref("foto"));
  }

  const consent = await latestConsent(draft.id);
  const check = draftToSubmission(draft, consent && toConsentRef(consent));
  if (!check.ok) return <MissingScreen reason={check.reason} href={intakeStepHref(check.step)} />;

  return (
    <ReadyScreen
      action={submitClaim}
      notice={aviso === "fallo" || aviso === "ocupado" ? aviso : null}
    />
  );
}
