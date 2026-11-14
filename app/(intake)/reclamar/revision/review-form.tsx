"use client";

import { useActionState, useEffect, useRef, type ReactNode } from "react";
import {
  Alert,
  Button,
  ButtonLink,
  Checkbox,
  Field,
  Fieldset,
  Input,
  Radio,
  focusFirstInvalid,
} from "@/shared/ui";
import intake from "../_components/intake.module.css";
import styles from "./revision.module.css";
import {
  CONFIRM_VALUE,
  type ReviewFieldView,
  type ReviewFormState,
  type ReviewFormValues,
  type ReviewSectionView,
} from "./review-state";

export interface ReviewFormProps {
  action: (state: ReviewFormState, formData: FormData) => Promise<ReviewFormState>;
  sections: ReviewSectionView[];
  /** What the draft holds: the saved review, or what the extraction read. */
  values: ReviewFormValues;
  /** How many fields the extraction couldn't read (0 when typed by hand). */
  missingCount: number;
  backHref: string;
}

const IDLE: ReviewFormState = { status: "idle" };

/** Short fields that sit side by side on wide screens: each one with the field after it. */
const PAIRED_WITH_NEXT = new Set(["origin", "scheduledDeparture"]);

const MISSING_NOTE = "No aparece en el billete: escríbelo tú.";

/**
 * The review step's form. Every field is editable, the ones the extraction couldn't read are
 * marked, and the localizador needs its own confirmation. The server checks everything; on an
 * error the form comes back with what the user typed and focus moves to the first field to fix.
 * It gets everything as props and imports no domain code (tests/unit/intake/client-boundary).
 */
export function ReviewForm({ action, sections, values, missingCount, backHref }: ReviewFormProps) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const shown = state.status === "error" ? state.values : values;
  const errors = state.status === "error" ? state.errors : {};
  const attempt = state.status === "error" ? state.attempt : 0;

  useEffect(() => {
    if (state.status === "error" && formRef.current) focusFirstInvalid(formRef.current);
  }, [state]);

  // A changed localizador hasn't been checked yet.
  const unconfirm = () => {
    if (confirmRef.current) confirmRef.current.checked = false;
  };

  const renderField = (field: ReviewFieldView): ReactNode => {
    const error = errors[field.name];
    // Under an error, the error says what to do: the "missing" note would only repeat it.
    const help = helpOf(field, error != null);
    const value = shown[field.name] ?? "";

    if (field.kind === "choice") {
      return (
        <Fieldset legend={field.label} optional={!field.required} help={help} error={error}>
          {field.options?.map((option) => (
            <Radio
              key={option.value}
              name={field.name}
              value={option.value}
              label={option.label}
              defaultChecked={value === option.value}
              // The group's error is on the fieldset; this lets focus land on its first option.
              aria-invalid={error ? true : undefined}
            />
          ))}
        </Fieldset>
      );
    }

    const input = (
      <Field label={field.label} optional={!field.required} help={help} error={error}>
        {(control) => (
          <Input
            {...control}
            name={field.name}
            type={field.kind}
            defaultValue={value}
            autoComplete={field.autoComplete}
            inputMode={field.inputMode}
            aria-required={field.required || undefined}
            spellCheck={field.name === "bookingRef" ? false : undefined}
            autoCapitalize={field.name === "bookingRef" ? "characters" : undefined}
            onChange={field.name === "bookingRef" ? unconfirm : undefined}
          />
        )}
      </Field>
    );

    if (field.name !== "bookingRef") return input;
    // The one value the claim stands or falls on: the field and its confirmation, together.
    return (
      <div className={styles.check}>
        {input}
        <Checkbox
          ref={confirmRef}
          name="bookingRefConfirmed"
          value={CONFIRM_VALUE}
          label="He comprobado el localizador"
          defaultChecked={shown.bookingRefConfirmed === CONFIRM_VALUE}
          error={errors.bookingRefConfirmed}
        />
      </div>
    );
  };

  return (
    <form key={attempt} ref={formRef} action={formAction} noValidate className={styles.form}>
      {state.status === "error" ? (
        <Alert tone="error" title="Faltan datos o hay alguno que corregir">
          Corrige los datos que tienen un mensaje debajo y vuelve a pulsar Continuar.
        </Alert>
      ) : (
        missingCount > 0 && (
          <Alert>
            {missingCount === 1
              ? "Hay 1 dato que no aparece en el billete o no hemos podido leer. Está marcado abajo."
              : `Hay ${missingCount} datos que no aparecen en el billete o no hemos podido leer. Están marcados abajo.`}
          </Alert>
        )
      )}

      {sections.map((section) => (
        <section
          key={section.id}
          aria-labelledby={`seccion-${section.id}`}
          className={styles.section}
        >
          <h2 id={`seccion-${section.id}`} className={styles.heading}>
            {section.title}
          </h2>
          {rows(section.fields).map((row) => (
            <div key={row[0].name} className={row.length > 1 ? styles.pair : undefined}>
              {row.map((field) => (
                <div key={field.name} className={field.missing ? styles.missing : undefined}>
                  {renderField(field)}
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}

      <div className={intake.actions}>
        <Button type="submit" pending={pending}>
          Continuar
        </Button>
        <ButtonLink href={backHref} variant="quiet">
          Atrás
        </ButtonLink>
      </div>
    </form>
  );
}

function helpOf(field: ReviewFieldView, hasError: boolean): ReactNode {
  if (!field.missing || hasError) return field.help;
  return (
    <>
      <span className={styles.missingNote}>{MISSING_NOTE}</span>
      {field.help && <> {field.help}</>}
    </>
  );
}

/** Groups the fields into rows: paired fields share one, the rest get their own. */
function rows(fields: ReviewFieldView[]): ReviewFieldView[][] {
  const out: ReviewFieldView[][] = [];
  for (let i = 0; i < fields.length; i++) {
    const next = fields[i + 1];
    if (PAIRED_WITH_NEXT.has(fields[i].name) && next) {
      out.push([fields[i], next]);
      i++;
    } else out.push([fields[i]]);
  }
  return out;
}
