import type { Metadata } from "next";
import { PendingNotice } from "../_components/pending-notice";
import { StepActions, StepPage, stepTitle } from "../_components/step-page";
import styles from "../_components/intake.module.css";

export const metadata: Metadata = stepTitle("revision");

export default function RevisionPage() {
  return (
    <>
      <StepPage step="revision">
        <p className={styles.lead}>
          Comprueba lo que hemos leído en el billete y corrige lo que haga falta. El localizador
          tiene que estar bien: la compañía lo usa para encontrar tu viaje.
        </p>
        <PendingNotice />
      </StepPage>
      <StepActions step="revision" />
    </>
  );
}
