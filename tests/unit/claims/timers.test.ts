import { describe, expect, it } from "vitest";
import { fixedClock } from "@/shared/clock";
import type { CaseStatus } from "@/shared/contracts";
import { transition } from "@/features/claims/state-machine";
import {
  MAX_SENDS_PER_CASE,
  TIMER_ACTIONS,
  addMonths,
  closeAt,
  dueActions,
  remindersRunIn,
  type TimerActionKind,
  type TimerCase,
} from "@/features/claims/timers";

// The §6 schedule (ARCHITECTURE §6, plan C7, README §4 item 6), with a fixed clock.
const SENT_AT = "2026-01-10T09:00:00.000Z";
const DAY = 86_400_000;
const day = (n: number, extraMs = 0) =>
  fixedClock(new Date(Date.parse(SENT_AT) + n * DAY + extraMs));

const sentCase = (over: Partial<TimerCase> = {}): TimerCase => ({
  status: "sent",
  sentAt: SENT_AT,
  paused: false,
  sendCount: 1, // the initial claim
  fired: [],
  ...over,
});

const kinds = (c: TimerCase, clock: ReturnType<typeof fixedClock>) =>
  dueActions(c, clock.now()).actions.map((a) => a.kind);

describe("dueActions: day boundaries for a case nobody answered", () => {
  it("day 0 and day 11: nothing yet; the next action is day 12", () => {
    expect(kinds(sentCase(), day(0))).toEqual([]);
    const r = dueActions(sentCase(), day(11, DAY - 1).now());
    expect(r.actions).toEqual([]);
    expect(r.nextActionAt?.toISOString()).toBe(day(12).now().toISOString());
  });

  it("day 12: the friendly reminder, to the operator, counting towards the cap", () => {
    const [a, ...rest] = dueActions(sentCase(), day(12).now()).actions;
    expect(rest).toEqual([]);
    expect(a).toMatchObject({
      kind: "reminder_d12",
      event: "reminder_sent",
      template: "reminder_d12",
      recipient: "operator",
      from: "sent",
      to: "sent",
      countsTowardCap: true,
    });
  });

  it("day 15: the friendly reminder is still due if it has not gone out", () => {
    expect(kinds(sentCase(), day(15))).toEqual(["reminder_d12"]);
  });

  it("day 15 after the friendly reminder: nothing; the next action is day 30", () => {
    const r = dueActions(sentCase({ fired: ["reminder_d12"], sendCount: 2 }), day(15).now());
    expect(r.actions).toEqual([]);
    expect(r.nextActionAt?.toISOString()).toBe(day(30).now().toISOString());
  });

  it("the friendly reminder window is days 12 to 15: on day 16 it is no longer sent", () => {
    const r = dueActions(sentCase(), day(16).now());
    expect(r.actions).toEqual([]);
    expect(r.nextActionAt?.toISOString()).toBe(day(30).now().toISOString());
  });

  it("day 29: nothing", () => {
    expect(kinds(sentCase({ fired: ["reminder_d12"], sendCount: 2 }), day(29, DAY - 1))).toEqual(
      [],
    );
  });

  it("day 30: the legal reminder", () => {
    const c = sentCase({ fired: ["reminder_d12"], sendCount: 2 });
    expect(kinds(c, day(30))).toEqual(["reminder_d30"]);
  });

  it("day 39: nothing; the next action is day 40", () => {
    const c = sentCase({ fired: ["reminder_d12", "reminder_d30"], sendCount: 3 });
    const r = dueActions(c, day(39, DAY - 1).now());
    expect(r.actions).toEqual([]);
    expect(r.nextActionAt?.toISOString()).toBe(day(40).now().toISOString());
  });

  it("day 40: the last notice", () => {
    const c = sentCase({ fired: ["reminder_d12", "reminder_d30"], sendCount: 3 });
    const [a] = dueActions(c, day(40).now()).actions;
    expect(a).toMatchObject({ kind: "last_notice_d40", event: "reminder_sent", to: "sent" });
  });

  it("day 44: nothing", () => {
    const c = sentCase({
      fired: ["reminder_d12", "reminder_d30", "last_notice_d40"],
      sendCount: 4,
    });
    expect(kinds(c, day(44, DAY - 1))).toEqual([]);
  });

  it("day 45: the escalation moves the case to escalated", () => {
    const c = sentCase({
      fired: ["reminder_d12", "reminder_d30", "last_notice_d40"],
      sendCount: 4,
    });
    const [a] = dueActions(c, day(45).now()).actions;
    expect(a).toMatchObject({
      kind: "escalation_d45",
      event: "escalate",
      template: "escalation_d45",
      from: "sent",
      to: "escalated",
    });
  });

  it("3 months − 1 day after the escalation: nothing; the next action is the 3-month close", () => {
    const c: TimerCase = {
      ...sentCase({ sendCount: 5 }),
      status: "escalated",
      fired: ["reminder_d12", "reminder_d30", "last_notice_d40", "escalation_d45"],
    };
    const threeMonths = addMonths(new Date(SENT_AT), 3);
    const r = dueActions(c, new Date(threeMonths.getTime() - DAY));
    expect(r.actions).toEqual([]);
    expect(r.nextActionAt?.toISOString()).toBe(threeMonths.toISOString());
  });

  it("3 months: close, and a final-result notice to the user that does not count as a send", () => {
    const c: TimerCase = {
      ...sentCase({ sendCount: 5 }),
      status: "escalated",
      fired: ["reminder_d12", "reminder_d30", "last_notice_d40", "escalation_d45"],
    };
    const r = dueActions(c, addMonths(new Date(SENT_AT), 3));
    expect(r.actions).toEqual([
      expect.objectContaining({
        kind: "close_3m",
        event: "close",
        template: "user_final_result",
        recipient: "user",
        from: "escalated",
        to: "closed",
        countsTowardCap: false,
      }),
    ]);
    expect(r.nextActionAt).toBeNull();
  });

  it("3 months is calendar months, clamped to the end of a shorter month", () => {
    expect(closeAt(SENT_AT).toISOString()).toBe("2026-04-10T09:00:00.000Z");
    expect(addMonths(new Date("2026-11-30T10:00:00.000Z"), 3).toISOString()).toBe(
      "2027-02-28T10:00:00.000Z",
    );
  });

  it("each reminder fires at most once", () => {
    for (const k of ["reminder_d12", "reminder_d30", "last_notice_d40"] as const) {
      const at = { reminder_d12: 12, reminder_d30: 30, last_notice_d40: 40 }[k];
      expect(kinds(sentCase({ fired: [k] }), day(at))).not.toContain(k);
    }
  });

  it("returns at most one action per tick, never a burst of overdue reminders", () => {
    // Paused across days 12–41 and resumed on day 42: only the current stage is sent.
    expect(kinds(sentCase(), day(42))).toEqual(["last_notice_d40"]);
  });

  it("every action is a legal move of the state machine", () => {
    const statuses: CaseStatus[] = [
      "sent",
      "denied",
      "reply_received",
      "waiting_user",
      "escalated",
    ];
    for (const status of statuses) {
      for (let d = 0; d <= 100; d++) {
        for (const a of dueActions(sentCase({ status }), day(d).now()).actions) {
          expect(transition(a.from, a.event)).toBe(a.to);
        }
      }
    }
  });
});

