import { useId, type ComponentProps, type ReactNode } from "react";
import { fieldAria } from "./field-aria";
import { FieldMessages } from "./field";
import styles from "./field.module.css";

export interface FieldsetProps {
  legend: ReactNode;
  /** Shown under the options. */
  help?: ReactNode;
  /** Shown in red under the options; the group is described by it. */
  error?: ReactNode;
  optional?: boolean;
  /** Defaults to a generated id. */
  id?: string;
  children: ReactNode;
}

/** A group of options (radios or checkboxes) under one legend, e.g. "¿Cómo quieres cobrar?". */
export function Fieldset({ legend, help, error, optional, id, children }: FieldsetProps) {
  const generated = useId();
  const groupId = id ?? generated;
  const aria = fieldAria(groupId, { help: help != null, error: error != null });
  return (
    <fieldset id={groupId} className={styles.fieldset} aria-describedby={aria.describedBy}>
      <legend className={styles.legend}>
        {legend}
        {optional && <span className={styles.optional}> (opcional)</span>}
      </legend>
      <div className={styles.options}>{children}</div>
      <FieldMessages aria={aria} help={help} error={error} />
    </fieldset>
  );
}

export type ChoiceProps = Omit<ComponentProps<"input">, "type"> & {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
};

function Choice({
  type,
  label,
  help,
  error,
  id,
  className,
  ...props
}: ChoiceProps & { type: "checkbox" | "radio" }) {
  const generated = useId();
  const inputId = id ?? generated;
  const aria = fieldAria(inputId, { help: help != null, error: error != null });
  return (
    <div className={styles.choice}>
      <div className={styles.choiceRow}>
        <input
          type={type}
          id={inputId}
          className={[styles.choiceInput, className].filter(Boolean).join(" ")}
          aria-describedby={aria.describedBy}
          aria-invalid={aria.invalid}
          {...props}
        />
        <label htmlFor={inputId} className={styles.choiceLabel}>
          {label}
        </label>
      </div>
      {(help != null || error != null) && (
        <div className={styles.choiceMessages}>
          <FieldMessages aria={aria} help={help} error={error} />
        </div>
      )}
    </div>
  );
}

/** A checkbox row: box, label to its right, error and help under the label. */
export function Checkbox(props: ChoiceProps) {
  return <Choice type="checkbox" {...props} />;
}

/** A radio row; put several in a `Fieldset` with the same `name`. Group errors go on the Fieldset. */
export function Radio(props: ChoiceProps) {
  return <Choice type="radio" {...props} />;
}
