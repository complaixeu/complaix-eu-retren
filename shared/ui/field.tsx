import { useId, type ComponentProps, type ReactNode } from "react";
import { fieldAria } from "./field-aria";
import styles from "./field.module.css";

/** Props a `Field` hands to its control so the label, help and error are wired up. */
export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
}

export interface FieldProps {
  label: ReactNode;
  /** Shown under the control. */
  help?: ReactNode;
  /** Shown in red right under the control; also marks it `aria-invalid`. */
  error?: ReactNode;
  /** Adds "(opcional)" to the label. Fields are required by default. */
  optional?: boolean;
  /** Defaults to a generated id. */
  id?: string;
  /** Renders the control, e.g. `{(control) => <Input {...control} name="email" />}`. */
  children: (control: FieldControlProps) => ReactNode;
}

/** One form row: label above, the control, the error under it, then the help text. */
export function Field({ label, help, error, optional, id, children }: FieldProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const aria = fieldAria(controlId, { help: help != null, error: error != null });

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={controlId}>
        {label}
        {optional && <span className={styles.optional}> (opcional)</span>}
      </label>
      {children({
        id: controlId,
        "aria-describedby": aria.describedBy,
        "aria-invalid": aria.invalid,
      })}
      {error != null && (
        <p id={aria.errorId} className={styles.error}>
          {error}
        </p>
      )}
      {help != null && (
        <p id={aria.helpId} className={styles.help}>
          {help}
        </p>
      )}
    </div>
  );
}

/** A text input styled to match `Field`. */
export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={[styles.input, className].filter(Boolean).join(" ")} {...props} />;
}
