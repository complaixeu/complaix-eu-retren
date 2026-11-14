import type { Metadata } from "next";
import { PendingNotice } from "../_components/pending-notice";
import { StepActions, StepPage, stepTitle } from "../_components/step-page";
import styles from "../_components/intake.module.css";

export const metadata: Metadata = stepTitle("enviado");

export default function EnviadoPage() {
  return (
    <>
      <StepPage step="enviado">
        <p className={styles.lead}>
          Solo te escribiremos si la compañía pide algo que únicamente tienes tú, o cuando haya un
          resultado.
        </p>
        <PendingNotice />
      </StepPage>
      <StepActions step="enviado" />
    </>
  );
}
