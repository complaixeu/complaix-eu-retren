import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createCase } from "@/features/claims";
import { TEAM_QUEUE_EVENT, TICKET_BUCKET, sendInitialClaim } from "@/features/claims/initial-claim";
import { createFakeTransport } from "@/features/claims/transport";
import { fixedClock } from "@/shared/clock";
import type { OperatorId } from "@/shared/contracts";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { submissionFixture } from "../../fixtures/claims/submission";
import { waitForDb } from "../../fixtures/claims/db-ready";
import { TICKET_PLACEHOLDER_PNG } from "../../fixtures/claims/ticket";

// Per-operator test inboxes on the initial claim (C3, Nestor's decision): outside production a
// Renfe case with a mapped inbox sends its claim there, although Renfe is a web form and inactive
// in features/rules. Fake transport only; placeholder addresses (example.com).
const CREATED = fixedClock("2026-01-16T10:00:00.000Z");
const READY = new Date("2026-01-18T09:00:00.000Z");
const DAY = 86_400_000;
const RENFE_TESTER = "renfe-tester@example.com";
const TEAM = "equipo@retren.example";
const DEV = {
  MAIL_PROVIDER: "fake",
  MAIL_REDIRECT_ALL_TO: TEAM,
  MAIL_OPERATOR_INBOXES: `renfe:${RENFE_TESTER}`,
};
let db: ServiceClient;

beforeAll(async () => {
  db = createServiceClient();
  await waitForDb(db);
  const { data } = await db.storage.getBucket(TICKET_BUCKET);
  if (!data) {
    const { error } = await db.storage.createBucket(TICKET_BUCKET, { public: false });
    if (error && !/already exists/i.test(error.message)) throw error;
  }
});

/** A case created through createCase (C2) for `operator`, with its placeholder ticket stored. */
async function readyCase(operator: OperatorId) {
  const ticketPath = `test-c3-inboxes/${randomUUID()}.png`;
  const base = submissionFixture(90);
  const submission = submissionFixture(90, { ticketPath, ticket: { ...base.ticket, operator } });
  const up = await db.storage
    .from(TICKET_BUCKET)
    .upload(ticketPath, TICKET_PLACEHOLDER_PNG, { contentType: "image/png" });
  if (up.error) throw up.error;
  const out = await createCase(submission, { clock: CREATED });
  expect(out.status).toBe("waiting_period");
  return out.caseId;
}

describe("the initial claim with a per-operator test inbox (local Supabase)", () => {
  it("a Renfe case with renfe mapped sends its claim to the test inbox outside production", async () => {
    const caseId = await readyCase("renfe");
    const transport = createFakeTransport();
    const out = await sendInitialClaim(caseId, {
      db,
      clock: fixedClock(READY),
      transport,
      env: DEV,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.delivery.status).toBe("sent");
    expect(transport.outbox).toHaveLength(1);
    expect(transport.outbox[0].to).toEqual([RENFE_TESTER]);

    const { data: row } = await db
      .from("messages")
      .select("status, to_address, delivered_to, template")
      .eq("case_id", caseId)
      .eq("template", "initial_claim")
      .single();
    expect(row).toMatchObject({
      status: "sent",
      to_address: RENFE_TESTER,
      delivered_to: [RENFE_TESTER],
    });
    const { data: c } = await db.from("cases").select("status").eq("id", caseId).single();
    expect(c!.status).toBe("sent");
  });

  it("the same setup in production sends nothing to Renfe and is refused as before", async () => {
    const caseId = await readyCase("renfe");
    const transport = createFakeTransport();
    const deps = {
      db,
      clock: fixedClock(READY),
      transport,
      env: { ...DEV, RETREN_ENV: "production" },
    };
    expect(await sendInitialClaim(caseId, deps)).toEqual({
      ok: false,
      reason: "operator_inactive",
    });
    expect(transport.outbox).toEqual([]);
    const { data: msgs } = await db.from("messages").select("id").eq("case_id", caseId);
    expect(msgs).toEqual([]);
    const { data: events } = await db
      .from("case_events")
      .select("kind, data")
      .eq("case_id", caseId);
    const queue = (events ?? []).filter((e) => e.kind === TEAM_QUEUE_EVENT);
    expect(queue).toHaveLength(1);
    expect(queue[0].data).toMatchObject({ reason: "operator_inactive" });
  });

  it("an unmapped Renfe case is unchanged: refused as inactive, nothing sent", async () => {
    const caseId = await readyCase("renfe");
    const transport = createFakeTransport();
    const env = {
      MAIL_PROVIDER: "fake",
      MAIL_REDIRECT_ALL_TO: TEAM,
      MAIL_OPERATOR_INBOXES: "iryo:iryo-tester@example.com",
    };
    expect(
      await sendInitialClaim(caseId, { db, clock: fixedClock(READY), transport, env }),
    ).toEqual({
      ok: false,
      reason: "operator_inactive",
    });
    expect(transport.outbox).toEqual([]);
    const { data: c } = await db.from("cases").select("next_action_at").eq("id", caseId).single();
    expect(Date.parse(c!.next_action_at!)).toBe(READY.getTime() + DAY);
  });
});
