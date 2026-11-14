import type { Metadata } from "next";
import { PendingNotice } from "../_components/pending-notice";
import { StepActions, StepPage, stepTitle } from "../_components/step-page";
import styles from "../_components/intake.module.css";

export const metadata: Metadata = stepTitle("foto");

export default function FotoPage() {
  return (
    <>
      <StepPage step="foto">
        <p className={styles.lead}>
          Haz una foto al billete o sube el PDF que te envió la compañía. Leemos los datos por ti y
          después los revisas.
        </p>
        <PendingNotice />
      </StepPage>
      <StepActions step="foto" />
    </>
  );
}
