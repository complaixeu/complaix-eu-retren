// The follow-up schedule (ARCHITECTURE §6, docs/plans/C-claims.md C7). Pure: no DB, no clock.
// Internal to domain C: run by the tick (./tick.ts), not exported from index.ts.
import type { CaseStatus, TemplateKind } from "@/shared/contracts";
import type { CaseTransitionEvent } from "./state-machine";

const DAY_MS = 86_400_000;

/** While a stage's window is open but the case can't get it (paused, stopped, capped), look daily. */
export const RECHECK_MS = DAY_MS;

/**
 * Most mails Retren sends to an operator for one case, so it is never treated as spam
 * (ARCHITECTURE §6): the initial claim, three reminders, the escalation and one insistence after
 * a denial.
 *
 * Who counts: every operator send increments `cases.send_count` when it is queued. C7 increments
 * it in the same transaction that queues a timer mail (claims_apply_timer_action); C3's
 * transport neither increments it again nor re-checks the cap for timer mail.
 *
 * The last slot is reserved for the d45 escalation: reminders (d12, d30, d40) are blocked when
 * `send_count >= MAX_SENDS_PER_CASE - 1`, the escalation when `send_count >= MAX_SENDS_PER_CASE`.
 * The cap never blocks the 3-month close, which writes to the user, not to the operator.
 */
export const MAX_SENDS_PER_CASE = 6;

export type TimerActionKind =
  "reminder_d12" | "reminder_d30" | "last_notice_d40" | "escalation_d45" | "close_3m";

type StageKind = Exclude<TimerActionKind, "close_3m">;

type Stage = {
  kind: StageKind;
  event: CaseTransitionEvent;
  template: TemplateKind;
  /** Highest send_count at which the stage may still be sent. */
  maxSendCount: number;
};

/** The §6 schedule, in order. Windows: see stageWindow. */
export const TIMER_ACTIONS: readonly Stage[] = Object.freeze([
  {
    kind: "reminder_d12",
    event: "reminder_sent",
    template: "reminder_d12",
    maxSendCount: MAX_SENDS_PER_CASE - 2,
  },
  {
    kind: "reminder_d30",
    event: "reminder_sent",
    template: "reminder_d30",
    maxSendCount: MAX_SENDS_PER_CASE - 2,
  },
  {
    kind: "last_notice_d40",
    event: "reminder_sent",
    template: "last_notice_d40",
    maxSendCount: MAX_SENDS_PER_CASE - 2,
  },
  {
    kind: "escalation_d45",
    event: "escalate",
    template: "escalation_d45",
    maxSendCount: MAX_SENDS_PER_CASE - 1,
  },
]);

/**
 * THE rule for "an operator reply stops the schedule" (ARCHITECTURE §6): reminders run only for
 * a case in `sent`. Any reply moves `sent` to `reply_received` (C4), so an auto-acknowledgement
 * stops the reminders too and the case only closes at 3 months. Open with the owner on tracker
 * #26; to keep reminding after an acknowledgement, add `reply_received` here and allow
 * `reply_received --reminder_sent-->` in the state machine.
 */
export function remindersRunIn(status: CaseStatus): boolean {
  return status === "sent";
}

/** The d45 escalation also follows a denial that got no answer (state machine: denied → escalated). */
function escalationRunsIn(status: CaseStatus): boolean {
  return remindersRunIn(status) || status === "denied";
}

/**
 * States the 3-month close applies to: sent and not finished. Closing a resolved case is C6's
 * responsibility.
 */
const CLOSES_AT_3_MONTHS: ReadonlySet<CaseStatus> = new Set<CaseStatus>([
  "sent",
  "reply_received",
  "waiting_user",
  "escalated",
  "denied",
]);

/** The statuses the tick looks at. */
export const TIMER_STATUSES: readonly CaseStatus[] = [...CLOSES_AT_3_MONTHS];

// --- Calendar months in Europe/Madrid --------------------------------------------------------

const MADRID = "Europe/Madrid";
const wallFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: MADRID,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** The Madrid wall clock at `ms`, read as if it were UTC (so offset = result − ms). */
function madridWallAsUtc(ms: number): number {
  const p = Object.fromEntries(
    wallFormat.formatToParts(ms).map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) + (((ms % 1000) + 1000) % 1000)
  );
}

/** The instant a Madrid clock shows the wall time `wall` (given as a UTC-read timestamp). */
function fromMadridWall(wall: number): number {
  let t = wall - (madridWallAsUtc(wall) - wall);
  t = wall - (madridWallAsUtc(t) - t); // corrected once at the real instant (DST edges)
  return t;
}

/**
 * Calendar months in Europe/Madrid, clamped to the last day of a shorter month
 * (30 Nov + 3 = 28 Feb), keeping the Madrid wall-clock time.
 */
export function addMonths(date: Date, months: number): Date {
  const wall = new Date(madridWallAsUtc(date.getTime()));
  const day = wall.getUTCDate();
  wall.setUTCDate(1);
  wall.setUTCMonth(wall.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 0)).getUTCDate();
  wall.setUTCDate(Math.min(day, lastDay));
  return new Date(fromMadridWall(wall.getTime()));
}

/** The Madrid calendar date (YYYY-MM-DD) of an instant, as the templates cite it. */
export function madridDate(at: string | Date): string {
  return new Date(madridWallAsUtc(new Date(at).getTime())).toISOString().slice(0, 10);
}

