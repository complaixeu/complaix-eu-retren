import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/claims/tick/route";
import { getOperatorConfig } from "@/features/rules";
import { addMonths } from "@/features/claims/timers";
import type { CaseStatus } from "@/shared/contracts";
import { createServiceClient } from "@/shared/supabase/server";

// /api/claims/tick against the local Supabase (plan C7). Cases are inserted directly with the
// service client because createCase (C2) is not merged yet.
const db = createServiceClient();
const SECRET = "test-tick-secret-0123456789abcdef";
const DAY = 86_400_000;
const T = new Date("2030-01-31T09:00:00.000Z"); // the tick's `now` in these tests
const ago = (days: number) => new Date(T.getTime() - days * DAY).toISOString();
const USER_EMAIL = "viajero@example.test";

type Seed = {
  status: CaseStatus;
  sentAt: string | null;
  operator?: "iryo" | "renfe" | "ouigo";
  sendCount?: number;
  paused?: boolean;
  nextActionAt?: string | null;
  fired?: string[];
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
  for (const action of s.fired ?? []) {
    const { error: e } = await db
      .from("case_events")
      .insert({ case_id: data.id, kind: "timer_action", data: { action } });
    if (e) throw e;
  }
  return data.id;
}

async function state(id: string) {
  const [c, ev, msg] = await Promise.all([
    db.from("cases").select("*").eq("id", id).single(),
    db.from("case_events").select("*").eq("case_id", id).eq("kind", "timer_action"),
    db.from("messages").select("*").eq("case_id", id),
  ]);
  if (c.error || ev.error || msg.error) throw c.error ?? ev.error ?? msg.error;
  return { case: c.data, events: ev.data, messages: msg.data };
}

const tick = (body: unknown = { now: T.toISOString() }, auth: string | null = `Bearer ${SECRET}`) =>
  POST(
    new Request("http://localhost/api/claims/tick", {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(body),
    }),
  );

type TickBody = { now: string; actions: { caseId: string; action: string }[] };

const saved = { TICK_SECRET: process.env.TICK_SECRET, DEMO_MODE: process.env.DEMO_MODE };
beforeAll(() => {
  process.env.TICK_SECRET = SECRET;
  process.env.DEMO_MODE = "1";
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
    const operatorAddress = (() => {
      const ch = getOperatorConfig("iryo").channel;
      if (ch.type !== "email") throw new Error("the iryo mock must have an email channel");
      return ch.address;
    })();

    const ids = {
      d12: await seed({ status: "sent", sentAt: ago(12) }),
      d30: await seed({ status: "sent", sentAt: ago(30), sendCount: 2, fired: ["reminder_d12"] }),
      notYet: await seed({ status: "sent", sentAt: ago(5), nextActionAt: ago(-7) }),
      replied: await seed({ status: "reply_received", sentAt: ago(30) }),
      waitingUser: await seed({ status: "waiting_user", sentAt: ago(13) }),
      paused: await seed({ status: "sent", sentAt: ago(13), paused: true }),
      capped: await seed({ status: "sent", sentAt: ago(12), sendCount: 6 }),
      inactive: await seed({ status: "sent", sentAt: ago(12), operator: "renfe" }),
      waitingPeriod: await seed({ status: "waiting_period", sentAt: null, nextActionAt: ago(1) }),
      close: await seed({
        status: "escalated",
        sentAt: addMonths(T, -3).toISOString(),
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

    // d12: friendly reminder queued to the operator's verified address.
    const d12 = await state(ids.d12);
    expect(d12.case.status).toBe("sent");
    expect(d12.case.send_count).toBe(2);
    expect(Date.parse(d12.case.next_action_at!)).toBe(Date.parse(ago(-18))); // day 30
    expect(d12.events).toHaveLength(1);
    expect(d12.events[0]).toMatchObject({ from_status: "sent", to_status: "sent" });
    // No personal data in the event: only the action and the day.
    expect(d12.events[0].data).toEqual({ action: "reminder_d12", day: 12 });
    expect(d12.messages).toHaveLength(1);
    expect(d12.messages[0]).toMatchObject({
      direction: "outbound",
      status: "queued",
      to_address: operatorAddress,
    });
    expect(d12.messages[0].subject).toContain(`[${d12.case.public_ref}]`);
    expect(d12.messages[0].body_text).toBeTruthy();

    const d30 = await state(ids.d30);
    expect(d30.case.send_count).toBe(3);
    expect(d30.events.map((e) => (e.data as { action: string }).action).sort()).toEqual([
      "reminder_d12",
      "reminder_d30",
    ]);
    expect(d30.messages).toHaveLength(1);

    // 3 months: closed, and the final result queued to the user. Not a send to the operator.
    const closed = await state(ids.close);
    expect(closed.case.status).toBe("closed");
    expect(closed.case.send_count).toBe(5);
    expect(closed.case.next_action_at).toBeNull();
    expect(closed.messages).toHaveLength(1);
    expect(closed.messages[0]).toMatchObject({ status: "queued", to_address: USER_EMAIL });
    const closeEvent = closed.events.find(
      (e) => (e.data as { action: string }).action === "close_3m",
    );
    expect(closeEvent).toMatchObject({ from_status: "escalated", to_status: "closed" });

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

    // Second run, same now: nothing new anywhere.
    const res2 = await tick();
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as TickBody;
    expect(body2.actions.filter((a) => mine.has(a.caseId))).toEqual([]);
    for (const [k, id] of Object.entries(ids)) {
      const s = await state(id);
      const first = k === "d12" ? d12 : k === "d30" ? d30 : k === "close" ? closed : null;
      if (first) {
        expect({ k, e: s.events.length, m: s.messages.length, n: s.case.send_count }).toEqual({
          k,
          e: first.events.length,
          m: first.messages.length,
          n: first.case.send_count,
        });
      } else {
        expect({ k, m: s.messages.length }).toEqual({ k, m: 0 });
      }
    }
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
