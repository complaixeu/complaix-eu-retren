/**
 * What the review form gets from the server, as plain data. Client code can't import the intake
 * domain, so these mirror `ReviewField` and the action's result in features/intake/review/.
 */

/** Mirrors `ReviewField` in features/intake/review/fields.ts, plus whether it was read. */
export interface ReviewFieldView {
  name: string;
  label: string;
  kind: "text" | "date" | "time" | "choice";
  required: boolean;
  help?: string;
  options?: readonly { value: string; label: string }[];
  autoComplete?: string;
  inputMode?: "text" | "numeric" | "decimal";
  /** The extraction couldn't read it: marked on the screen. */
  missing: boolean;
}

export interface ReviewSectionView {
  id: string;
  title: string;
  fields: ReviewFieldView[];
}

/** Form values by input name, as strings. */
export type ReviewFormValues = Readonly<Record<string, string>>;

/** What the review action returns. On success it redirects to the next step instead. */
export type ReviewFormState =
  | { status: "idle" }
  | {
      status: "error";
      /** Counts failed submits, so the form re-mounts with what the user typed. */
      attempt: number;
      values: ReviewFormValues;
      /** The message under each input that has an error. */
      errors: Readonly<Record<string, string>>;
    };

/** The value a checked "He comprobado el localizador" box posts. */
export const CONFIRM_VALUE = "yes";
