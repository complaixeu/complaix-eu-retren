import { SubmittedTicket, type TicketField } from "@/shared/contracts";
import {
  LONG_TRIP_MINUTES,
  REVIEW_FIELDS,
  REVIEW_MAX_LENGTH,
  type ReviewErrors,
  type ReviewInputName,
  type ReviewWarningCode,
  type ReviewWarnings,
} from "./fields";

/**
 * Server-side check of the review form ([A4]). The form posts plain strings; this trims them,
 * normalizes dates and times, and checks what a case needs (`SubmittedTicket`): real calendar
 * dates, a trip and a purchase that already happened, `HH:MM` times and an arrival that isn't
 * the departure time. Times that look odd but may be right come back as `warnings`, which never
 * block. Pure: the clock comes in as `now`.
 */

/** What the user typed, per input, to put back in the form after an error. */
export type ReviewValues = Partial<Record<ReviewInputName, string>>;

export type ReviewValidation =
  | { ok: true; ticket: SubmittedTicket; warnings: ReviewWarnings }
  | { ok: false; values: ReviewValues; errors: ReviewErrors; warnings: ReviewWarnings };

/** The value a checked "He comprobado el localizador" box posts. */
export const BOOKING_REF_CONFIRMED = "yes";

/** The trip is in Spain, so "today" is Madrid's calendar day. */
const madridDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * `YYYY-MM-DD` (what a date input posts) or `D/M/YYYY` (what someone types where the browser has
 * no date picker), as `YYYY-MM-DD`; null if it is not a real calendar date.
 */
export function parseReviewDate(raw: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const typed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  const [y, m, d] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : typed
      ? [Number(typed[3]), Number(typed[2]), Number(typed[1])]
      : [NaN, NaN, NaN];
  if (!Number.isInteger(y) || m < 1 || m > 12 || d < 1) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** `HH:MM` or `H:MM` as `HH:MM`; null if it is not a time of day. */
export function parseReviewTime(raw: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const [h, m] = [Number(match[1]), Number(match[2])];
  return h <= 23 && m <= 59 ? `${pad(h)}:${pad(m)}` : null;
}

type Form = Pick<FormData, "get">;

const text = (form: Form, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

export function validateReview(form: Form, { now }: { now: Date }): ReviewValidation {
  const values: ReviewValues = {};
  const errors: ReviewErrors = {};
  const ticket: Partial<Record<TicketField, string>> = {};

  for (const field of REVIEW_FIELDS) {
    const raw = text(form, field.name);
    values[field.name] = raw;
    if (raw === "") {
      if (field.required) errors[field.name] = "required";
      continue;
    }
    if (raw.length > REVIEW_MAX_LENGTH) {
      errors[field.name] = "too_long";
      continue;
    }
    let value: string | null = raw;
    if (field.kind === "date") {
      value = parseReviewDate(raw);
      if (!value) errors[field.name] = "invalid_date";
    } else if (field.kind === "time") {
      value = parseReviewTime(raw);
      if (!value) errors[field.name] = "invalid_time";
    } else if (field.kind === "choice" && !field.options.some((o) => o.value === raw)) {
      value = null;
      errors[field.name] = "invalid_choice";
    }
    if (value) ticket[field.name] = value;
  }

  // Dates compare as YYYY-MM-DD strings, and times as HH:MM strings.
  const today = madridDay.format(now);
  const { travelDate, purchaseDate, scheduledDeparture, scheduledArrival } = ticket;
  if (travelDate && travelDate > today) errors.travelDate = "future_date";
  if (purchaseDate && purchaseDate > today) errors.purchaseDate = "future_date";
  else if (purchaseDate && travelDate && purchaseDate > travelDate) {
    errors.purchaseDate = "purchase_after_travel";
  }
  // The ticket has no arrival date. An earlier arrival time means the next day (as in domain C's
  // `toEligibilityInput`); the same time can't be right either way.
  if (scheduledDeparture && scheduledDeparture === scheduledArrival) {
    errors.scheduledArrival = "same_time";
  }
  const warnings = reviewWarnings(scheduledDeparture, scheduledArrival);

  const confirmed = text(form, "bookingRefConfirmed");
  values.bookingRefConfirmed = confirmed;
  if (confirmed !== BOOKING_REF_CONFIRMED) errors.bookingRefConfirmed = "unconfirmed";

  if (Object.keys(errors).length > 0) return { ok: false, values, errors, warnings };

  // The checks above cover every rule of the contract; parsing again keeps the type honest.
  const parsed = SubmittedTicket.safeParse(ticket);
  if (!parsed.success) throw new Error("review passed its checks but not SubmittedTicket");
  return { ok: true, ticket: parsed.data, warnings };
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * The non-blocking notes on the times, from two `HH:MM` values: an arrival earlier than the
 * departure is on the next day, and a trip of over `LONG_TRIP_MINUTES` is worth a second look.
 * Nothing when either time is missing or not `HH:MM`, or when they are equal (that's an error).
 * The client form mirrors this as `arrivalWarnings` (tests/unit/intake/review.test.ts).
 */
export function reviewWarnings(departure?: string, arrival?: string): ReviewWarnings {
  const hhmm = /^\d{2}:\d{2}$/;
  if (!departure || !arrival || !hhmm.test(departure) || !hhmm.test(arrival)) return {};
  if (departure === arrival) return {};
  const nextDay = arrival < departure;
  const duration = minutes(arrival) - minutes(departure) + (nextDay ? 24 * 60 : 0);
  const codes: ReviewWarningCode[] = [];
  if (nextDay) codes.push("next_day_arrival");
  if (duration > LONG_TRIP_MINUTES) codes.push("long_trip");
  return codes.length > 0 ? { scheduledArrival: codes } : {};
}
