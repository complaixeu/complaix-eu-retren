/**
 * A reviewed trip for the consent step ([A6]): what `data.review` holds after the review screen
 * ([A4]). Neutral test values, not a real or realistic ticket (docs/plans/README.md §3).
 */
export const REVIEWED_TICKET = {
  operator: "iryo",
  travelDate: "2026-03-10",
  origin: "Estación Prueba Norte",
  destination: "Estación Prueba Sur",
  bookingRef: "TEST01",
  firstName: "Persona",
  lastName: "De Prueba",
  scheduledDeparture: "08:00",
  scheduledArrival: "10:30",
} as const;

export const REVIEW = {
  ticket: REVIEWED_TICKET,
  bookingRefConfirmed: true,
  reviewedAt: "2026-03-12T09:55:00.000Z",
};

/** The always-asked answers ([A5]), shaped like `UserAnswers`. */
export const ANSWERS = {
  documentType: "dni",
  documentNumber: "00000000T",
  email: "persona@example.test",
  actualArrival: { date: "2026-03-10", time: "12:05" },
  previousClaim: { made: false },
  paymentPreference: "money",
} as const;
