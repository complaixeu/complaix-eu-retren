import Link from "next/link";
import { INTAKE_STEPS, intakeStepHref, intakeStepperItems } from "@/features/intake";
import { IntakeStepper } from "./_components/intake-stepper";
import styles from "./_components/intake.module.css";

// Computed here, on the server, so the client stepper never imports the intake domain.
const stepperItemsByPath = Object.fromEntries(
  INTAKE_STEPS.map((step) => [intakeStepHref(step.id), intakeStepperItems(step.id)]),
);

/** Shell of every intake step: wordmark, stepper at the top, the step's card below. */
export default function IntakeLayout({ children }: LayoutProps<"/reclamar">) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" className={styles.wordmark}>
          ReTren
        </Link>
      </header>
      <main id="contenido" tabIndex={-1} className={styles.main}>
        <IntakeStepper itemsByPath={stepperItemsByPath} />
        <div className={styles.card}>{children}</div>
      </main>
    </div>
  );
}
