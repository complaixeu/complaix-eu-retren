"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/shared/ui";
import styles from "./enviado.module.css";

/** The submit button of the retry form: disabled while the request is in flight. */
export function SubmitButton({ children }: { children: string }) {
  const { pending } = useFormStatus();
  return (
    <>
      <Button type="submit" pending={pending}>
        {children}
      </Button>
      {pending && (
        <p role="status" aria-live="polite" className={styles.submitting}>
          Enviando y registrando tu reclamación…
        </p>
      )}
    </>
  );
}
