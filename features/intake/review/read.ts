import { z } from "zod";
import { TicketData, TicketExtraction, type TicketField } from "@/shared/contracts";
import { REVIEW_FIELDS, REVIEW_REQUIRED_FIELDS } from "./fields";

/**
 * What the review step reads from and writes to the draft ([A4]). A3 writes `data.extraction`
 * (a `TicketExtraction`; its manual-entry path writes one with empty data and every field
 * missing). This step writes `data.review`. Both are validated on the way in: a malformed value
 * counts as not there, so nothing the user didn't give or confirm reaches the form.
 */

export const StoredReview = z.object({
  ticket: TicketData,
  bookingRefConfirmed: z.literal(true),
  reviewedAt: z.iso.datetime(),
});
export type StoredReview = z.infer<typeof StoredReview>;

export interface ReviewStart {
  /** Where the values come from: the saved review, the extraction, or nothing (typed by hand). */
  source: "review" | "extraction" | "manual";
  ticket: TicketData;
  /** Fields the extraction couldn't read, to mark on the screen. */
  missing: TicketField[];
  /** The saved review confirmed this localizador. */
  confirmed: boolean;
}

const ALL_FIELDS: TicketField[] = REVIEW_FIELDS.map((f) => f.name);

function missingOf(extraction: TicketExtraction | null): TicketField[] {
  if (!extraction) return ALL_FIELDS;
  const missing = new Set(extraction.missing);
  // A required field the extraction left empty is missing, listed or not.
  for (const name of REVIEW_REQUIRED_FIELDS) {
    if (extraction.data[name] === undefined) missing.add(name);
  }
  return ALL_FIELDS.filter((name) => missing.has(name));
}

/** What the review form starts from, given the draft's `data`. */
export function readReview(data: Record<string, unknown>): ReviewStart {
  const extraction = TicketExtraction.safeParse(data.extraction);
  const read = extraction.success ? extraction.data : null;
  const review = StoredReview.safeParse(data.review);
  const missing = missingOf(read);

  if (review.success) {
    return { source: "review", ticket: review.data.ticket, missing, confirmed: true };
  }
  const empty = !read || Object.keys(read.data).length === 0;
  return {
    source: empty ? "manual" : "extraction",
    ticket: read?.data ?? {},
    missing,
    confirmed: false,
  };
}
