import { TicketExtraction } from "@/shared/contracts";
import type { Json } from "@/shared/supabase";
import { TICKET_FIELDS } from "./schema";

/**
 * Retry → manual entry ([A3], ARCHITECTURE flow: "borrosa o ilegible → pedir otra foto → sigue
 * sin leerse → campos a mano"). Pure: no I/O.
 *
 * The draft keys this module owns (`intake_drafts.data`):
 * - `extraction`: a `TicketExtraction`. Written when the ticket was read (`quality: "ok"`), or,
 *   after the last unreadable photo, as manual entry (`quality: "unreadable"`, no data, every
 *   field missing). Never written for a photo that only asks for another one. A4 reads it.
 * - `ocrAttempts`: how many photos in a row could not be read, this ticket included; 0 once one
 *   is read. Written only once the photo has been read, so a draft without it is still unread.
 * - `ocrCarried`: the count carried over from the draft this one replaced (each upload makes a
 *   new draft). Written before reading, only when it isn't 0, so a provider failure between the
 *   two can't reset the count (see `finishUploadAndRead` and `priorAttemptsOf`).
 */

/** Photos the user may try before typing the data by hand. */
export const MAX_PHOTO_ATTEMPTS = 2;

export type ReadingNext = "review" | "retry" | "manual";

export function decideAfterReading(input: { readable: boolean; unreadableSoFar: number }): {
  next: ReadingNext;
  ocrAttempts: number;
} {
  if (input.readable) return { next: "review", ocrAttempts: 0 };
  const so = Number.isFinite(input.unreadableSoFar)
    ? Math.max(0, Math.floor(input.unreadableSoFar))
    : 0;
  const ocrAttempts = so + 1;
  return { next: ocrAttempts >= MAX_PHOTO_ATTEMPTS ? "manual" : "retry", ocrAttempts };
}

/** Manual entry: nothing was read, so the review step asks for every field. */
export function manualExtraction(): TicketExtraction {
  return { quality: "unreadable", data: {}, missing: [...TICKET_FIELDS] };
}

type DraftData = { [key: string]: Json | undefined } | null | undefined;

/** The draft's `ocrAttempts`, or 0. */
export function ocrAttemptsOf(data: DraftData): number {
  const value = data?.ocrAttempts;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * How many unreadable photos a draft hands on to the one that replaces it: its own `ocrAttempts`
 * once its photo was read, otherwise the `ocrCarried` it was given (its photo is still unread,
 * e.g. after a provider failure, so it neither adds to the count nor resets it).
 */
export function priorAttemptsOf(data: DraftData): number {
  if (typeof data?.ocrAttempts === "number") return ocrAttemptsOf(data);
  const carried = data?.ocrCarried;
  return typeof carried === "number" && Number.isInteger(carried) && carried > 0 ? carried : 0;
}

/**
 * What the upload step shows for a stored ticket:
 * - `read`: it was read; on to the review;
 * - `manual`: no photo could be read; on to the review, typing everything;
 * - `retry`: this photo could not be read; ask for another (`heic`: because of its format);
 * - `pending`: not read yet (reading failed on our side); offer to read it again.
 */
export type PhotoReadingState = "read" | "manual" | "retry" | "pending";

export interface PhotoReading {
  state: PhotoReadingState;
  heic: boolean;
}

export function photoReading(data: DraftData, contentType: string | undefined): PhotoReading {
  const extraction = TicketExtraction.safeParse(data?.extraction);
  const heic = contentType === "image/heic";
  if (extraction.success) {
    return { state: extraction.data.quality === "ok" ? "read" : "manual", heic: false };
  }
  return {
    state: ocrAttemptsOf(data) > 0 ? "retry" : "pending",
    heic: heic && ocrAttemptsOf(data) > 0,
  };
}
