import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/claims/tick/route";
import { renderTemplate } from "@/features/documents";
import { getOperatorConfig } from "@/features/rules";
import { runTick } from "@/features/claims/tick";
import { stageWindow } from "@/features/claims/timers";
import type { CaseStatus } from "@/shared/contracts";
import type { TablesUpdate } from "@/shared/supabase";
import { createServiceClient } from "@/shared/supabase/server";

// /api/claims/tick against the local Supabase (plan C7). Cases are inserted directly with the
// service client, so these tests don't depend on createCase (C2).
const db = createServiceClient();
const SECRET = "test-tick-secret-0123456789abcdef";
const DAY = 86_400_000;
const T = new Date("2030-01-31T09:00:00.000Z"); // the tick's `now` in most of these tests
const ago = (days: number, from: Date = T) => new Date(from.getTime() - days * DAY).toISOString();
const USER_EMAIL = "viajero@example.test";

const operatorAddress = (() => {
  const ch = getOperatorConfig("iryo").channel;
  if (ch.type !== "email") throw new Error("the iryo mock must have an email channel");
  return ch.address;
})();

type Seed = {
  status: CaseStatus;
  sentAt: string | null;
  operator?: "iryo" | "renfe" | "ouigo";
  sendCount?: number;
  paused?: boolean;
  nextActionAt?: string | null;
  fired?: { action: string; at?: string }[] | string[];
};

async function seed(s: Seed): Promise<string> {
  const { data, error } = await db
    .from("cases")
    .insert({
      operator: s.operator ?? "iryo",
      status: s.status,
      submission: {},
      user_email: USER_EMAIL,
      sent_at: s.sentAt,
      send_count: s.sendCount ?? 1,
      paused: s.paused ?? false,
      next_action_at: s.nextActionAt === undefined ? s.sentAt : s.nextActionAt,
    })
    .select("id")
    .single();
  if (error) throw error;
  for (const f of s.fired ?? []) {
    const fired = typeof f === "string" ? { action: f } : f;
    const { error: e } = await db
      .from("case_events")
      .insert({ case_id: data.id, kind: "timer_action", data: fired });
    if (e) throw e;
  }
  return data.id;
}

async function state(id: string) {
  const [c, ev, msg, all] = await Promise.all([
    db.from("cases").select("*").eq("id", id).single(),
    db.from("case_events").select("*").eq("case_id", id).eq("kind", "timer_action"),
    db.from("messages").select("*").eq("case_id", id),
    db.from("case_events").select("*").eq("case_id", id),
  ]);
  if (c.error || ev.error || msg.error || all.error) throw c.error ?? ev.error ?? msg.error;
  return { case: c.data, events: ev.data, messages: msg.data, allEvents: all.data };
}

const actionOf = (e: { data: unknown }) => (e.data as { action: string }).action;

const tick = (body: unknown = { now: T.toISOString() }, auth: string | null = `Bearer ${SECRET}`) =>
  POST(
    new Request("http://localhost/api/claims/tick", {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(body),
    }),
  );

type TickBody = {
  now: string;
  actions: { caseId: string; action: string }[];
  skipped: { caseId: string; action: string; reason: string }[];
  failed: { caseId: string; action: string }[];
};

