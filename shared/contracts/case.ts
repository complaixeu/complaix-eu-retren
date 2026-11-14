import { z } from "zod";
import { EligibilityResult } from "./eligibility";

/** The nine case states (ARCHITECTURE §5). */
export const CaseStatus = z.enum([
  "draft",
  "waiting_period",
  "sent",
  "reply_received",
  "waiting_user",
  "escalated",
  "resolved",
  "denied",
  "closed",
]);
export type CaseStatus = z.infer<typeof CaseStatus>;

/** The closed set the AI classifies operator replies into (ARCHITECTURE §5). */
export const ReplyCategory = z.enum([
  "acknowledgement",
  "asks_for_data",
  "approved",
  "denied",
  "refers_to_form",
  "other",
]);
export type ReplyCategory = z.infer<typeof ReplyCategory>;

export const CreateCaseResult = z.object({
  caseId: z.string().min(1),
  publicRef: z.string().regex(/^RTN-[A-Z0-9]+$/),
  status: CaseStatus,
  eligibility: EligibilityResult,
});
export type CreateCaseResult = z.infer<typeof CreateCaseResult>;