/** When a case closes: 3 calendar months (Madrid) after the claim was sent (ARCHITECTURE §6). */
export function closeAt(sentAt: string | Date): Date {
  return addMonths(new Date(sentAt), 3);
}

/**
 * When a stage may be sent: from `start` (inclusive) to `end` (exclusive). A stage missed while
 * paused is skipped, never sent late.
 * - d12: days 12 to 15;
 * - d30: from max(day 30, one calendar month), the legal month to answer, until day 40;
 * - d40: days 40 to 44;
 * - d45: from day 45 until the 3-month close.
 */
export function stageWindow(kind: StageKind, sentAt: string | Date): { start: Date; end: Date } {
  const sent = new Date(sentAt).getTime();
  const day = (n: number) => new Date(sent + n * DAY_MS);
  switch (kind) {
    case "reminder_d12":
      return { start: day(12), end: day(16) };
    case "reminder_d30": {
      const month = addMonths(new Date(sent), 1);
      return { start: month > day(30) ? month : day(30), end: day(40) };
    }
    case "last_notice_d40":
      return { start: day(40), end: day(45) };
    case "escalation_d45":
      return { start: day(45), end: closeAt(new Date(sent)) };
  }
}

// --- dueActions -----------------------------------------------------------------------------

/** What dueActions needs to know about a case. `fired` comes from its `timer_action` events. */
export interface TimerCase {
  status: CaseStatus;
  sentAt: string | null;
  paused: boolean;
  sendCount: number;
  fired: readonly string[];
}

export interface DueAction {
  kind: TimerActionKind;
  event: CaseTransitionEvent;
  template: TemplateKind;
  /** Operator mail goes to the operator's verified address; the close notice to the user. */
  recipient: "operator" | "user";
  from: CaseStatus;
  to: CaseStatus;
  /** True for mail to the operator: it increments send_count and respects the cap. */
  countsTowardCap: boolean;
  /** Whole days since sent_at. */
  day: number;
}

export interface DueResult {
  /** At most one action: a tick never sends a burst of overdue reminders. */
  actions: DueAction[];
  /**
   * When to look at the case again (null: never, the schedule is over). With an action, it is
   * the look after that action, whether the tick applies it or has to skip it.
   */
  nextActionAt: Date | null;
}

/**
 * What the §6 schedule says to do for `c` at `now`. Rules, in order:
 * 1. Only cases that were sent and are not finished have timers.
 * 2. 3 months after sending: close and tell the user. Applies even when paused or replied.
 * 3. Paused (the `paused` flag or `waiting_user`): nothing else; the schedule waits.
 * 4. An operator reply stops reminders (remindersRunIn); a denial can still escalate on d45.
 * 5. Each stage fires at most once, only inside its window, and never past the send cap.
 *
 * nextActionAt never depends on the status or the pause, so a case that resumes (back to sent,
 * unpaused) is looked at again on time: the next unfired stage's start, a daily look while a
 * window is open, or the close date if earlier.
 */
export function dueActions(c: TimerCase, now: Date): DueResult {
  if (!c.sentAt || !CLOSES_AT_3_MONTHS.has(c.status) || c.fired.includes("close_3m")) {
    return { actions: [], nextActionAt: null };
  }
  const sentAt = c.sentAt;
  const closing = closeAt(sentAt);
  const day = Math.floor((now.getTime() - Date.parse(sentAt)) / DAY_MS);

  if (now.getTime() >= closing.getTime()) {
    return {
      actions: [
        {
          kind: "close_3m",
          event: "close",
          template: "user_final_result",
          recipient: "user",
          from: c.status,
          to: "closed",
          countsTowardCap: false,
          day,
        },
      ],
      nextActionAt: null,
    };
  }

  const open = TIMER_ACTIONS.find((s) => {
    if (c.fired.includes(s.kind)) return false;
    const w = stageWindow(s.kind, sentAt);
    return now >= w.start && now < w.end;
  });
  const paused = c.paused || c.status === "waiting_user";
  const runs =
    open &&
    !paused &&
    c.sendCount <= open.maxSendCount &&
    (open.kind === "escalation_d45" ? escalationRunsIn(c.status) : remindersRunIn(c.status));

  if (open && runs) {
    return {
      actions: [
        {
          kind: open.kind,
          event: open.event,
          template: open.template,
          recipient: "operator",
          from: c.status,
          to: open.event === "escalate" ? "escalated" : c.status,
          countsTowardCap: true,
          day,
        },
      ],
      nextActionAt: nextLook(sentAt, [...c.fired, open.kind], now, closing),
    };
  }
  return { actions: [], nextActionAt: nextLook(sentAt, c.fired, now, closing) };
}

/** The earliest of: each unfired stage's start (or tomorrow, while its window is open), the close. */
function nextLook(sentAt: string, fired: readonly string[], now: Date, closing: Date): Date {
  let next = closing.getTime();
  for (const s of TIMER_ACTIONS) {
    if (fired.includes(s.kind)) continue;
    const w = stageWindow(s.kind, sentAt);
    const t =
      now < w.start
        ? w.start.getTime()
        : now < w.end
          ? Math.min(now.getTime() + RECHECK_MS, w.end.getTime())
          : Infinity;
    next = Math.min(next, t);
  }
  return new Date(next);
}
