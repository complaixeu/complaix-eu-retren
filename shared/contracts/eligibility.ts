import { z } from "zod";
import { OperatorId } from "./operator";

const Instant = z.iso.datetime({ offset: true });

/** Input of the deterministic rules (ARCHITECTURE §3). */
export const EligibilityInput = z.object({
  operator: OperatorId,
  scheduledDeparture: Instant,
  scheduledArrival: Instant,
  actualArrival: Instant,
  purchaseDate: z.iso.date().optional(),
  purchaseChannel: z.enum(["direct", "intermediary", "unknown"]).optional(),
  purchasedAtCasaIryo: z.boolean().optional(),
  forceMajeure: z.boolean().optional(),
  /** Evaluation time; the rules never read the system clock. */
  now: Instant,
});
export type EligibilityInput = z.infer<typeof EligibilityInput>;

export const PaymentForm = z.enum([
  "money",
  "voucher",
  "refundable_voucher",
  "non_refundable_voucher",
]);
export type PaymentForm = z.infer<typeof PaymentForm>;

export const EligibilityResult = z.object({
  status: z.enum(["eligible", "not_eligible", "doubtful"]),
  reason: z.string().min(1),
  delayMinutes: z.number().int(),
  tier: z
    .object({ percent: z.number().min(0).max(100), payment: z.array(PaymentForm).min(1) })
    .optional(),
  /** Earliest moment the claim may be sent (operator's minimum wait). */
  earliestSendAt: Instant.optional(),
  /** Last moment to claim (3 months by default). */
  deadline: Instant.optional(),
  appliedRules: z.array(z.string()),
  configVersion: z.string().min(1),
});
export type EligibilityResult = z.infer<typeof EligibilityResult>;
