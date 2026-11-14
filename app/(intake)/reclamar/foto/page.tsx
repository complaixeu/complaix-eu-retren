import type { Metadata } from "next";
import { Suspense } from "react";
import {
  getCurrentDraft,
  intakeStepHref,
  intakeStepNeighbours,
  photoReading,
  ticketPreview,
  ticketUploadRules,
} from "@/features/intake";
import { StepPage, stepTitle } from "../_components/step-page";
import styles from "../_components/intake.module.css";
import { beginUpload, finishUpload, readTicket } from "./actions";
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
  const reading = draft?.ticket ? photoReading(draft.data, draft.ticket.contentType) : null;
  const next = intakeStepNeighbours("foto").next!;
  return (
    <TicketUpload
      begin={beginUpload}
      finish={finishUpload}
      read={readTicket}
      rules={ticketUploadRules}
      ticket={ticket}
      reading={reading}
      continueHref={intakeStepHref(next)}
    />
  );
}
