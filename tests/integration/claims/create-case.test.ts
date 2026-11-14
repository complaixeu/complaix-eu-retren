import { beforeAll, describe, expect, it } from "vitest";
import { createCase } from "@/features/claims";
import { fixedClock } from "@/shared/clock";
import { CreateCaseResult, EligibilityResult } from "@/shared/contracts";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { PII, submissionFixture } from "../../fixtures/claims/submission";

// createCase against the local Supabase (127.0.0.1, tests/integration/setup/env.ts): rows,
// events and the outbox, for the eligible, doubtful and not-eligible paths.
const clock = fixedClock("2026-01-16T10:00:00.000Z");
let db: ServiceClient;

beforeAll(() => {
  db = createServiceClient();
});

async function stored(caseId: string) {
  const [c, events, messages] = await Promise.all([
    db.from("cases").select("*").eq("id", caseId).single(),
    db.from("case_events").select("*").eq("case_id", caseId).order("kind"),
    db.from("messages").select("*").eq("case_id", caseId),
  ]);
  expect(c.error).toBeNull();
  expect(events.error).toBeNull();
  expect(messages.error).toBeNull();
  return { row: c.data!, events: events.data!, messages: messages.data! };
}

const noPersonalData = (data: unknown) => {
  const text = JSON.stringify(data);
  for (const value of Object.values(PII)) expect(text).not.toContain(value);
};

describe("createCase (local Supabase)", () => {
  it("eligible: a waiting_period case, a created event, the timer set, no outbox row", async () => {
    const out = await createCase(submissionFixture(90), { clock });
    expect(CreateCaseResult.parse(out)).toEqual(out);
    expect(out.publicRef).toMatch(/^RTN-[0-9A-F]{8}$/);
    expect(out.status).toBe("waiting_period");

    const { row, events, messages } = await stored(out.caseId);
    expect(row).toMatchObject({
      public_ref: out.publicRef,
      operator: "iryo",
      status: "waiting_period",
      user_email: PII.email,
      send_count: 0,
      paused: false,
      sent_at: null,
    });
    expect(row.submission).toEqual(submissionFixture(90));
    expect(row.eligibility).toEqual(out.eligibility);
    expect(Date.parse(row.next_action_at!)).toBe(Date.parse(out.eligibility.earliestSendAt!));
    expect(Date.parse(row.earliest_send_at!)).toBe(Date.parse(out.eligibility.earliestSendAt!));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "created",
      from_status: "draft",
      to_status: "waiting_period",
    });
    expect(events[0].data).toMatchObject({ event: "eligible", eligibility: "eligible" });
    noPersonalData(events[0].data);
    expect(messages).toEqual([]);
  });

  it("doubtful: also waits for the earliest send date", async () => {
    const doubtful = (): EligibilityResult => ({
      status: "doubtful",
      reason: "test: doubtful",
      delayMinutes: 75,
      earliestSendAt: "2026-01-18T09:00:00.000Z",
      appliedRules: ["test"],
      configVersion: "test",
    });
    const out = await createCase(submissionFixture(75), { clock, evaluateEligibility: doubtful });
    expect(out.status).toBe("waiting_period");
    expect(out.eligibility.status).toBe("doubtful");

    const { row, events, messages } = await stored(out.caseId);
    expect(row.status).toBe("waiting_period");
    expect(Date.parse(row.next_action_at!)).toBe(Date.parse("2026-01-18T09:00:00.000Z"));
    expect(events.map((e) => e.kind)).toEqual(["created"]);
    expect(events[0].data).toMatchObject({ event: "eligible", eligibility: "doubtful" });
    noPersonalData(events[0].data);
    expect(messages).toEqual([]);
  });

  it("not eligible: closed, and a user_final_result notice queued in the outbox", async () => {
    const out = await createCase(submissionFixture(20), { clock });
    expect(out.status).toBe("closed");

    const { row, events, messages } = await stored(out.caseId);
    expect(row).toMatchObject({ status: "closed", next_action_at: null });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      direction: "outbound",
      status: "queued",
      to_address: PII.email,
      category: null,
    });
    expect(messages[0].subject).toContain(`[${out.publicRef}]`);
    expect(messages[0].body_text).toBeTruthy();

    expect(events.map((e) => [e.kind, e.from_status, e.to_status])).toEqual([
      ["created", "draft", "closed"],
      ["user_notice_queued", null, null],
    ]);
    expect(events[1].data).toEqual({ template: "user_final_result", message_id: messages[0].id });
    for (const e of events) noPersonalData(e.data);
  });

  it("retries once when the generated reference already exists", async () => {
    const first = await createCase(submissionFixture(90), { clock });
    // The first reference the DB hands out collides with the case above.
    let handed = false;
    const colliding = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "rpc") return Reflect.get(target, prop, receiver);
        return (fn: string, args?: object) => {
          if (fn === "claims_new_public_ref" && !handed) {
            handed = true;
            return Promise.resolve({ data: first.publicRef, error: null });
          }
          return target.rpc(fn as never, args as never);
        };
      },
    });
    const out = await createCase(submissionFixture(90), { clock, db: colliding });
    expect(handed).toBe(true);
    expect(out.publicRef).not.toBe(first.publicRef);
    const { row, events } = await stored(out.caseId);
    expect(row.public_ref).toBe(out.publicRef);
    expect(events).toHaveLength(1);

    const { count } = await db
      .from("cases")
      .select("id", { count: "exact", head: true })
      .eq("public_ref", first.publicRef);
    expect(count).toBe(1);
  });
});