// The database is shared by every integration file: raise the tick's 100-row outbound limit so rows
// left by other files can never crowd out this file's own (the production default is unchanged).
const saved = {
  TICK_SECRET: process.env.TICK_SECRET,
  DEMO_MODE: process.env.DEMO_MODE,
  OUTBOUND_TICK_LIMIT: process.env.OUTBOUND_TICK_LIMIT,
};
beforeAll(() => {
  process.env.TICK_SECRET = SECRET;
  process.env.DEMO_MODE = "1";
  process.env.OUTBOUND_TICK_LIMIT = "100000";
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("POST /api/claims/tick: auth", () => {
  it("401 without an Authorization header", async () => {
    expect((await tick(undefined, null)).status).toBe(401);
  });

  it("401 with a wrong bearer token", async () => {
    expect((await tick(undefined, "Bearer wrong")).status).toBe(401);
    expect((await tick(undefined, SECRET)).status).toBe(401);
  });

  it("401 when TICK_SECRET is unset, whatever the token", async () => {
    delete process.env.TICK_SECRET;
    try {
      expect((await tick(undefined, "Bearer ")).status).toBe(401);
      expect((await tick(undefined, `Bearer ${SECRET}`)).status).toBe(401);
    } finally {
      process.env.TICK_SECRET = SECRET;
    }
  });

  it("an unauthorised call changes nothing", async () => {
    const id = await seed({ status: "sent", sentAt: ago(12) });
    await tick(undefined, "Bearer wrong");
    const s = await state(id);
    expect(s.events).toEqual([]);
    expect(s.messages).toEqual([]);
  });
});

describe("POST /api/claims/tick: processing", () => {
  it("processes exactly the due cases, and a second run is idempotent", async () => {
    const ids = {
      d12: await seed({ status: "sent", sentAt: ago(12) }),
      // Day 31: one calendar month after sending, whatever the month (31-day-month rule).
      d30: await seed({ status: "sent", sentAt: ago(31), sendCount: 2, fired: ["reminder_d12"] }),
      notYet: await seed({ status: "sent", sentAt: ago(5), nextActionAt: ago(-7) }),
      replied: await seed({ status: "reply_received", sentAt: ago(30) }),
      waitingUser: await seed({ status: "waiting_user", sentAt: ago(13) }),
      paused: await seed({ status: "sent", sentAt: ago(13), paused: true }),
      capped: await seed({ status: "sent", sentAt: ago(12), sendCount: 6 }),
      inactive: await seed({ status: "sent", sentAt: ago(12), operator: "renfe" }),
      waitingPeriod: await seed({ status: "waiting_period", sentAt: null, nextActionAt: ago(1) }),
      close: await seed({
        status: "escalated",
        sentAt: ago(100),
        sendCount: 5,
        fired: ["reminder_d12", "reminder_d30", "last_notice_d40", "escalation_d45"],
      }),
    };
    const before = Object.fromEntries(
      await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, await state(id)] as const)),
    );

    const res = await tick();
    expect(res.status).toBe(200);
    const body = (await res.json()) as TickBody;
    expect(body.now).toBe(T.toISOString());
    const mine = new Set(Object.values(ids));
    expect(
      body.actions
        .filter((a) => mine.has(a.caseId))
        .map((a) => [a.caseId, a.action])
        .sort(),
    ).toEqual(
      [
        [ids.d12, "reminder_d12"],
        [ids.d30, "reminder_d30"],
        [ids.close, "close_3m"],
      ].sort(),
    );
    expect(body.failed.filter((f) => mine.has(f.caseId))).toEqual([]);

    // d12: friendly reminder queued to the operator's verified address.
    const d12 = await state(ids.d12);
    expect(d12.case.status).toBe("sent");
    expect(d12.case.send_count).toBe(2);
    expect(Date.parse(d12.case.next_action_at!)).toBe(
      stageWindow("reminder_d30", ago(12)).start.getTime(),
    );
    expect(d12.events).toHaveLength(1);
    expect(d12.events[0]).toMatchObject({ from_status: "sent", to_status: "sent" });
    // No personal data in the event: only the action, the day and when it fired.
    expect(d12.events[0].data).toEqual({ action: "reminder_d12", day: 12, at: T.toISOString() });
    expect(d12.messages).toHaveLength(1);
    // Queued by the timer step, then sent by the tick's outbound step (C3, fake transport).
    expect(d12.messages[0]).toMatchObject({
      direction: "outbound",
      status: "sent",
      to_address: operatorAddress,
    });
    expect(d12.messages[0].subject).toContain(`[${d12.case.public_ref}]`);
    expect(d12.messages[0].body_text).toBeTruthy();

    const d30 = await state(ids.d30);
    expect(d30.case.send_count).toBe(3);
    expect(d30.events.map(actionOf).sort()).toEqual(["reminder_d12", "reminder_d30"]);
    expect(d30.messages).toHaveLength(1);

    // 3 months: closed, and the final result queued to the user. Not a send to the operator.
    const closed = await state(ids.close);
    expect(closed.case.status).toBe("closed");
    expect(closed.case.send_count).toBe(5);
    expect(closed.case.next_action_at).toBeNull();
    expect(closed.messages).toHaveLength(1);
    // Queued by the close, then sent to the case's own user by the outbound step (C3).
    expect(closed.messages[0]).toMatchObject({ status: "sent", to_address: USER_EMAIL });
    expect(closed.events.find((e) => actionOf(e) === "close_3m")).toMatchObject({
      from_status: "escalated",
      to_status: "closed",
    });
    expect(closed.allEvents.find((e) => e.kind === "user_notice_queued")?.data).toEqual({
      template: "user_final_result",
      message_id: closed.messages[0].id,
    });

    // Nothing for the cases that are not due, paused, stopped, capped or inactive.
    for (const k of [
      "notYet",
      "replied",
      "waitingUser",
      "paused",
      "capped",
      "inactive",
      "waitingPeriod",
    ] as const) {
      const s = await state(ids[k]);
      expect({ k, status: s.case.status, count: s.case.send_count }).toEqual({
        k,
        status: before[k].case.status,
        count: before[k].case.send_count,
      });
      expect({ k, events: s.events.length, messages: s.messages.length }).toEqual({
        k,
        events: before[k].events.length,
        messages: 0,
      });
    }

    // Skipped and paused cases move on: they don't come back on every tick (no starvation).
    expect(body.skipped.find((s) => s.caseId === ids.inactive)).toMatchObject({
      action: "reminder_d12",
      reason: "operator_inactive",
    });
    for (const k of ["inactive", "waitingUser", "paused", "capped", "replied"] as const) {
      const s = await state(ids[k]);
      expect({ k, later: Date.parse(s.case.next_action_at!) > T.getTime() }).toEqual({
        k,
        later: true,
      });
    }

    // Second run, same now: nothing new anywhere.
    const res2 = await tick();
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as TickBody;
    expect(body2.actions.filter((a) => mine.has(a.caseId))).toEqual([]);
    expect(body2.skipped.filter((a) => mine.has(a.caseId))).toEqual([]);
    for (const [k, id] of Object.entries(ids)) {
      const s = await state(id);
      const first = k === "d12" ? d12 : k === "d30" ? d30 : k === "close" ? closed : null;
      if (first) {
        expect({ k, e: s.allEvents.length, m: s.messages.length, n: s.case.send_count }).toEqual({
          k,
          e: first.allEvents.length,
          m: first.messages.length,
          n: first.case.send_count,
        });
      } else {
        expect({ k, m: s.messages.length }).toEqual({ k, m: 0 });
      }
    }
  });

  it("d45: escalated, the mail to the operator, and a filing-owed event without personal data", async () => {
    const id = await seed({
      status: "sent",
      sentAt: ago(45),
      sendCount: 4,
      fired: ["reminder_d12", "reminder_d30", "last_notice_d40"],
    });
    const body = (await (await tick()).json()) as TickBody;
    expect(body.actions).toContainEqual({ caseId: id, action: "escalation_d45" });
    const s = await state(id);
    expect(s.case.status).toBe("escalated");
    expect(s.case.send_count).toBe(5);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].to_address).toBe(operatorAddress);
    const filing = s.allEvents.filter((e) => e.kind === "escalation_filing_required");
    expect(filing).toHaveLength(1);
    expect(filing[0].data).toEqual({ bodies: ["dgtt", "junta_arbitral"], day: 45 });
  });

  it("passes the dates the earlier stages were sent to the template", async () => {
    const sentAt = ago(40);
    const id = await seed({
      status: "sent",
      sentAt,
      sendCount: 3,
      fired: [
        { action: "reminder_d12", at: "2029-12-04T09:00:00.000Z" },
        { action: "reminder_d30", at: "2029-12-23T09:00:00.000Z" },
      ],
    });
    const calls: { kind: string; vars: Record<string, string> }[] = [];
    const result = await runTick(db, T, {
      render: (kind, operator, vars) => {
        calls.push({ kind, vars });
        return renderTemplate(kind, operator, vars);
      },
    });
    expect(result.actions).toContainEqual({ caseId: id, action: "last_notice_d40" });
    const ref = (await state(id)).case.public_ref;
    expect(calls.find((c) => c.vars.ref === ref)).toEqual({
      kind: "last_notice_d40",
      vars: {
        ref,
        sentDate: "2029-12-22",
        day: "40",
        reminderD12Date: "2029-12-04",
        reminderD30Date: "2029-12-23",
      },
    });
  });

  it("a failing outbox write leaves nothing behind, and the next tick retries", async () => {
    const id = await seed({ status: "sent", sentAt: ago(12) });
    const before = await state(id);
    // A rendered template without a subject: the messages insert fails (NOT NULL).
    const broken = await runTick(db, T, {
      render: () => ({ subject: null as unknown as string, text: "x" }),
    });
    expect(broken.failed).toContainEqual({ caseId: id, action: "reminder_d12" });
    expect(broken.actions.find((a) => a.caseId === id)).toBeUndefined();
    const after = await state(id);
    expect(after.allEvents).toEqual([]);
    expect(after.messages).toEqual([]);
    expect(after.case).toEqual(before.case);

    const retry = await runTick(db, T);
    expect(retry.actions).toContainEqual({ caseId: id, action: "reminder_d12" });
    const s = await state(id);
    expect(s.events.map(actionOf)).toEqual(["reminder_d12"]);
    expect(s.messages).toHaveLength(1);
    expect(s.case.send_count).toBe(2);
  });

  it("two ticks at once still send each reminder once", async () => {
    const id = await seed({ status: "sent", sentAt: ago(12) });
    const results = await Promise.all([tick(), tick(), tick()]);
    for (const r of results) expect(r.status).toBe(200);
    const s = await state(id);
    expect(s.events).toHaveLength(1);
    expect(s.messages).toHaveLength(1);
    expect(s.case.send_count).toBe(2);
  });

  it("ignores the now override without DEMO_MODE", async () => {
    // Sent yesterday: due on day 12 only if the override were honoured.
    const sentAt = new Date(Date.now() - DAY).toISOString();
    const id = await seed({ status: "sent", sentAt });
    const override = new Date(Date.now() + 20 * DAY).toISOString();
    delete process.env.DEMO_MODE;
    try {
      const before = Date.now();
      const res = await tick({ now: override });
      expect(res.status).toBe(200);
      const body = (await res.json()) as TickBody;
      expect(Date.parse(body.now)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(body.now)).toBeLessThanOrEqual(Date.now() + 1000);
      const s = await state(id);
      expect(s.events).toEqual([]);
      expect(s.messages).toEqual([]);
    } finally {
      process.env.DEMO_MODE = "1";
    }
  });

  it("400 for a now override that is not a date-time in DEMO_MODE", async () => {
    expect((await tick({ now: "tomorrow" })).status).toBe(400);
  });
});

