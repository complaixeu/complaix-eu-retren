// The follow-up schedule (ARCHITECTURE §6, docs/plans/C-claims.md C7). Pure: no DB, no clock.
// Internal to domain C: run by the tick (./tick.ts), not exported from index.ts.
import type { CaseStatus, TemplateKind } from "@/shared/contracts";
import type { CaseTransitionEvent } from "./state-machine";

const DAY_MS = 86_400_000;

/**
 * Most mails Retren sends to an operator for one case, so it is never treated as spam
 * (ARCHITECTURE §6): the initial claim, three reminders, the escalation and one insistence after
 * a denial. Every operator send (C3, C6, C7) increments `cases.send_count`.
 */
export const MAX_SENDS_PER_CASE = 6;

export type TimerActionKind =
  "reminder_d12" | "reminder_d30" | "last_notice_d40" | "escalation_d45" | "close_3m";

type Stage = {
  kind: Exclude<TimerActionKind, "close_3m">;
  /** First day (since sent_at) the stage is due. */
  fromDay: number;
  /** First day it is no longer sent: a stage missed while paused is skipped, never sent late. */
  untilDay: number;
  event: CaseTransitionEvent;
  template: TemplateKind;
};

/** The §6 schedule, in order. Days count whole 24-hour days since `sent_at` (UTC). */
export const TIMER_ACTIONS: readonly Stage[] = Object.freeze([
  {
    kind: "reminder_d12",
    fromDay: 12,
    untilDay: 16,
    event: "reminder_sent",
    template: "reminder_d12",
  },
  {
    kind: "reminder_d30",
    fromDay: 30,
    untilDay: 40,
    event: "reminder_sent",
    template: "reminder_d30",
  },
  {
    kind: "last_notice_d40",
    fromDay: 40,
    untilDay: 45,
    event: "reminder_sent",
    template: "last_notice_d40",
  },
  {
    kind: "escalation_d45",
    fromDay: 45,
    untilDay: Infinity,
    event: "escalate",
    template: "escalation_d45",
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

/** States the 3-month close applies to: sent and not finished. `resolved` is closed by C6. */
const CLOSES_AT_3_MONTHS: ReadonlySet<CaseStatus> = new Set<CaseStatus>([
  "sent",
  "reply_received",
  "waiting_user",
  "escalated",
  "denied",
]);

/** The statuses the tick looks at. */
export const TIMER_STATUSES: readonly CaseStatus[] = [...CLOSES_AT_3_MONTHS];

/** Calendar months in UTC, clamped to the last day of a shorter month (30 Nov + 3 = 28 Feb). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** When a case closes: 3 months after the claim was sent (ARCHITECTURE §6). */
export function closeAt(sentAt: string | Date): Date {
  return addMonths(new Date(sentAt), 3);
}

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
  /** When to look at the case again (null: never, the schedule is over). */
  nextActionAt: Date | null;
}

/**
 * What the §6 schedule says to do for `c` at `now`. Rules, in order:
 * 1. Only cases that were sent and are not finished have timers.
 * 2. 3 months after sending: close and tell the user. Applies even when paused or replied.
 * 3. Paused (the `paused` flag or `waiting_user`): nothing else; the schedule waits.
 * 4. An operator reply stops reminders (remindersRunIn); a denial can still escalate on d45.
 * 5. Each stage fires at most once, only inside its window, and never past the send cap.
 */
export function dueActions(c: TimerCase, now: Date): DueResult {
  if (!c.sentAt || !CLOSES_AT_3_MONTHS.has(c.status) || c.fired.includes("close_3m")) {
    return { actions: [], nextActionAt: null };
  }
  const sentMs = Date.parse(c.sentAt);
  const closing = closeAt(c.sentAt);
  const day = Math.floor((now.getTime() - sentMs) / DAY_MS);

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

  const paused = c.paused || c.status === "waiting_user";
  const underCap = c.sendCount < MAX_SENDS_PER_CASE;
  const runs = (s: Stage) =>
    s.kind === "escalation_d45" ? escalationRunsIn(c.status) : remindersRunIn(c.status);
  const candidates =
    paused || !underCap ? [] : TIMER_ACTIONS.filter((s) => runs(s) && !c.fired.includes(s.kind));

  const current = candidates.find((s) => day >= s.fromDay && day < s.untilDay);
  if (current) {
    const action: DueAction = {
      kind: current.kind,
      event: current.event,
      template: current.template,
      recipient: "operator",
      from: c.status,
      to: current.event === "escalate" ? "escalated" : c.status,
      countsTowardCap: true,
      day,
    };
    // The next look is whatever the schedule says once this action is done.
    const after = dueActions(
      { ...c, status: action.to, sendCount: c.sendCount + 1, fired: [...c.fired, action.kind] },
      now,
    );
    return { actions: [action], nextActionAt: after.actions.length ? now : after.nextActionAt };
  }

  const upcoming = candidates.find((s) => s.fromDay > day);
  return {
    actions: [],
    nextActionAt: earliest(upcoming ? stageStart(sentMs, upcoming) : null, closing),
  };
}

const stageStart = (sentMs: number, s: Stage) => new Date(sentMs + s.fromDay * DAY_MS);
const earliest = (a: Date | null, b: Date) => (a && a.getTime() < b.getTime() ? a : b);
