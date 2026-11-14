import type { Metadata } from "next";
import { PendingNotice } from "../_components/pending-notice";
import { StepActions, StepPage, stepTitle } from "../_components/step-page";
import styles from "../_components/intake.module.css";

export const metadata: Metadata = stepTitle("mandato");

export default function MandatoPage() {
  return (
    <>
      <StepPage step="mandato">
        <p className={styles.lead}>
          Para reclamar en tu nombre necesitamos tu autorización. Lee el texto y acéptalo para
          enviar la reclamación.
        </p>
        <PendingNotice />
      </StepPage>
      <StepActions step="mandato" />
    </>
  );
}
