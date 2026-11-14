export type StepStatus = "complete" | "current" | "upcoming";

/** One status per step: everything before `current` is complete, everything after is upcoming. */
export function stepStatuses(count: number, current: number): StepStatus[] {
  if (!Number.isInteger(current) || current < 0 || current >= count) {
    throw new RangeError(`current step ${current} is outside 0..${count - 1}`);
  }
  return Array.from({ length: count }, (_, i) =>
    i < current ? "complete" : i === current ? "current" : "upcoming",
  );
}
