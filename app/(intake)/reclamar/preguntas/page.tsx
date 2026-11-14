import type { Metadata } from "next";
import { PendingNotice } from "../_components/pending-notice";
import { StepActions, StepPage, stepTitle } from "../_components/step-page";
import styles from "../_components/intake.module.css";

export const metadata: Metadata = stepTitle("preguntas");

export default function PreguntasPage() {
  return (
    <>
      <StepPage step="preguntas">
        <p className={styles.lead}>
          Tu documento de identidad, tu email, la hora real a la que llegaste y poco más. Lo que ya
          sale en el billete no te lo preguntamos.
        </p>
        <PendingNotice />
      </StepPage>
      <StepActions step="preguntas" />
    </>
  );
}
