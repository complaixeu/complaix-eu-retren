"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { Alert, Button, ButtonLink, Checkbox, Fieldset, focusFirstInvalid } from "@/shared/ui";
import intake from "../_components/intake.module.css";
import {
  CONSENT_BOXES,
  uncheckedBoxes,
  type ConsentBox,
  type ConsentBoxTexts,
  type ConsentFormState,
} from "./consent-state";
import styles from "./mandato.module.css";

export interface ConsentFormProps {
  action: (state: ConsentFormState, formData: FormData) => Promise<ConsentFormState>;
  boxes: ConsentBoxTexts;
  backHref: string;
}

const IDLE: ConsentFormState = { status: "idle" };

/**
 * The two separate acceptances and the submit button. The browser checks the boxes first so
 * the user gets the errors at once; the server checks again and is the one that decides.
 */
export function ConsentForm({ action, boxes, backHref }: ConsentFormProps) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const [checked, setChecked] = useState<Record<ConsentBox, boolean>>({
    mandate: false,
    privacy: false,
  });
  // Boxes flagged by a submit the browser stopped.
  const [flagged, setFlagged] = useState<ConsentBox[]>([]);
  const formRef = useRef<HTMLFormElement>(null);

  // After the server refused (also without JavaScript): move to the first box to fix.
  useEffect(() => {
    if (state.status === "missing" && formRef.current) focusFirstInvalid(formRef.current);
  }, [state]);

  // Boxes the user has touched since the server last answered: their server error is gone.
  const [touched, setTouched] = useState<ConsentBox[]>([]);
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    setTouched([]);
  }

  // Flagged by the browser while unchecked, or refused by the server until the user touches the
  // box again. The server reads the posted form, so its answer wins over the local state.
  const refused = state.status === "missing" ? state.missing : [];
  const invalid = CONSENT_BOXES.filter(
    (box) =>
      (flagged.includes(box) && !checked[box]) || (refused.includes(box) && !touched.includes(box)),
  );

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const missing = uncheckedBoxes(checked);
    if (missing.length === 0) return;
    event.preventDefault();
    flushSync(() => setFlagged(missing));
    focusFirstInvalid(event.currentTarget);
  }

  return (
    <form ref={formRef} action={formAction} onSubmit={onSubmit} noValidate className={styles.form}>
      {invalid.length > 0 && (
        <Alert tone="error" title="Falta tu aceptación">
          {invalid.length === 2
            ? "Marca las dos casillas para enviar la reclamación."
            : "Marca la casilla que falta para enviar la reclamación."}
        </Alert>
      )}
      {state.status === "failed" && (
        <Alert tone="error" title="No se ha guardado tu aceptación">
          Ha fallado algo por nuestra parte. Vuelve a intentarlo en unos minutos.
        </Alert>
      )}
      <Fieldset legend="Tu aceptación">
        {CONSENT_BOXES.map((box) => (
          <Checkbox
            key={box}
            name={box}
            label={boxes[box].label}
            checked={checked[box]}
            aria-required="true"
            error={invalid.includes(box) ? boxes[box].error : undefined}
            onChange={(event) => {
              const value = event.currentTarget.checked;
              setChecked((current) => ({ ...current, [box]: value }));
              setTouched((current) => (current.includes(box) ? current : [...current, box]));
            }}
          />
        ))}
      </Fieldset>
      <div className={intake.actions}>
        <Button type="submit" pending={pending}>
          Aceptar y enviar
        </Button>
        <ButtonLink href={backHref} variant="quiet">
          Atrás
        </ButtonLink>
      </div>
    </form>
  );
}
