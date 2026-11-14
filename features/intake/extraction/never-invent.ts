import type { TicketData, TicketExtraction, TicketField } from "@/shared/contracts";
import { TICKET_FIELDS, parseModelOutput } from "./schema";

/**
 * The "never invent" post-check ([A3], ARCHITECTURE §1: the AI fills nothing the user didn't
 * give). Every extracted value must appear in the OCR text, or it is dropped and the field goes
 * to `missing`, where the review step asks for it. Strict on purpose: when in doubt, drop.
 *
 * What counts as "appears", after normalizing both sides (case, accents, runs of whitespace):
 * - text fields: the value as a whole word sequence, so "ABC12" is not found in "ABC123";
 *   punctuation is kept, so "ABC-123" is not "ABC123";
 * - dates (stored `YYYY-MM-DD`): one of the ways a date is printed in Spain, day first:
 *   14/11/2026, 14-11-2026, 14.11.2026, 14/11/26, 5/3/2026, 2026-11-14, "14 de noviembre de
 *   2026", "14 nov 2026";
 * - times (stored `HH:MM`): 09:05, 9:05, 09.05 or 9h05, but not followed by a currency (a
 *   price "9.05 €" is not a time);
 * - numbers, codes and times (`price`, `bookingRef`, `ticketNumber`, `trainNumber`, the times)
 *   must match the whole printed token: `, . - / : _` joining the match to another letter or
 *   digit glue it to that token, so "90 EUR" is not in "54,90 EUR", "123" is not in "ABC-123"
 *   and "09:05" is not in "10:09:05". Punctuation that ends a phrase ("54,90 EUR." or
 *   "09:05, llegada") does not;
 * - `bookingRef` must also look like a localizador: at least 5 letters or digits, so a short
 *   word like "de" can never pass as one;
 * - `purchaseChannel` is our own label, never printed as such, so it is always dropped.
 *
 * What this proves is presence in the text, not which field a value belongs to: a departure time
 * returned as the arrival, or a ticket number returned as the localizador, still passes. The guard
 * for that is the mandatory review step ([A4], ARCHITECTURE §2), where the user confirms every
 * field and the localizador explicitly.
 */

/** Lower case, no accents, single spaces. */
export function normalizeText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

const isWordChar = (c: string | undefined) => c !== undefined && /[a-z0-9]/.test(c);
const isJoiner = (c: string | undefined) => c !== undefined && /[,./:_-]/.test(c);

type Match = { strict: boolean; notBefore?: RegExp };

/**
 * `needle` occurs in `haystack` (both normalized) not glued to a letter or digit on either side.
 * With `strict`, a joiner (`, . - / : _`) followed, or preceded, by a letter or digit is glue
 * too. `notBefore` rejects a match the rest of the text continues with.
 */
function occurs(haystack: string, needle: string, match: Match = { strict: false }): boolean {
  if (!needle) return false;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    if (isWordChar(haystack[at - 1]) || isWordChar(haystack[end])) continue;
    if (match.strict) {
      if (isJoiner(haystack[at - 1]) && isWordChar(haystack[at - 2])) continue;
      if (isJoiner(haystack[end]) && isWordChar(haystack[end + 1])) continue;
    }
    if (match.notBefore?.test(haystack.slice(end))) continue;
    return true;
  }
  return false;
}

const MONTHS = [
  ["enero", "ene"],
  ["febrero", "feb"],
  ["marzo", "mar"],
  ["abril", "abr"],
  ["mayo", "may"],
  ["junio", "jun"],
  ["julio", "jul"],
  ["agosto", "ago"],
  ["septiembre", "sep", "setiembre", "sept"],
  ["octubre", "oct"],
  ["noviembre", "nov"],
  ["diciembre", "dic"],
] as const;

