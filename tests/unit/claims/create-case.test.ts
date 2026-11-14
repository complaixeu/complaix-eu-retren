import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { createCase } from "@/features/claims";
import {
  madridInstant,
  MissingEarliestSendAtError,
  planCase,
  toEligibilityInput,
  type CreateCaseDeps,
} from "@/features/claims/create-case";
import { fixedClock } from "@/shared/clock";
import {
  CreateCaseResult,
  EligibilityResult,
  type EligibilityInput,
  type IntakeSubmission,
} from "@/shared/contracts";
import type { ServiceClient } from "@/shared/supabase/server";
import { PII, submissionFixture } from "../../fixtures/claims/submission";

const NOW = "2026-01-16T10:00:00.000Z";
const clock = fixedClock(NOW);

const result = (over: Partial<EligibilityResult> = {}): EligibilityResult =>
  EligibilityResult.parse({
    status: "eligible",
    reason: "test",
    delayMinutes: 90,
    earliestSendAt: "2026-01-17T12:30:00.000Z",
    deadline: "2026-04-15T09:00:00.000Z",
    appliedRules: ["test"],
    configVersion: "test",
    ...over,
  });

type RpcCall = { fn: string; args: Record<string, unknown> | undefined };
type RpcReply = { data: unknown; error: { code?: string; message: string } | null };

/** A fake service client: records every rpc call and answers from `replies` per function. */
function fakeDb(replies: Partial<Record<string, RpcReply[]>> = {}) {
  const calls: RpcCall[] = [];
  let refs = 0;
  const rpc = vi.fn(async (fn: string, args?: Record<string, unknown>) => {
    calls.push({ fn, args });
    const queued = replies[fn]?.shift();
    if (queued) return queued;
    if (fn === "claims_new_public_ref") return { data: `RTN-0000000${++refs}`, error: null };
    if (fn === "claims_create_case") return { data: "case-uuid", error: null };
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  });
  return { db: { rpc } as unknown as ServiceClient, calls, rpc };
}

const createCalls = (calls: RpcCall[]) => calls.filter((c) => c.fn === "claims_create_case");

function deps(db: ServiceClient, over: Partial<CreateCaseDeps> = {}): CreateCaseDeps {
  return { db, clock, noticeFrom: "retren@example.test", ...over };
}

describe("madridInstant", () => {
  it("uses +01:00 in winter", () => {
    expect(madridInstant("2026-01-15", "10:00")).toBe("2026-01-15T10:00:00+01:00");
  });
  it("uses +02:00 in summer", () => {
    expect(madridInstant("2026-07-15", "10:00")).toBe("2026-07-15T10:00:00+02:00");
  });
  // Spring forward, 2026-03-29: 02:00–02:59 does not exist (02:00 CET → 03:00 CEST).
  it("2026-03-29: around the skipped hour, each side keeps its own offset", () => {
    expect(madridInstant("2026-03-29", "01:30")).toBe("2026-03-29T01:30:00+01:00");
    expect(madridInstant("2026-03-29", "03:30")).toBe("2026-03-29T03:30:00+02:00");
  });
  it("2026-03-29: a time in the skipped hour is read with the offset before the change (+01:00)", () => {
    // 02:30+01:00 is 01:30Z, which a Madrid clock shows as 03:30 CEST.
    expect(madridInstant("2026-03-29", "02:30")).toBe("2026-03-29T02:30:00+01:00");
  });
  // Fall back, 2026-10-25: 02:00–02:59 happens twice (03:00 CEST → 02:00 CET).
  it("2026-10-25: around the repeated hour, each side keeps its own offset", () => {
    expect(madridInstant("2026-10-25", "01:30")).toBe("2026-10-25T01:30:00+02:00");
    expect(madridInstant("2026-10-25", "03:30")).toBe("2026-10-25T03:30:00+01:00");
  });
  it("2026-10-25: a time in the repeated hour is read as the second one, after the change (+01:00)", () => {
    expect(madridInstant("2026-10-25", "02:30")).toBe("2026-10-25T02:30:00+01:00");
  });

  it("is the same instant as the Madrid wall-clock time", () => {
    expect(new Date(madridInstant("2026-07-15", "23:30")).toISOString()).toBe(
      "2026-07-15T21:30:00.000Z",
    );
  });
});

