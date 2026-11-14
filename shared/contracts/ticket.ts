import { z } from "zod";
import { OperatorId } from "./operator";

const Time = z.iso.time({ precision: -1 }); // HH:MM
const Day = z.iso.date(); // YYYY-MM-DD

/**
 * What can be read from a ticket. Every field is optional: the AI fills nothing the user
 * didn't give (ARCHITECTURE §1). Train number and price stay empty if they aren't printed.
 */
export const TicketData = z.object({
  operator: OperatorId.optional(),
  travelDate: Day.optional(),
  origin: z.string().min(1).optional(),
  destination: z.string().min(1).optional(),
  bookingRef: z.string().min(1).optional(), // localizador
  ticketNumber: z.string().min(1).optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  scheduledDeparture: Time.optional(),
  scheduledArrival: Time.optional(),
  trainNumber: z.string().min(1).optional(),
  price: z.string().min(1).optional(), // as printed, e.g. "45,60 €"
  purchaseDate: Day.optional(),
  purchaseChannel: z.enum(["direct", "intermediary", "unknown"]).optional(),
});
export type TicketData = z.infer<typeof TicketData>;
export type TicketField = keyof TicketData;

export const TicketExtraction = z.object({
  quality: z.enum(["ok", "unreadable"]),
  data: TicketData,
  missing: z.array(TicketData.keyof()),
});
export type TicketExtraction = z.infer<typeof TicketExtraction>;

/** Fields that must be present (read or typed by the user) before a case can be created. */
export const SubmittedTicket = TicketData.required({
  operator: true,
  travelDate: true,
  origin: true,
  destination: true,
  bookingRef: true,
  firstName: true,
  lastName: true,
  scheduledDeparture: true,
  scheduledArrival: true,
});
export type SubmittedTicket = z.infer<typeof SubmittedTicket>;