describe("dueActions: pause and resume", () => {
  it("waiting on the user (waiting_user) pauses the schedule", () => {
    const r = dueActions(sentCase({ status: "waiting_user" }), day(12).now());
    expect(r.actions).toEqual([]);
    expect(r.nextActionAt?.toISOString()).toBe(closeAt(SENT_AT).toISOString());
  });

  it("the paused flag pauses the schedule", () => {
    expect(kinds(sentCase({ paused: true }), day(12))).toEqual([]);
    expect(kinds(sentCase({ paused: true }), day(45))).toEqual([]);
  });

  it("resuming (back to sent, unpaused) sends what is due now", () => {
    expect(kinds(sentCase({ paused: false }), day(13))).toEqual(["reminder_d12"]);
    expect(kinds(sentCase({ status: "sent", fired: ["reminder_d12"] }), day(31))).toEqual([
      "reminder_d30",
    ]);
  });

  it("the 3-month close still applies while paused", () => {
    const closing = addMonths(new Date(SENT_AT), 3);
    expect(dueActions(sentCase({ paused: true }), closing).actions.map((a) => a.kind)).toEqual([
      "close_3m",
    ]);
    expect(
      dueActions(sentCase({ status: "waiting_user" }), closing).actions.map((a) => a.kind),
    ).toEqual(["close_3m"]);
  });
});

