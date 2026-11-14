import { z } from "zod";
import { ReplyCategory } from "@/shared/contracts";

/** What every classifier returns: a category from the closed set and nothing else. */
export type Verdict = { category: ReplyCategory; confidence: number };

/** Below this the reply goes to the team queue as `other` (ARCHITECTURE §5, rule 4). */
export const MIN_CONFIDENCE = 0.7;

export const OTHER: Verdict = Object.freeze({ category: "other", confidence: 0 });

const Raw = z.object({
  category: ReplyCategory,
  confidence: z.number().min(0).max(1),
});

/**
 * Turns any classifier output into a safe verdict. Anything outside the enum, malformed, or below
 * MIN_CONFIDENCE becomes `other`. Extra fields are dropped, so nothing a model adds (an address,
 * an "action") can reach the caller.
 */
export function toVerdict(raw: unknown): Verdict {
  const parsed = Raw.safeParse(raw);
  if (!parsed.success) return { ...OTHER };
  const { category, confidence } = parsed.data;
  if (confidence < MIN_CONFIDENCE) return { category: "other", confidence };
  return { category, confidence };
}
