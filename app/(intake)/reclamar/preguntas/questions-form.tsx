"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  ButtonLink,
  Field,
  Fieldset,
  FormCompletion,
  Input,
  Radio,
  focusFirstInvalid,
} from "@/shared/ui";
import type { AnswersState } from "./actions";
import styles from "./questions.module.css";

type Saved = {
  documentType: string;
  documentNumber: string;
  email: string;
  arrivalDate: string;
  arrivalTime: string;
  previousClaim: string;
  claimDate: string;
  claimRecipient: string;
  claimMeans: string;
  paymentPreference: string;
};
const empty: Saved = {
  documentType: "dni",
  documentNumber: "",
  email: "",
  arrivalDate: "",
  arrivalTime: "",
  previousClaim: "no",
  claimDate: "",
  claimRecipient: "",
  claimMeans: "",
  paymentPreference: "money",
};

export function QuestionsForm({
  action,
  saved,
  backHref,
}: {
  action: (state: AnswersState, formData: FormData) => Promise<AnswersState>;
  saved: Saved;
  backHref: string;
}) {
  const [state, submit, pending] = useActionState(action, { status: "idle" } as AnswersState);
  const form = useRef<HTMLFormElement>(null);
  const [previousClaim, setPreviousClaim] = useState(saved.previousClaim);
  useEffect(() => {
    if (state.status === "error" && form.current) focusFirstInvalid(form.current);
  }, [state]);
  const errors = state.status === "error" ? state.errors : {};
  const value = { ...empty, ...saved };
  const field = (name: string, label: string, type = "text", autocomplete?: string) => (
    <Field label={label} error={errors[name]} key={name}>
      {(control) => (
        <Input
          {...control}
          name={name}
          type={type}
          defaultValue={value[name as keyof Saved]}
          autoComplete={autocomplete}
          required
        />
      )}
    </Field>
  );
  return (
    <form ref={form} action={submit} className={styles.form} noValidate>
      {state.status === "error" && (
        <Alert tone="error" title="Revisa tus respuestas">
          Corrige los campos indicados y vuelve a continuar.
        </Alert>
      )}
      <FormCompletion formRef={form} label="Tus respuestas" />
      <section className={styles.section} aria-labelledby="identidad">
        <h2 id="identidad">Tus datos</h2>
        <Fieldset legend="Tipo de documento" error={errors.documentType}>
          {[
            ["dni", "DNI"],
            ["nie", "NIE"],
            ["passport", "Pasaporte"],
          ].map(([v, label]) => (
            <Radio
              key={v}
              name="documentType"
              value={v}
              label={label}
              required
              defaultChecked={value.documentType === v}
            />
          ))}
        </Fieldset>
        {field("documentNumber", "Número de documento", "text", "off")}
        {field("email", "Email", "email", "email")}
      </section>
      <section className={styles.section} aria-labelledby="llegada">
        <h2 id="llegada">Tu llegada</h2>
        <p>Indica la hora a la que llegaste a tu destino.</p>
        {field("arrivalDate", "Fecha de llegada", "date")}
        {field("arrivalTime", "Hora de llegada", "time")}
      </section>
      <section className={styles.section} aria-labelledby="reclamacion">
        <h2 id="reclamacion">¿Ya reclamaste este viaje?</h2>
        <Fieldset legend="Elige una opción" error={errors.previousClaim}>
          {[
            ["no", "No"],
            ["yes", "Sí"],
          ].map(([v, label]) => (
            <Radio
              key={v}
              name="previousClaim"
              value={v}
              label={label}
              checked={previousClaim === v}
              required
              onChange={() => setPreviousClaim(v)}
            />
          ))}
        </Fieldset>
        {previousClaim === "yes" && (
          <div className={styles.conditional}>
            {field("claimDate", "Fecha de la reclamación", "date")}
            {field("claimRecipient", "A quién reclamaste")}
            {field("claimMeans", "Cómo reclamaste", "text")}
          </div>
        )}
      </section>
      <section className={styles.section}>
        <Fieldset
          legend="¿Cómo prefieres recibir la compensación?"
          error={errors.paymentPreference}
        >
          {[
            ["money", "Dinero"],
            ["voucher", "Bono de viaje"],
          ].map(([v, label]) => (
            <Radio
              key={v}
              name="paymentPreference"
              value={v}
              label={label}
              required
              defaultChecked={value.paymentPreference === v}
            />
          ))}
        </Fieldset>
      </section>
      <div className={styles.actions}>
        <Button type="submit" pending={pending}>
          Continuar
        </Button>
        <ButtonLink href={backHref} variant="quiet">
          Atrás
        </ButtonLink>
      </div>
      <p role="status" aria-live="polite" className={styles.pending}>
        {pending ? "Guardando tus respuestas…" : ""}
      </p>
    </form>
  );
}
