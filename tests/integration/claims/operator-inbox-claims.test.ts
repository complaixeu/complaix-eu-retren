import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createCase } from "@/features/claims";
import { TEAM_QUEUE_EVENT, TICKET_BUCKET, sendInitialClaim } from "@/features/claims/initial-claim";
import { sendQueued } from "@/features/claims/send-queued";
import { createFakeTransport } from "@/features/claims/transport";
import { fixedClock } from "@/shared/clock";
import type { OperatorId } from "@/shared/contracts";
import type { TablesInsert } from "@/shared/supabase";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { submissionFixture } from "../../fixtures/claims/submission";
import { waitForDb } from "../../fixtures/claims/db-ready";
import { TICKET_PLACEHOLDER_PNG } from "../../fixtures/claims/ticket";

// Per-operator test inboxes on the claims path (C3, C4, C6, Nestor's decision): outside production
// a Renfe case with a mapped inbox sends its claim there, although Renfe is a web form and inactive
// in features/rules. Fake transport only; placeholder addresses (example.com).
const CREATED = fixedClock("2026-01-16T10:00:00.000Z");
const READY = new Date("2026-01-18T09:00:00.000Z");
const DAY = 86_400_000;
const RENFE_TESTER = "renfe-tester@example.com";
const TEAM = "equipo@retren.example";
const SMTP = "retren@retren.example";
const DEV = {
  MAIL_PROVIDER: "fake",
  MAIL_REDIRECT_ALL_TO: TEAM,
  MAIL_OPERATOR_INBOXES: `renfe:${RENFE_TESTER}`,
};
const GMAIL_DEV = { ...DEV, MAIL_PROVIDER: "gmail", SMTP_USER: SMTP };
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

/** A Renfe case whose claim went to the test inbox (fake transport): status `sent`. */
async function sentRenfeCase() {
  const caseId = await readyCase("renfe");
  const out = await sendInitialClaim(caseId, {
    db,
    clock: fixedClock(READY),
    transport: createFakeTransport(),
    env: DEV,
  });
  expect(out.ok).toBe(true);
  const { data: c } = await db
    .from("cases")
    .select("public_ref, user_email, status")
    .eq("id", caseId)
    .single();
  return { caseId, ref: c!.public_ref as string, userEmail: c!.user_email as string };
}

/** Inserts one row and returns its id. */
async function row(fields: TablesInsert<"messages">): Promise<string> {
  const { data, error } = await db.from("messages").insert(fields).select("id").single();
  if (error) throw error;
  return data.id as string;
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

    const { data: msg } = await db
      .from("messages")
      .select("status, to_address, delivered_to, template")
      .eq("case_id", caseId)
      .eq("template", "initial_claim")
      .single();
    expect(msg).toMatchObject({
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
    ).toEqual({ ok: false, reason: "operator_inactive" });
    expect(transport.outbox).toEqual([]);
    const { data: c } = await db.from("cases").select("next_action_at").eq("id", caseId).single();
    expect(Date.parse(c!.next_action_at!)).toBe(READY.getTime() + DAY);
  });
});

describe("sendQueued with a per-operator test inbox (local Supabase)", () => {
  it("a user notice goes to the user with the redirect; the operator mail goes to the test inbox", async () => {
    const { caseId, ref, userEmail } = await sentRenfeCase();
    const notice = await row({
      case_id: caseId,
      direction: "outbound",
      status: "queued",
      template: "user_request_document",
      from_address: "avisos@retren.invalid",
      to_address: userEmail,
      subject: `[${ref}] Necesitamos un documento`,
      body_text: "Texto del aviso al usuario.",
    });
    const reminder = await row({
      case_id: caseId,
      direction: "outbound",
      status: "queued",
      template: "reminder_d12",
      from_address: "reclamaciones@retren.invalid",
      to_address: RENFE_TESTER,
      subject: `[${ref}] Recordatorio`,
      body_text: "Texto del recordatorio al operador.",
    });
    const transport = createFakeTransport();
    const deps = { db, transport, env: GMAIL_DEV, providerName: "gmail" };
    expect((await sendQueued(notice, deps)).status).toBe("sent");
    expect((await sendQueued(reminder, deps)).status).toBe("sent");

    expect(transport.outbox.map((m) => m.to)).toEqual([[TEAM], [RENFE_TESTER]]);
    const { data: rows } = await db
      .from("messages")
      .select("id, to_address, delivered_to")
      .in("id", [notice, reminder]);
    const byId = Object.fromEntries((rows ?? []).map((r) => [r.id, r]));
    expect(byId[notice]).toMatchObject({ to_address: userEmail, delivered_to: [TEAM] });
    expect(byId[reminder]).toMatchObject({
      to_address: RENFE_TESTER,
      delivered_to: [RENFE_TESTER],
    });
  });

  it("a test-inbox reply in the thread is in References, and a reminder queued before it is stale", async () => {
    const { caseId, ref } = await sentRenfeCase();
    const replyId = `<tester-reply-${randomUUID()}@example.com>`;
    // Earlier than any row queued now: it is part of the thread, not newer than the reminder.
    await row({
      case_id: caseId,
      direction: "inbound",
      status: "received",
      from_address: RENFE_TESTER,
      to_address: "reclamaciones@retren.invalid",
      subject: `Re: [${ref}] Recordatorio`,
      message_id: replyId,
      created_at: "2020-01-01T00:00:00.000Z",
    });
    const early = await row({
      case_id: caseId,
      direction: "outbound",
      status: "queued",
      template: "reminder_d12",
      from_address: "reclamaciones@retren.invalid",
      to_address: RENFE_TESTER,
      subject: `[${ref}] Recordatorio`,
      body_text: "Texto del recordatorio.",
    });
    const transport = createFakeTransport();
    const deps = { db, transport, env: GMAIL_DEV, providerName: "gmail" };
    expect((await sendQueued(early, deps)).status).toBe("sent");
    expect(transport.outbox[0].references).toContain(replyId);

    // A reply from the test inbox that arrives after this reminder was queued makes it stale.
    const late = await row({
      case_id: caseId,
      direction: "outbound",
      status: "queued",
      template: "reminder_d30",
      from_address: "reclamaciones@retren.invalid",
      to_address: RENFE_TESTER,
      subject: `[${ref}] Recordatorio 2`,
      body_text: "Texto del segundo recordatorio.",
    });
    await row({
      case_id: caseId,
      direction: "inbound",
      status: "received",
      from_address: RENFE_TESTER,
      to_address: "reclamaciones@retren.invalid",
      subject: `Re: [${ref}] Recordatorio 2`,
      message_id: `<tester-late-${randomUUID()}@example.com>`,
      created_at: new Date(Date.now() + DAY).toISOString(),
    });
    expect(await sendQueued(late, deps)).toEqual({ status: "failed", reason: "stale" });
    expect(transport.outbox).toHaveLength(1);
  });
});
