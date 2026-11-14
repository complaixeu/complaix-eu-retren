import type { Metadata } from "next";
import { Suspense } from "react";
import { intakeStepHref, intakeStepNeighbours, requireDraft } from "@/features/intake";
import { StepPage, stepTitle } from "../_components/step-page";
import { saveAnswers } from "./actions";
import { QuestionsForm } from "./questions-form";

export const metadata: Metadata = stepTitle("preguntas");

export default function PreguntasPage() {
  return (
    <Suspense>
      <QuestionsStep />
    </Suspense>
  );
}

async function QuestionsStep() {
  const draft = await requireDraft();
  const data = draft.data.answers as Record<string, unknown> | undefined;
  const previous = data?.previousClaim as Record<string, unknown> | undefined;
  const saved = {
    documentType: String(data?.documentType ?? "dni"),
    documentNumber: String(data?.documentNumber ?? ""),
    email: String(data?.email ?? ""),
    arrivalDate: String((data?.actualArrival as Record<string, unknown> | undefined)?.date ?? ""),
    arrivalTime: String((data?.actualArrival as Record<string, unknown> | undefined)?.time ?? ""),
    previousClaim: previous?.made === true ? "yes" : "no",
    claimDate: String(previous?.date ?? ""),
    claimRecipient: String(previous?.recipient ?? ""),
    claimMeans: String(previous?.means ?? ""),
    paymentPreference: String(data?.paymentPreference ?? "money"),
  };
  const { previous: prev } = intakeStepNeighbours("preguntas");
  return (
    <StepPage step="preguntas">
      <QuestionsForm action={saveAnswers} saved={saved} backHref={intakeStepHref(prev!)} />
    </StepPage>
  );
}
