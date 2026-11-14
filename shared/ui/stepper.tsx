import Link from "next/link";
import type { StepStatus } from "./stepper-state";
import styles from "./stepper.module.css";

export interface StepperItem {
  id: string;
  label: string;
  status: StepStatus;
  /** Makes the step a link back. Leave it out for steps the user must not jump to. */
  href?: string;
}

export interface StepperProps {
  items: readonly StepperItem[];
  /** Accessible name of the navigation landmark. */
  label: string;
}

/**
 * Progress through a flow, drawn as stations on a line. The current step carries
 * `aria-current="step"`; on phones only the summary line names it, on wider screens every station
 * shows its label.
 */
export function Stepper({ items, label }: StepperProps) {
  const currentIndex = items.findIndex((item) => item.status === "current");
  const current = items[currentIndex];

  return (
    <nav aria-label={label} className={styles.stepper}>
      {current && (
        <p className={styles.summary}>
          Paso {currentIndex + 1} de {items.length}
          <span className={styles.summaryLabel}>
            <span aria-hidden="true"> · </span>
            {current.label}
          </span>
        </p>
      )}
      <ol className={styles.track}>
        {items.map((item) => {
          const content = (
            <>
              <span className={styles.dot} aria-hidden="true" />
              <span className={styles.label}>{item.label}</span>
              {item.status === "complete" && <span className="visually-hidden">, completado</span>}
            </>
          );
          return (
            <li
              key={item.id}
              className={`${styles.step} ${styles[item.status]}`}
              aria-current={item.status === "current" ? "step" : undefined}
            >
              {item.href ? (
                <Link href={item.href} className={styles.station}>
                  {content}
                </Link>
              ) : (
                <span className={styles.station}>{content}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
