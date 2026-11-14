import type { ReactNode } from "react";
import {
  intakeStep,
  intakeStepHref,
  intakeStepNeighbours,
  type IntakeStepId,
} from "@/features/intake";
import { ButtonLink } from "@/shared/ui";
import styles from "./intake.module.css";

/** The heading of a step (from the step list) and its content. */
export function StepPage({ step, children }: { step: IntakeStepId; children: ReactNode }) {
  return (
    <>
      <h1 className={styles.title}>{intakeStep(step).title}</h1>
      <div className={styles.body}>{children}</div>
    </>
  );
}

/**
 * Plain "Continuar" / "Atrás" links for steps that have no form yet. A step with a form replaces
 * this with its own submit button. After the last step there is no going back.
 */
export function StepActions({ step }: { step: IntakeStepId }) {
  const { previous, next } = intakeStepNeighbours(step);
  return (
    <div className={styles.actions}>
      {next ? (
        <>
          <ButtonLink href={intakeStepHref(next)}>Continuar</ButtonLink>
          {previous && (
            <ButtonLink href={intakeStepHref(previous)} variant="quiet">
              Atrás
            </ButtonLink>
          )}
        </>
      ) : (
        <ButtonLink href="/">Volver al inicio</ButtonLink>
      )}
    </div>
  );
}

/** Metadata title of a step page. */
export const stepTitle = (step: IntakeStepId) => ({ title: intakeStep(step).title });
