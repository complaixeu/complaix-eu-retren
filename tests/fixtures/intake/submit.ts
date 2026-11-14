import { ANSWERS, REVIEW, REVIEWED_TICKET } from "./review";

/**
 * Trips for the submit step ([A7]), one per result screen. The ticket always arrives at 10:30;
 * the user's real arrival is `delayMinutes` later. With Iryo's rules (domain B): under 60 minutes
 * is not eligible, exactly 60 is doubtful, more than 60 is eligible. The trip is a few days ago,
 * so it is inside the three-month deadline whenever the tests run.
 */
export const DELAYS = { eligible: 120, notEligible: 20, doubtful: 60 } as const;

const DAY = 24 * 60 * 60 * 1000;

/** A Madrid calendar date `daysAgo` days before `now`. */
export function madridDate(now: Date, daysAgo: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(
    new Date(now.getTime() - daysAgo * DAY),
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/** What the review ([A4]) and the questions ([A5]) steps store in the draft for such a trip. */
export function tripData(delayMinutes: number, now: Date = new Date()) {
  const travelDate = madridDate(now, 5);
  const minutes = 10 * 60 + 30 + delayMinutes;
  return {
    review: {
      ...REVIEW,
      ticket: { ...REVIEWED_TICKET, travelDate },
    },
    answers: {
      ...ANSWERS,
      actualArrival: {
        date: travelDate,
        time: `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`,
      },
    },
  };
}