describe("toEligibilityInput (the submission → rules mapping)", () => {
  it("maps the ticket, the user's actual arrival and the clock", () => {
    const input = toEligibilityInput(submissionFixture(90), new Date(NOW));
    expect(input).toEqual<EligibilityInput>({
      operator: "iryo",
      scheduledDeparture: "2026-01-15T09:00:00+01:00",
      scheduledArrival: "2026-01-15T12:00:00+01:00",
      actualArrival: "2026-01-15T13:30:00+01:00",
      purchaseDate: "2026-01-01",
      purchaseChannel: "direct",
      now: NOW,
    });
  });

  it("puts an arrival earlier than the departure on the next day (overnight train)", () => {
    const s = submissionFixture(30);
    s.ticket.scheduledDeparture = "22:00";
    s.ticket.scheduledArrival = "01:00";
    s.answers.actualArrival = { date: "2026-01-16", time: "01:30" };
    const input = toEligibilityInput(s, new Date(NOW));
    expect(input.scheduledArrival).toBe("2026-01-16T01:00:00+01:00");
    expect(input.actualArrival).toBe("2026-01-16T01:30:00+01:00");
  });

  it("leaves out the optional purchase fields when the ticket has none", () => {
    const s = submissionFixture(90);
    delete s.ticket.purchaseDate;
    delete s.ticket.purchaseChannel;
    const input = toEligibilityInput(s, new Date(NOW));
    expect(input).not.toHaveProperty("purchaseDate");
    expect(input).not.toHaveProperty("purchaseChannel");
  });
});

describe("planCase (eligibility → status, timer and notice)", () => {
  const s = submissionFixture(90);

  it("eligible → waiting_period, next action at earliestSendAt, no notice", () => {
    const plan = planCase(s, result());
    expect(plan.status).toBe("waiting_period");
    expect(plan.event).toBe("eligible");
    expect(plan.nextActionAt).toBe("2026-01-17T12:30:00.000Z");
    expect(plan.earliestSendAt).toBe("2026-01-17T12:30:00.000Z");
    expect(plan.notice).toBeUndefined();
  });

  it("doubtful → waiting_period too (the claim is still sent)", () => {
    const plan = planCase(s, result({ status: "doubtful" }));
    expect(plan.status).toBe("waiting_period");
    expect(plan.event).toBe("eligible");
    expect(plan.nextActionAt).toBe("2026-01-17T12:30:00.000Z");
  });

  it("eligible or doubtful without earliestSendAt → MissingEarliestSendAtError (no invented wait)", () => {
    for (const status of ["eligible", "doubtful"] as const) {
      expect(() => planCase(s, result({ status, earliestSendAt: undefined }))).toThrow(
        MissingEarliestSendAtError,
      );
    }
  });

  it("not eligible → closed, no timer, a user_final_result notice", () => {
    const plan = planCase(
      s,
      result({ status: "not_eligible", earliestSendAt: undefined, delayMinutes: 20 }),
    );
    expect(plan.status).toBe("closed");
    expect(plan.event).toBe("not_eligible");
    expect(plan.nextActionAt).toBeNull();
    expect(plan.notice).toEqual({ template: "user_final_result", to: PII.email });
  });
});

