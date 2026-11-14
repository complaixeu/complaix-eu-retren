import { z } from "zod";

const Day = z.iso.date();
const Time = z.iso.time({ precision: -1 });

/**
 * Data for the EU form (Implementing Regulation 2024/949). Field-by-field mapping:
 * ARCHITECTURE "Mapeo del formulario". Anything optional stays blank in the PDF.
 */
export const EuFormData = z.object({
  previousClaim: z
    .object({ date: Day, recipient: z.string().min(1), means: z.string().min(1) })
    .optional(),
  operatorName: z.string().min(1),
  scheduled: z.object({
    date: Day,
    origin: z.string().min(1),
    destination: z.string().min(1),
    departureTime: Time,
    arrivalTime: Time,
    trainNumber: z.string().min(1).optional(),
    ticketRef: z.string().min(1),
    price: z.string().min(1).optional(),
  }),
  actual: z.object({
    arrivalDate: Day,
    arrivalTime: Time,
    departureTime: Time.optional(),
    trainNumber: z.string().min(1).optional(),
  }),
  delayMinutes: z.number().int().nonnegative(),
  passenger: z.object({ firstName: z.string().min(1), lastName: z.string().min(1) }),
  bookingEmail: z.email().optional(),
  paymentPreference: z.enum(["money", "voucher"]),
  gdprAccepted: z.boolean(),
  request: z.object({ date: Day, place: z.string().min(1) }),
  /** Printed as "Retren, en representación de <name>". */
  representedName: z.string().min(1),
});
export type EuFormData = z.infer<typeof EuFormData>;

export const MandateData = z.object({
  caseRef: z.string().min(1),
  passengerName: z.string().min(1),
  documentType: z.enum(["dni", "nie", "passport"]),
  documentNumber: z.string().min(1),
  operatorName: z.string().min(1),
  trip: z.object({
    date: Day,
    origin: z.string().min(1),
    destination: z.string().min(1),
    ticketRef: z.string().min(1),
  }),
  acceptedAt: z.iso.datetime({ offset: true }),
  consentTextVersion: z.string().min(1),
});
export type MandateData = z.infer<typeof MandateData>;

export const TemplateKind = z.enum([
  "initial_claim",
  "reminder_d12",
  "reminder_d30",
  "last_notice_d40",
  "escalation_d45",
  "insistence_after_denial",
  "reply_acknowledgement",
  "reply_asks_for_data",
  "reply_approved",
  "reply_denied",
  "reply_refers_to_form",
  "user_request_document",
  "user_final_result",
]);
export type TemplateKind = z.infer<typeof TemplateKind>;

export const RenderedTemplate = z.object({
  subject: z.string().regex(/\[RTN-[A-Z0-9]+\]/, "subject must carry the case reference"),
  text: z.string().min(1),
});
export type RenderedTemplate = z.infer<typeof RenderedTemplate>;
