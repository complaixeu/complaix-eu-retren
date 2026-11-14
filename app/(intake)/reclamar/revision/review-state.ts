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

export type ArrivalWarning = "next_day_arrival" | "long_trip";

const LONG_TRIP_MINUTES = 10 * 60;
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * The notes under the arrival time, worked out as the user types. Mirrors `reviewWarnings` in
 * features/intake/review/validate.ts (a unit test compares them on every pair of times); the
 * server's result is the one that is shown again on the way back.
 */
export function arrivalWarnings(departure: string, arrival: string): ArrivalWarning[] {
  const hhmm = /^\d{2}:\d{2}$/;
  if (!hhmm.test(departure) || !hhmm.test(arrival) || departure === arrival) return [];
  const nextDay = arrival < departure;
  const duration = minutes(arrival) - minutes(departure) + (nextDay ? 24 * 60 : 0);
  const out: ArrivalWarning[] = [];
  if (nextDay) out.push("next_day_arrival");
  if (duration > LONG_TRIP_MINUTES) out.push("long_trip");
  return out;
}
