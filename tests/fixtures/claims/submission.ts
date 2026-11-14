import type { IntakeSubmission } from "@/shared/contracts";

// A neutral, invented submission (no real ticket, docs/plans/README.md §3). Every value is a
// placeholder; the personal fields are distinctive so tests can assert they never leak.
export const PII = {
  email: "viajero.prueba@example.test",
  firstName: "Nombreprueba",
  lastName: "Apellidoprueba",
  documentNumber: "X0000000T",
  bookingRef: "LOCPRUEBA1",
} as const;

/** Arrives `delayMinutes` after the scheduled 12:00 arrival (Europe/Madrid, winter). */
export function submissionFixture(
  delayMinutes = 90,
  overrides: Partial<IntakeSubmission> = {},
): IntakeSubmission {
  const arrival = new Date(Date.UTC(2026, 0, 15, 12, delayMinutes));
  const hh = String(arrival.getUTCHours()).padStart(2, "0");
  const mm = String(arrival.getUTCMinutes()).padStart(2, "0");
  return {
    draftId: `draft-${delayMinutes}`,
    ticketPath: "tickets/test/placeholder.png",
    ticket: {
      operator: "iryo",
      travelDate: "2026-01-15",
      origin: "Origen",
      destination: "Destino",
      bookingRef: PII.bookingRef,
      firstName: PII.firstName,
      lastName: PII.lastName,
      scheduledDeparture: "09:00",
      scheduledArrival: "12:00",
      purchaseDate: "2026-01-01",
      purchaseChannel: "direct",
    },
    answers: {
      documentType: "dni",
      documentNumber: PII.documentNumber,
      email: PII.email,
      actualArrival: { date: arrival.toISOString().slice(0, 10), time: `${hh}:${mm}` },
      previousClaim: { made: false },
      paymentPreference: "money",
    },
    consent: {
      consentId: "consent-test",
      mandateAccepted: true,
      gdprAccepted: true,
      textVersion: "test-v1",
      acceptedAt: "2026-01-16T10:00:00+01:00",
    },
    ...overrides,
  };
}
