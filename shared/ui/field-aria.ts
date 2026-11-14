export interface FieldAria {
  helpId: string | undefined;
  errorId: string | undefined;
  /** Value for the control's `aria-describedby`: the error first, then the help text. */
  describedBy: string | undefined;
  /** Value for the control's `aria-invalid`. */
  invalid: true | undefined;
}

/** The ids and ARIA attributes that tie a control to its help text and error message. */
export function fieldAria(id: string, has: { help?: boolean; error?: boolean }): FieldAria {
  const helpId = has.help ? `${id}-help` : undefined;
  const errorId = has.error ? `${id}-error` : undefined;
  const describedBy = [errorId, helpId].filter(Boolean).join(" ") || undefined;
  return { helpId, errorId, describedBy, invalid: has.error ? true : undefined };
}
