import type { Metadata } from "next";
import { Suspense } from "react";
import {
  getCurrentDraft,
  intakeStepHref,
  intakeStepNeighbours,
  ticketPreview,
  ticketUploadRules,
} from "@/features/intake";
import { StepPage, stepTitle } from "../_components/step-page";
import styles from "../_components/intake.module.css";
import { uploadTicket } from "./actions";
import { TicketUpload } from "./ticket-upload";

export const metadata: Metadata = stepTitle("foto");

export default function FotoPage() {
  return (
    <>
      <StepPage step="foto">
        <p className={styles.lead}>
          Haz una foto al billete o sube el PDF que te envió la compañía. Leemos los datos por ti y
          después los revisas.
        </p>
      </StepPage>
      {/* The draft comes from the request's cookie, so this part renders at request time. */}
      <Suspense>
        <TicketStep />
      </Suspense>
    </>
  );
}

async function TicketStep() {
  const draft = await getCurrentDraft();
  const ticket = draft ? await ticketPreview(draft) : null;
  const next = intakeStepNeighbours("foto").next!;
  return (
    <TicketUpload
      action={uploadTicket}
      rules={ticketUploadRules}
      ticket={ticket}
      continueHref={intakeStepHref(next)}
    />
  );
}
