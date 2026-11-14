"use client";

import { useEffect, useRef } from "react";
import { Button, ButtonLink } from "@/shared/ui";
import styles from "./_components/intake.module.css";

/**
 * Shown inside the step's card (the layout and its stepper stay) when a step fails to load or a
 * form is rejected before it reaches us, e.g. a file over the hosting platform's size limit.
 * Error boundaries are client components, so this imports no domain code.
 */
export default function ReclamarError({ error, retry }: { error: unknown; retry: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // Only the digest (it matches the server log); never the error's details.
    const digest = error instanceof Error && "digest" in error ? error.digest : undefined;
    console.error("[intake] step failed", digest ?? "");
    headingRef.current?.focus();
  }, [error]);

  return (
    <>
      <h1 ref={headingRef} tabIndex={-1} className={styles.title}>
        No hemos podido seguir
      </h1>
      <div className={styles.body}>
        <p className={styles.lead}>
          Algo ha fallado al cargar o guardar este paso. Vuelve a intentarlo. Si estabas subiendo el
          billete, prueba con una foto más ligera o con el PDF del billete.
        </p>
      </div>
      <div className={styles.actions}>
        <Button variant="primary" onClick={() => retry()}>
          Volver a intentarlo
        </Button>
        <ButtonLink href="/reclamar/foto" variant="quiet">
          Volver al principio
        </ButtonLink>
      </div>
    </>
  );
}
