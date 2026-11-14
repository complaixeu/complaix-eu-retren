import { z } from "zod";
import { SubmittedTicket } from "./ticket";

/** Always asked (ARCHITECTURE §1, "Se pregunta siempre"). */
export const UserAnswers = z.object({
  documentType: z.enum(["dni", "nie", "passport"]),
  documentNumber: z.string().min(1),
  email: z.email(),
  actualArrival: z.object({ date: z.iso.date(), time: z.iso.time({ precision: -1 }) }),
  previousClaim: z.discriminatedUnion("made", [
    z.object({ made: z.literal(false) }),
    z.object({
      made: z.literal(true),
      date: z.iso.date(),
      recipient: z.string().min(1),
      means: z.string().min(1),
    }),
  ]),
  paymentPreference: z.enum(["money", "voucher"]),
});
export type UserAnswers = z.infer<typeof UserAnswers>;

/** Evidence of the mandate + GDPR acceptance (legal section: date, text version, IP, trip). */
export const ConsentRef = z.object({
  consentId: z.string().min(1),
  mandateAccepted: z.literal(true),
  gdprAccepted: z.boolean(),
  textVersion: z.string().min(1),
  acceptedAt: z.iso.datetime({ offset: true }),
});
export type ConsentRef = z.infer<typeof ConsentRef>;

/** What intake hands to the claims engine (A → C). */
export const IntakeSubmission = z.object({
  draftId: z.string().min(1),
  ticketPath: z.string().min(1), // private storage path of the original ticket
  ticket: SubmittedTicket,
  answers: UserAnswers,
  consent: ConsentRef,
});
export type IntakeSubmission = z.infer<typeof IntakeSubmission>;
