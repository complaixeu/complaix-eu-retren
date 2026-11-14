import type { Clock } from "@/shared/contracts";

export const systemClock: Clock = { now: () => new Date() };

/** A clock frozen at `at` (tests, and the demo "move the clock forward" action). */
export function fixedClock(at: Date | string): Clock {
  const t = new Date(at);
  return { now: () => new Date(t) };
}
