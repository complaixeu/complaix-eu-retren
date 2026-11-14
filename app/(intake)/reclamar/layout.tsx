import Link from "next/link";
import { IntakeStepper } from "./_components/intake-stepper";
import styles from "./_components/intake.module.css";

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
        <IntakeStepper />
        <div className={styles.card}>{children}</div>
      </main>
    </div>
  );
}
