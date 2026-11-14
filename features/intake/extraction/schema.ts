import { TicketData, type TicketField } from "@/shared/contracts";

/**
 * Validation of what an extractor returns ([A3]). The schema is the contract's `TicketData`
 * itself: dates are real calendar days in `YYYY-MM-DD`, times are `HH:MM` (00:00 to 23:59), the
 * operator is one we know. A model answer is parsed field by field, so one bad value drops only
 * that field (it ends in `missing`) instead of the whole answer.
 */
export const ExtractedTicket = TicketData;

/** Every ticket field, in the contract's order. */
export const TICKET_FIELDS: readonly TicketField[] = TicketData.keyof().options;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Trims and collapses whitespace runs to one space: "  Madrid \n Chamartín " → "Madrid Chamartín". */
const tidy = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * Parses a model's raw JSON answer. Unknown keys, `null`, empty strings and non-strings are
 * ignored; a string that fails the schema (a bad date or time, an unknown operator) is listed in
 * `invalid` and left out.
 */
export function parseModelOutput(raw: unknown): { data: TicketData; invalid: TicketField[] } {
  const data: Record<string, string> = {};
  const invalid: TicketField[] = [];
  if (!isObject(raw)) return { data, invalid };
  for (const field of TICKET_FIELDS) {
    const value = raw[field];
    if (value === null || value === undefined) continue;
    if (typeof value !== "string") {
      invalid.push(field);
      continue;
    }
    const clean = tidy(value);
    if (!clean) continue;
    const parsed = TicketData.shape[field].safeParse(clean);
    if (parsed.success && parsed.data !== undefined) data[field] = parsed.data;
    else invalid.push(field);
  }
  return { data: data as TicketData, invalid };
}
