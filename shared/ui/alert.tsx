import type { ReactNode } from "react";
import styles from "./alert.module.css";

export type AlertTone = "info" | "success" | "warning" | "error";

export interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  children: ReactNode;
}

// An error interrupts (role="alert"); success and warning are announced politely; info is static.
const roles: Record<AlertTone, "alert" | "status" | undefined> = {
  error: "alert",
  success: "status",
  warning: "status",
  info: undefined,
};

/** A message box. Say what happened and what to do next. */
export function Alert({ tone = "info", title, children }: AlertProps) {
  return (
    <div role={roles[tone]} className={`${styles.alert} ${styles[tone]}`}>
      {title != null && <p className={styles.title}>{title}</p>}
      <div className={styles.body}>{children}</div>
    </div>
  );
}
