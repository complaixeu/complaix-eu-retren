"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "@/shared/ui";
import styles from "../team.module.css";

/** Keeps team actions visibly busy and prevents duplicate submissions. */
export function ActionSubmit({
  children,
  pendingLabel,
  ...buttonProps
}: Omit<ButtonProps, "pending"> & { pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <>
      <Button {...buttonProps} type="submit" pending={pending}>
        {pending ? pendingLabel : children}
      </Button>
      {pending && (
        <p role="status" aria-live="polite" className={styles.actionStatus}>
          {pendingLabel}
        </p>
      )}
    </>
  );
}
