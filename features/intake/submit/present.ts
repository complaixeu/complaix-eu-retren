import type { CreateCaseResult } from "@/shared/contracts";

/** What the result screen needs, as plain data (safe to hand to the browser). */
export interface ResultView {
  kind: "eligible" | "not_eligible" | "doubtful";
  publicRef: string;
  /** The engine's reason, in Spanish. */
  reason: string;
  delayMinutes: number;
  /** The earliest day the claim goes out ("12 de marzo de 2026", Madrid time), or null. */
  sendDate: string | null;
  /** Share of the ticket price the rules apply, when there is one. */
  percent: number | null;
}

const longDate = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Madrid",
});

/** An instant as a Spanish calendar date in Madrid ("13 de marzo de 2026"). */
export function madridLongDate(instant: string): string {
  return longDate.format(new Date(instant));
}

export function describeResult(result: CreateCaseResult): ResultView {
  const { eligibility } = result;
  const goesOut = eligibility.status !== "not_eligible" && eligibility.earliestSendAt;
  return {
    kind: eligibility.status,
    publicRef: result.publicRef,
    reason: eligibility.reason,
    delayMinutes: eligibility.delayMinutes,
    sendDate: goesOut ? madridLongDate(eligibility.earliestSendAt!) : null,
    percent: eligibility.tier?.percent ?? null,
  };
}