describe("runTick: resume after a pause", () => {
  // February, so day 30 is also one calendar month after sending.
  const S = "2031-02-10T09:00:00.000Z";
  const at = (days: number) => new Date(Date.parse(S) + days * DAY);
  const d30 = () => stageWindow("reminder_d30", S).start;

  async function resumeCase(seedAs: Partial<Seed>, resume: TablesUpdate<"cases">): Promise<string> {
    const id = await seed({
      status: "sent",
      sentAt: S,
      nextActionAt: at(12).toISOString(),
      ...seedAs,
    });
    const first = await runTick(db, at(12));
    expect(first.actions.find((a) => a.caseId === id)).toBeUndefined();
    const parked = await state(id);
    // Looked at again soon, never parked until the 3-month close.
    expect(Date.parse(parked.case.next_action_at!)).toBeLessThanOrEqual(d30().getTime());
    const { error } = await db.from("cases").update(resume).eq("id", id);
    if (error) throw error;
    return id;
  }

  it("waiting_user on day 12, back in sent on day 14: the d30 reminder fires", async () => {
    const id = await resumeCase({ status: "waiting_user" }, { status: "sent" });
    const r = await runTick(db, d30());
    expect(r.actions).toContainEqual({ caseId: id, action: "reminder_d30" });
  });

  it("paused on day 12, unpaused later: the d30 reminder fires", async () => {
    const id = await resumeCase({ paused: true }, { paused: false });
    const r = await runTick(db, d30());
    expect(r.actions).toContainEqual({ caseId: id, action: "reminder_d30" });
  });

  it("denied on day 12, back in sent after the insistence: the d30 reminder fires", async () => {
    const id = await resumeCase({ status: "denied" }, { status: "sent", send_count: 2 });
    const r = await runTick(db, d30());
    expect(r.actions).toContainEqual({ caseId: id, action: "reminder_d30" });
    expect((await state(id)).case.send_count).toBe(3);
  });
});