describe("createCase", () => {
  it("rejects an invalid submission before touching the DB", async () => {
    const { db, rpc } = fakeDb();
    const bad = {
      ...submissionFixture(90),
      answers: { ...submissionFixture(90).answers, email: "x" },
    };
    await expect(createCase(bad as IntakeSubmission, deps(db))).rejects.toBeInstanceOf(ZodError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("eligible: stores the case in waiting_period with the timer, and no notice", async () => {
    const { db, calls } = fakeDb();
    const out = await createCase(submissionFixture(90), deps(db));
    expect(CreateCaseResult.parse(out)).toEqual(out);
    expect(out).toMatchObject({ caseId: "case-uuid", publicRef: "RTN-00000001" });
    expect(out.status).toBe("waiting_period");
    expect(out.eligibility.status).toBe("eligible");

    const [call] = createCalls(calls);
    expect(call.args).toMatchObject({
      p_public_ref: "RTN-00000001",
      p_operator: "iryo",
      p_status: "waiting_period",
      p_user_email: PII.email,
      p_earliest_send_at: out.eligibility.earliestSendAt,
      p_next_action_at: out.eligibility.earliestSendAt,
      p_eligibility: out.eligibility,
      p_notice: null,
    });
    expect(call.args?.p_submission).toEqual(submissionFixture(90));
  });

  it("uses evaluateEligibility from @/features/rules by default", async () => {
    const { db } = fakeDb();
    const out = await createCase(submissionFixture(20), deps(db));
    expect(out.eligibility.delayMinutes).toBe(20);
    expect(out.status).toBe("closed");
  });

  it("passes the mapped input to the injected eligibility function", async () => {
    const { db } = fakeDb();
    const evaluate = vi.fn<(input: EligibilityInput) => EligibilityResult>(() => result());
    await createCase(submissionFixture(90), deps(db, { evaluateEligibility: evaluate }));
    expect(evaluate).toHaveBeenCalledWith(toEligibilityInput(submissionFixture(90), new Date(NOW)));
  });

  it("doubtful: waiting_period with the timer", async () => {
    const { db, calls } = fakeDb();
    const out = await createCase(
      submissionFixture(90),
      deps(db, { evaluateEligibility: () => result({ status: "doubtful" }) }),
    );
    expect(out.status).toBe("waiting_period");
    expect(out.eligibility.status).toBe("doubtful");
    expect(createCalls(calls)[0].args).toMatchObject({
      p_status: "waiting_period",
      p_next_action_at: "2026-01-17T12:30:00.000Z",
      p_notice: null,
    });
  });

  it("eligible without earliestSendAt: throws before touching the DB", async () => {
    const { db, rpc } = fakeDb();
    await expect(
      createCase(
        submissionFixture(90),
        deps(db, { evaluateEligibility: () => result({ earliestSendAt: undefined }) }),
      ),
    ).rejects.toBeInstanceOf(MissingEarliestSendAtError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("not eligible: closed, and a user_final_result notice queued to the user", async () => {
    const { db, calls } = fakeDb();
    const out = await createCase(submissionFixture(20), deps(db));
    expect(out.status).toBe("closed");
    const args = createCalls(calls)[0].args!;
    expect(args).toMatchObject({ p_status: "closed", p_next_action_at: null });
    const notice = args.p_notice as Record<string, string>;
    expect(notice).toMatchObject({
      template: "user_final_result",
      from: "retren@example.test",
      to: PII.email,
    });
    expect(notice.subject).toContain("[RTN-00000001]");
    expect(notice.body_text.length).toBeGreaterThan(0);
  });

  it("puts no personal data in the event data", async () => {
    for (const delay of [90, 20]) {
      const { db, calls } = fakeDb();
      await createCase(submissionFixture(delay), deps(db));
      const data = JSON.stringify(createCalls(calls)[0].args?.p_event_data);
      for (const value of Object.values(PII)) expect(data).not.toContain(value);
      expect(JSON.parse(data)).toMatchObject({ event: delay === 90 ? "eligible" : "not_eligible" });
    }
  });

  it("retries once with a new reference on a unique violation (23505)", async () => {
    const { db, calls } = fakeDb({
      claims_create_case: [{ data: null, error: { code: "23505", message: "duplicate key" } }],
    });
    const out = await createCase(submissionFixture(90), deps(db));
    expect(out.publicRef).toBe("RTN-00000002");
    expect(createCalls(calls).map((c) => c.args?.p_public_ref)).toEqual([
      "RTN-00000001",
      "RTN-00000002",
    ]);
  });

  it("re-renders the notice with the new reference on retry", async () => {
    const { db, calls } = fakeDb({
      claims_create_case: [{ data: null, error: { code: "23505", message: "duplicate key" } }],
    });
    await createCase(submissionFixture(20), deps(db));
    const subjects = createCalls(calls).map(
      (c) => (c.args?.p_notice as Record<string, string>).subject,
    );
    expect(subjects[0]).toContain("[RTN-00000001]");
    expect(subjects[1]).toContain("[RTN-00000002]");
  });

  it("gives up after a second unique violation", async () => {
    const dup = { data: null, error: { code: "23505", message: "duplicate key" } };
    const { db, calls } = fakeDb({ claims_create_case: [dup, { ...dup }] });
    await expect(createCase(submissionFixture(90), deps(db))).rejects.toThrow(/duplicate key/);
    expect(createCalls(calls)).toHaveLength(2);
  });

  it("does not retry other DB errors", async () => {
    const { db, calls } = fakeDb({
      claims_create_case: [{ data: null, error: { code: "23502", message: "not null" } }],
    });
    await expect(createCase(submissionFixture(90), deps(db))).rejects.toThrow(/not null/);
    expect(createCalls(calls)).toHaveLength(1);
  });

  it("fails when the DB cannot generate a reference", async () => {
    const { db } = fakeDb({
      claims_new_public_ref: [{ data: null, error: { message: "boom" } }],
    });
    await expect(createCase(submissionFixture(90), deps(db))).rejects.toThrow(/boom/);
  });
});