/** The printed forms of an ISO date, normalized. */
function dateForms(iso: string): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return [];
  const [, yyyy, mm, dd] = match;
  const days = [...new Set([dd, String(Number(dd))])];
  const months = [...new Set([mm, String(Number(mm))])];
  const years = [yyyy, yyyy.slice(2)];
  const forms = [`${yyyy}-${mm}-${dd}`, `${yyyy}/${mm}/${dd}`];
  for (const sep of ["/", "-", "."]) {
    for (const d of days)
      for (const m of months) for (const y of years) forms.push(`${d}${sep}${m}${sep}${y}`);
  }
  for (const d of days) {
    for (const name of MONTHS[Number(mm) - 1]) {
      forms.push(`${d} de ${name} de ${yyyy}`, `${d} ${name} ${yyyy}`, `${d} ${name}. ${yyyy}`);
    }
  }
  return forms;
}

/** The printed forms of an `HH:MM` time, normalized. */
function timeForms(time: string): string[] {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return [];
  const [, hh, mm] = match;
  const hours = [...new Set([hh, String(Number(hh))])];
  return hours.flatMap((h) => [":", ".", "h"].map((sep) => `${h}${sep}${mm}`));
}

const DATE_FIELDS = new Set<TicketField>(["travelDate", "purchaseDate"]);
const TIME_FIELDS = new Set<TicketField>(["scheduledDeparture", "scheduledArrival"]);
const NEVER_PRINTED = new Set<TicketField>(["purchaseChannel"]);
/** Numbers and codes: the value must be the whole printed token. */
const TOKEN_FIELDS = new Set<TicketField>(["price", "bookingRef", "ticketNumber", "trainNumber"]);
/** A time followed by a currency is a price. */
const CURRENCY_NEXT = /^ ?(€|eur(?![a-z0-9]))/;
/** The fewest letters or digits a localizador can have. */
export const MIN_BOOKING_REF_CHARS = 5;

function matchFor(field: TicketField): Match {
  if (TIME_FIELDS.has(field)) return { strict: true, notBefore: CURRENCY_NEXT };
  return { strict: TOKEN_FIELDS.has(field) };
}

/** Whether `value`, extracted for `field`, appears in the OCR text. */
export function appearsInText(field: TicketField, value: string, text: string): boolean {
  if (NEVER_PRINTED.has(field)) return false;
  if (
    field === "bookingRef" &&
    normalizeText(value).replace(/[^a-z0-9]/g, "").length < MIN_BOOKING_REF_CHARS
  ) {
    return false;
  }
  const haystack = normalizeText(text);
  const forms = DATE_FIELDS.has(field)
    ? dateForms(value)
    : TIME_FIELDS.has(field)
      ? timeForms(value)
      : [normalizeText(value)];
  const match = matchFor(field);
  return forms.some((form) => occurs(haystack, form, match));
}

/** Keeps only the values found in `text`; the rest are `dropped`. */
export function neverInvent(
  data: TicketData,
  text: string,
): { data: TicketData; dropped: TicketField[] } {
  const kept: Record<string, string> = {};
  const dropped: TicketField[] = [];
  for (const field of TICKET_FIELDS) {
    const value = data[field];
    if (value === undefined) continue;
    if (appearsInText(field, value, text)) kept[field] = value;
    else dropped.push(field);
  }
  return { data: kept as TicketData, dropped };
}

/** A `TicketExtraction` from what was kept: `missing` is every field not in `data`. */
export function extractionOf(data: TicketData): TicketExtraction {
  const missing = TICKET_FIELDS.filter((field) => data[field] === undefined);
  return { quality: missing.length < TICKET_FIELDS.length ? "ok" : "unreadable", data, missing };
}

/**
 * A model's raw answer for `ocrText` → the extraction: validated field by field, then
 * post-checked against the text. Every extractor ends here.
 */
export function toExtraction(raw: unknown, ocrText: string): TicketExtraction {
  return extractionOf(neverInvent(parseModelOutput(raw).data, ocrText).data);
}
