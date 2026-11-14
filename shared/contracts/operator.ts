import { z } from "zod";

/** Operators Retren knows about. Adding one is adding a config in features/rules (ARCHITECTURE §3). */
export const OperatorId = z.enum(["iryo", "renfe", "ouigo"]);
export type OperatorId = z.infer<typeof OperatorId>;

/** The part of an operator config other domains may rely on. The full config lives in features/rules. */
export const OperatorPublicConfig = z.object({
  id: OperatorId,
  displayName: z.string().min(1),
  /** false until the operator's claims channel is confirmed: never sent automatically. */
  active: z.boolean(),
  channel: z.discriminatedUnion("type", [
    z.object({ type: z.literal("email"), address: z.email() }),
    z.object({ type: z.literal("web_form"), url: z.url() }),
    z.object({ type: z.literal("postal"), address: z.string().min(1) }),
  ]),
  /** Typical days to answer, used by the timers. */
  responseDays: z.number().int().positive(),
  version: z.string().min(1),
});
export type OperatorPublicConfig = z.infer<typeof OperatorPublicConfig>;
