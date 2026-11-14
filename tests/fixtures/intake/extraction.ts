import type { TicketData, TicketExtraction } from "@/shared/contracts";

/**
 * Extraction fixtures for the review step ([A4]). Hand-written and neutral, not real tickets
 * (docs/plans/README.md §3). Shaped like what A3 writes to `data.extraction`.
 */

/** Every field read from the ticket. */
export const fullTicket = {
  operator: "iryo",
  travelDate: "2026-03-12",
  origin: "Estación Uno",
  destination: "Estación Dos",
  bookingRef: "ABC123",
  ticketNumber: "0000000001",
  firstName: "Persona",
  lastName: "De Prueba",
  scheduledDeparture: "09:10",
  scheduledArrival: "11:55",
  trainNumber: "6201",
  price: "54,90 €",
  purchaseDate: "2026-03-01",
  purchaseChannel: "direct",
} as const satisfies TicketData;

/** A read where the localizador and the arrival time could not be found. */
export const partialExtraction: TicketExtraction = {
  quality: "ok",
  data: {
    operator: "iryo",
    travelDate: "2026-03-12",
    origin: "Estación Uno",
    destination: "Estación Dos",
    firstName: "Persona",
    lastName: "De Prueba",
    scheduledDeparture: "09:10",
  },
  missing: ["bookingRef", "scheduledArrival", "ticketNumber"],
};

/** A3's manual-entry path: nothing read, every field missing. */
export const manualExtraction: TicketExtraction = {
  quality: "unreadable",
  data: {},
  missing: Object.keys(fullTicket) as TicketExtraction["missing"],
};

/** Form fields for a complete, valid review, as the browser sends them. */
export function reviewForm(overrides: Record<string, string | null> = {}): FormData {
  const values: Record<string, string | null> = {
    ...fullTicket,
    bookingRefConfirmed: "yes",
    ...overrides,
  };
  const form = new FormData();
  for (const [name, value] of Object.entries(values)) {
    if (value !== null) form.set(name, value);
  }
  return form;
}