describe("dueActions: an operator reply stops the schedule", () => {
  it("reply_received gets no reminder and no escalation", () => {
    for (const d of [12, 15, 30, 40, 45, 60]) {
      expect(kinds(sentCase({ status: "reply_received" }), day(d))).toEqual([]);
    }
  });

  it("an escalated case gets no more reminders", () => {
    expect(kinds(sentCase({ status: "escalated", fired: ["escalation_d45"] }), day(46))).toEqual(
      [],
    );
  });

  // Open with the owner on tracker #26: an auto-acknowledgement ("we received your claim")
  // currently stops the schedule like any other reply. The single rule is remindersRunIn().
  it("auto-acknowledgement: an acknowledged case (reply_received) gets no reminders and only closes at 3 months", () => {
    const acknowledged = sentCase({ status: "reply_received" });
    expect(remindersRunIn("reply_received")).toBe(false);
    for (let d = 0; d < 89; d++) expect(kinds(acknowledged, day(d))).toEqual([]);
    const threeMonths = closeAt(SENT_AT);
    expect(dueActions(acknowledged, new Date(threeMonths.getTime() - DAY)).actions).toEqual([]);
    expect(dueActions(acknowledged, new Date(threeMonths.getTime() - DAY)).nextActionAt).toEqual(
      threeMonths,
    );
    expect(dueActions(acknowledged, threeMonths).actions.map((a) => a.kind)).toEqual(["close_3m"]);
  });

  it("a denial left without an answer escalates on day 45, never reminds", () => {
    expect(kinds(sentCase({ status: "denied" }), day(30))).toEqual([]);
    expect(kinds(sentCase({ status: "denied" }), day(40))).toEqual([]);
    const [a] = dueActions(sentCase({ status: "denied" }), day(45).now()).actions;
    expect(a).toMatchObject({ kind: "escalation_d45", from: "denied", to: "escalated" });
  });

  it("terminal and unsent cases have no timers", () => {
    const statuses: CaseStatus[] = ["draft", "waiting_period", "resolved", "closed"];
    for (const status of statuses) {
      const r = dueActions(sentCase({ status }), addMonths(new Date(SENT_AT), 4));
      expect(r).toEqual({ actions: [], nextActionAt: null });
    }
    expect(dueActions(sentCase({ sentAt: null }), day(20).now())).toEqual({
      actions: [],
      nextActionAt: null,
    });
  });

  it("a case already closed by the timer is never closed twice", () => {
    expect(
      dueActions(sentCase({ fired: ["close_3m"] }), addMonths(new Date(SENT_AT), 4)).actions,
    ).toEqual([]);
  });
});

describe("dueActions: the per-case send cap", () => {
  it("is a constant shared by every operator", () => {
    expect(MAX_SENDS_PER_CASE).toBe(6);
  });

  it("no mail to the operator once the cap is reached", () => {
    const capped = sentCase({ sendCount: MAX_SENDS_PER_CASE });
    expect(kinds(capped, day(12))).toEqual([]);
    expect(kinds({ ...capped, fired: ["reminder_d12"] }, day(30))).toEqual([]);
    expect(kinds({ ...capped, status: "denied" }, day(45))).toEqual([]);
    expect(dueActions(capped, day(12).now()).nextActionAt).toEqual(closeAt(SENT_AT));
  });

  it("one below the cap still sends", () => {
    expect(kinds(sentCase({ sendCount: MAX_SENDS_PER_CASE - 1 }), day(12))).toEqual([
      "reminder_d12",
    ]);
  });

  it("the cap never blocks the 3-month close", () => {
    const capped = sentCase({ sendCount: MAX_SENDS_PER_CASE + 3 });
    expect(kinds(capped, fixedClock(closeAt(SENT_AT)))).toEqual(["close_3m"]);
  });
});

describe("TIMER_ACTIONS", () => {
  it("lists the §6 schedule in order", () => {
    expect(TIMER_ACTIONS.map((a) => a.kind)).toEqual<TimerActionKind[]>([
      "reminder_d12",
      "reminder_d30",
      "last_notice_d40",
      "escalation_d45",
    ]);
  });
});
