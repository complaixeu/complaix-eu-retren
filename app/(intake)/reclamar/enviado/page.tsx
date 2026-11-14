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
          Aquí verás si tu viaje tiene derecho a indemnización y cuándo se enviará la reclamación a
          la compañía.
        </p>
        <PendingNotice />
      </StepPage>
      <StepActions step="enviado" />
    </>
  );
}
