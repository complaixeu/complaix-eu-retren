import { z } from "zod";
import { TicketData, UserAnswers, type OperatorId } from "@/shared/contracts";
import type { IntakeDraftData } from "../draft/store";

/**
 * The trip as the user confirmed it, copied into the consent row as evidence: the reviewed
 * ticket (`data.review.ticket`, [A4]) and, once the questions step ([A5]) stores them, the
 * answers (`data.answers`). Only contract fields are kept: anything else in the draft (the raw
 * extraction, unknown keys) stays out.
 */
export const TripSnapshot = z.object({
  ticket: TicketData,
  answers: UserAnswers.optional(),
});
export type TripSnapshot = z.infer<typeof TripSnapshot>;

const Review = z.object({ ticket: TicketData });

export type TripSnapshotResult =
  | { ok: true; snapshot: TripSnapshot }
  /** `review_missing`: back to the review step; `answers_invalid`: back to the questions. */
  | { ok: false; reason: "review_missing" | "answers_invalid" };

export function buildTripSnapshot(data: IntakeDraftData): TripSnapshotResult {
  const review = Review.safeParse(data.review);
  if (!review.success) return { ok: false, reason: "review_missing" };
  const snapshot: TripSnapshot = { ticket: review.data.ticket };
  if (data.answers !== undefined) {
    const answers = UserAnswers.safeParse(data.answers);
    if (!answers.success) return { ok: false, reason: "answers_invalid" };
    snapshot.answers = answers.data;
  }
  return { ok: true, snapshot };
}

const OPERATOR_NAMES: Record<OperatorId, string> = {
  iryo: "Iryo",
  renfe: "Renfe",
  ouigo: "Ouigo",
};

const longDate = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** What the authorization step shows of the trip it covers. Missing fields are left out. */
export function tripSummary(ticket: TicketData): { label: string; value: string }[] {
  const passenger = [ticket.firstName, ticket.lastName].filter(Boolean).join(" ");
  const rows: [string, string | undefined][] = [
    ["Compañía", ticket.operator && OPERATOR_NAMES[ticket.operator]],
    ["Fecha", ticket.travelDate && longDate.format(new Date(`${ticket.travelDate}T00:00:00Z`))],
    [
      "Trayecto",
      ticket.origin && ticket.destination ? `${ticket.origin} – ${ticket.destination}` : undefined,
    ],
    ["Localizador", ticket.bookingRef],
    ["Pasajero", passenger || undefined],
  ];
  return rows.flatMap(([label, value]) => (value ? [{ label, value }] : []));
}
