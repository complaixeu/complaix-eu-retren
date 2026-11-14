import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createCase } from "@/features/claims";
import {
  DOCUMENTS_BUCKET,
  TEAM_QUEUE_EVENT,
  TICKET_BUCKET,
  sendInitialClaim,
} from "@/features/claims/initial-claim";
import { MAX_SENDS_PER_CASE } from "@/features/claims/timers";
import { sendPending, sendQueued } from "@/features/claims/send-queued";
import { createFakeTransport } from "@/features/claims/transport";
import { getOperatorConfig } from "@/features/rules";
import { fixedClock } from "@/shared/clock";
import type { OperatorId } from "@/shared/contracts";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { PII, submissionFixture } from "../../fixtures/claims/submission";
import { TICKET_PLACEHOLDER_PNG } from "../../fixtures/claims/ticket";

// Outbound (plan C3) against the local Supabase: sendInitialClaim moves a ready case to `sent`
// with the claim and its 3 attachments in the outbox, and sendQueued is the one place a queued
// row is sent (fake transport only, never the network).
// TODO(C6 merge): import USER_DOCUMENTS_BUCKET from features/claims/actions.
const USER_DOCUMENTS_BUCKET = "claims-user-documents";
const CREATED = fixedClock("2026-01-16T10:00:00.000Z");
// submissionFixture(90): arrival 13:30 Madrid (12:30 UTC) on 2026-01-15; the rules mock waits 48 h.
const EARLIEST = "2026-01-17T12:30:00.000Z";
const READY = new Date("2026-01-18T09:00:00.000Z");
const DAY = 86_400_000;
const OPERATOR = "atencion.cliente@iryo.eu";
let db: ServiceClient;

beforeAll(async () => {
  db = createServiceClient();
  // The tickets bucket is domain A's (A1). Until its migration lands, the test makes a private
  // one so the stored ticket can be read like the real one.
  const { data } = await db.storage.getBucket(TICKET_BUCKET);
  if (!data) {
    const { error } = await db.storage.createBucket(TICKET_BUCKET, { public: false });
    if (error && !/already exists/i.test(error.message)) throw error;
  }
  // The user documents bucket is C6's migration; same fallback until it is on develop.
  const docs = await db.storage.getBucket(USER_DOCUMENTS_BUCKET);
  if (!docs.data) {
    const { error } = await db.storage.createBucket(USER_DOCUMENTS_BUCKET, { public: false });
    if (error && !/already exists/i.test(error.message)) throw error;
  }
});

/** A case created through createCase (C2), with its placeholder ticket stored. */
async function readyCase(operator: OperatorId = "iryo") {
  const ticketPath = `test-c3/${randomUUID()}.png`;
  const base = submissionFixture(90);
  const submission = submissionFixture(90, {
    ticketPath,
    ticket: { ...base.ticket, operator },
  });
  const up = await db.storage
    .from(TICKET_BUCKET)
    .upload(ticketPath, TICKET_PLACEHOLDER_PNG, { contentType: "image/png" });
  if (up.error) throw up.error;
  const out = await createCase(submission, { clock: CREATED });
  expect(out.status).toBe("waiting_period");
  return { caseId: out.caseId, publicRef: out.publicRef, ticketPath };
}

async function stored(caseId: string) {
  const [c, events, messages, attachments] = await Promise.all([
    db.from("cases").select("*").eq("id", caseId).single(),
    db.from("case_events").select("*").eq("case_id", caseId).order("created_at"),
    db.from("messages").select("*").eq("case_id", caseId).order("created_at"),
    db.from("attachments").select("*").eq("case_id", caseId),
  ]);
  for (const r of [c, events, messages, attachments]) expect(r.error).toBeNull();
  return {
    row: c.data!,
    events: events.data!,
    messages: messages.data!,
    attachments: attachments.data!,
  };
}

const noPersonalData = (data: unknown) => {
  const text = JSON.stringify(data);
  for (const value of Object.values(PII)) expect(text).not.toContain(value);
};

describe("sendInitialClaim (local Supabase)", () => {
  it("moves the case to sent, with the claim and 3 attachments in the outbox", async () => {
    const { caseId, publicRef, ticketPath } = await readyCase();
    const transport = createFakeTransport();
    const out = await sendInitialClaim(caseId, {
      db,
      clock: fixedClock(READY),
      transport,
      env: { MAIL_REDIRECT_ALL_TO: "equipo@retren.example" },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.delivery.status).toBe("sent");

    const { row, events, messages, attachments } = await stored(caseId);
    expect(row).toMatchObject({ status: "sent", send_count: 1 });
    expect(Date.parse(row.sent_at!)).toBe(READY.getTime());
    // The first timer stage (d12, C7) is the next thing to look at.
    expect(Date.parse(row.next_action_at!)).toBe(READY.getTime() + 12 * DAY);

    expect(messages).toHaveLength(1);
    const [m] = messages;
    expect(m).toMatchObject({
      id: out.messageId,
      direction: "outbound",
      status: "sent",
      template: "initial_claim",
      to_address: OPERATOR,
      in_reply_to: null,
      failure_reason: null,
      delivered_to: ["equipo@retren.example"],
    });
    expect(m.subject).toContain(`[${publicRef}]`);
    expect(m.message_id).toMatch(new RegExp(`^<${publicRef.toLowerCase()}\\.`));
    expect(m.provider_id).toMatch(/^fake-/);
    expect(m.body_text).toBeTruthy();

    // Exactly the 3 attachments, all of this case and linked to the outbox row.
    expect(attachments.map((a) => a.kind).sort()).toEqual(["eu_form", "mandate", "ticket"]);
    for (const a of attachments) expect(a).toMatchObject({ case_id: caseId, message_id: m.id });
    expect(attachments.find((a) => a.kind === "ticket")).toMatchObject({
      storage_path: `${TICKET_BUCKET}/${ticketPath}`,
      content_type: "image/png",
      size_bytes: TICKET_PLACEHOLDER_PNG.byteLength,
    });
    // The generated PDFs are in the private documents bucket.
    for (const kind of ["eu_form", "mandate"]) {
      const a = attachments.find((x) => x.kind === kind)!;
      expect(a.storage_path.startsWith(`${DOCUMENTS_BUCKET}/${caseId}/`)).toBe(true);
      expect(a.content_type).toBe("application/pdf");
      const file = await db.storage
        .from(DOCUMENTS_BUCKET)
        .download(a.storage_path.slice(DOCUMENTS_BUCKET.length + 1));
      expect(file.error).toBeNull();
      expect(new TextDecoder().decode(await file.data!.arrayBuffer())).toMatch(/^%PDF-/);
    }

    // The transport got one mail: threaded, redirected, with the 3 attachments.
    expect(transport.outbox).toHaveLength(1);
    const mail = transport.outbox[0];
    expect(mail.to).toEqual(["equipo@retren.example"]);
    expect(mail.messageId).toBe(m.message_id);
    expect(mail.subject).toBe(m.subject);
    expect(mail.inReplyTo).toBeUndefined();
    expect(mail.attachments).toHaveLength(3);

    // Events: created (C2), claim_sent (waiting_period → sent), message_sent. No personal data.
    expect(events.map((e) => [e.kind, e.from_status, e.to_status])).toEqual([
      ["created", "draft", "waiting_period"],
      ["claim_sent", "waiting_period", "sent"],
      ["message_sent", null, null],
    ]);
    expect(events[1].data).toMatchObject({ message_id: m.id });
    expect(events[2].data).toMatchObject({ message_id: m.id, template: "initial_claim" });
    for (const e of events.slice(1)) noPersonalData(e.data);
  });

  it("runs once: a second call is refused and changes nothing", async () => {
    const { caseId } = await readyCase();
    const deps = { db, clock: fixedClock(READY), transport: createFakeTransport() };
    expect((await sendInitialClaim(caseId, deps)).ok).toBe(true);
    const again = await sendInitialClaim(caseId, deps);
    expect(again).toEqual({ ok: false, reason: "not_waiting_period" });
    const { row, messages, attachments } = await stored(caseId);
    expect(row.send_count).toBe(1);
    expect(messages).toHaveLength(1);
    expect(attachments).toHaveLength(3);
    expect(deps.transport.outbox).toHaveLength(1);
  });

  for (const operator of ["renfe", "ouigo"] as const) {
    it(`an inactive operator (${operator}) is never sent; the team queue is told once`, async () => {
      expect(getOperatorConfig(operator).active).toBe(false);
      const { caseId } = await readyCase(operator);
      const transport = createFakeTransport();
      const deps = { db, clock: fixedClock(READY), transport };
      expect(await sendInitialClaim(caseId, deps)).toEqual({
        ok: false,
        reason: "operator_inactive",
      });
      expect(await sendInitialClaim(caseId, deps)).toEqual({
        ok: false,
        reason: "operator_inactive",
      });

      const { row, events, messages, attachments } = await stored(caseId);
      expect(row).toMatchObject({ status: "waiting_period", send_count: 0, sent_at: null });
      expect(messages).toEqual([]);
      expect(attachments).toEqual([]);
      expect(transport.outbox).toEqual([]);
      const queue = events.filter((e) => e.kind === TEAM_QUEUE_EVENT);
      expect(queue).toHaveLength(1);
      expect(queue[0].data).toEqual({ reason: "operator_inactive", action: "initial_claim" });
    });
  }

  it("is refused before earliest_send_at", async () => {
    const { caseId } = await readyCase();
    const transport = createFakeTransport();
    expect(Date.parse((await stored(caseId)).row.earliest_send_at!)).toBe(Date.parse(EARLIEST));
    const early = new Date(Date.parse(EARLIEST) - 60_000);
    expect(await sendInitialClaim(caseId, { db, clock: fixedClock(early), transport })).toEqual({
      ok: false,
      reason: "too_early",
    });
    const { row, messages, attachments } = await stored(caseId);
    expect(row).toMatchObject({ status: "waiting_period", send_count: 0, sent_at: null });
    expect(messages).toEqual([]);
    expect(attachments).toEqual([]);
    expect(transport.outbox).toEqual([]);
  });

  it("is refused when earliest_send_at is null", async () => {
    const { caseId } = await readyCase();
    const upd = await db.from("cases").update({ earliest_send_at: null }).eq("id", caseId);
    expect(upd.error).toBeNull();
    expect(
      await sendInitialClaim(caseId, {
        db,
        clock: fixedClock(READY),
        transport: createFakeTransport(),
      }),
    ).toEqual({ ok: false, reason: "no_earliest_send_at" });
    expect((await stored(caseId)).messages).toEqual([]);
  });

  it("is refused at the send cap", async () => {
    const { caseId } = await readyCase();
    const upd = await db
      .from("cases")
      .update({ send_count: MAX_SENDS_PER_CASE - 1 })
      .eq("id", caseId);
    expect(upd.error).toBeNull();
    expect(
      await sendInitialClaim(caseId, {
        db,
        clock: fixedClock(READY),
        transport: createFakeTransport(),
      }),
    ).toEqual({ ok: false, reason: "send_cap_reached" });
    const { row, messages } = await stored(caseId);
    expect(row).toMatchObject({ status: "waiting_period", send_count: MAX_SENDS_PER_CASE - 1 });
    expect(messages).toEqual([]);
  });

  it("is refused without a stored ticket, and the team queue is told", async () => {
    const { caseId, ticketPath } = await readyCase();
    await db.storage.from(TICKET_BUCKET).remove([ticketPath]);
    expect(
      await sendInitialClaim(caseId, {
        db,
        clock: fixedClock(READY),
        transport: createFakeTransport(),
      }),
    ).toEqual({ ok: false, reason: "ticket_missing" });
    const { row, events, messages } = await stored(caseId);
    expect(row.status).toBe("waiting_period");
    expect(messages).toEqual([]);
    expect(events.filter((e) => e.kind === TEAM_QUEUE_EVENT).map((e) => e.data)).toEqual([
      { reason: "ticket_missing", action: "initial_claim" },
    ]);
  });

  it("refuses mock template text through a non-fake provider, before writing anything", async () => {
    const { caseId } = await readyCase();
    const transport = createFakeTransport();
    expect(
      await sendInitialClaim(caseId, {
        db,
        clock: fixedClock(READY),
        transport,
        providerName: "smtp",
      }),
    ).toEqual({ ok: false, reason: "mock_text" });
    const { row, messages } = await stored(caseId);
    expect(row.status).toBe("waiting_period");
    expect(messages).toEqual([]);
    expect(transport.outbox).toEqual([]);
  });
});

describe("sendQueued (local Supabase)", () => {
  /** A sent case (initial claim out) plus one more outbound row queued for it, like C7's tick. */
  async function sentCaseWithQueued(row: { to?: string; subject?: string; body?: string } = {}) {
    const ready = await readyCase();
    const first = await sendInitialClaim(ready.caseId, {
      db,
      clock: fixedClock(READY),
      transport: createFakeTransport(),
    });
    if (!first.ok) throw new Error(first.reason);
    const { data, error } = await db
      .from("messages")
      .insert({
        case_id: ready.caseId,
        direction: "outbound",
        from_address: "reclamaciones@retren.invalid",
        to_address: row.to ?? OPERATOR,
        subject: row.subject ?? `[${ready.publicRef}] Recordatorio`,
        body_text: row.body ?? "Recordatorio de la reclamación.",
        status: "queued",
      })
      .select("id")
      .single();
    if (error) throw error;
    return { ...ready, initialId: first.messageId, queuedId: data.id };
  }

  const message = async (id: string) => {
    const r = await db.from("messages").select("*").eq("id", id).single();
    expect(r.error).toBeNull();
    return r.data!;
  };

  it("sends a queued reminder in the case thread", async () => {
    const { caseId, publicRef, initialId, queuedId } = await sentCaseWithQueued();
    const initial = await message(initialId);
    const transport = createFakeTransport();
    const out = await sendQueued(queuedId, { db, transport, env: {} });
    expect(out.status).toBe("sent");

    const m = await message(queuedId);
    expect(m).toMatchObject({
      status: "sent",
      in_reply_to: initial.message_id,
      thread_references: [initial.message_id],
      delivered_to: [OPERATOR],
      failure_reason: null,
    });
    expect(m.message_id).toMatch(new RegExp(`^<${publicRef.toLowerCase()}\\.`));
    expect(transport.outbox).toHaveLength(1);
    expect(transport.outbox[0]).toMatchObject({
      to: [OPERATOR],
      inReplyTo: initial.message_id,
      references: [initial.message_id],
      attachments: [],
    });
    // The transport never touches the cap: C7 counted the reminder when it queued it.
    expect((await stored(caseId)).row.send_count).toBe(1);
    // Sending again is a no-op.
    expect(await sendQueued(queuedId, { db, transport })).toEqual({
      status: "skipped",
      reason: "not_queued",
    });
    expect(transport.outbox).toHaveLength(1);
  });

  it("a reply that arrived after the row was queued: failed, reason stale", async () => {
    const { caseId, queuedId } = await sentCaseWithQueued();
    const inbound = await db.from("messages").insert({
      case_id: caseId,
      direction: "inbound",
      from_address: OPERATOR,
      to_address: "reclamaciones@retren.example",
      subject: "Re: reclamación",
      status: "received",
      message_id: `<${randomUUID()}@iryo.eu>`,
    });
    expect(inbound.error).toBeNull();
    const transport = createFakeTransport();
    expect(await sendQueued(queuedId, { db, transport })).toEqual({
      status: "failed",
      reason: "stale",
    });
    expect(await message(queuedId)).toMatchObject({ status: "failed", failure_reason: "stale" });
    expect(transport.outbox).toEqual([]);
    const { events } = await stored(caseId);
    expect(events.at(-1)).toMatchObject({
      kind: "message_failed",
      data: { message_id: queuedId, reason: "stale" },
    });
  });

  it("a closed case: failed, reason stale", async () => {
    const { caseId, queuedId } = await sentCaseWithQueued();
    expect((await db.from("cases").update({ status: "closed" }).eq("id", caseId)).error).toBeNull();
    expect(await sendQueued(queuedId, { db, transport: createFakeTransport() })).toEqual({
      status: "failed",
      reason: "stale",
    });
  });

  it("a non-operator recipient is refused and the row marked failed", async () => {
    const { queuedId } = await sentCaseWithQueued({ to: "x@evil.com" });
    const transport = createFakeTransport();
    expect(await sendQueued(queuedId, { db, transport })).toEqual({
      status: "failed",
      reason: "recipient_not_allowed",
    });
    expect(await message(queuedId)).toMatchObject({
      status: "failed",
      failure_reason: "recipient_not_allowed",
      delivered_to: null,
    });
    expect(transport.outbox).toEqual([]);
  });

  it("an attachment of another case is refused and the row marked failed", async () => {
    const { queuedId } = await sentCaseWithQueued();
    const other = await sentCaseWithQueued();
    const att = await db.from("attachments").insert({
      case_id: other.caseId,
      message_id: queuedId,
      kind: "user_document",
      storage_path: "claim-documents/x/doc.pdf",
      filename: "doc.pdf",
      content_type: "application/pdf",
    });
    expect(att.error).toBeNull();
    const transport = createFakeTransport();
    expect(await sendQueued(queuedId, { db, transport })).toEqual({
      status: "failed",
      reason: "attachment_not_allowed",
    });
    expect(transport.outbox).toEqual([]);
  });

  it("mock template text is refused through a non-fake provider", async () => {
    const { queuedId } = await sentCaseWithQueued({ body: "mock reminder_d12\n\nRetren" });
    const transport = createFakeTransport();
    expect(await sendQueued(queuedId, { db, transport, providerName: "smtp" })).toEqual({
      status: "failed",
      reason: "mock_text",
    });
    expect(transport.outbox).toEqual([]);
  });

  it("user mail goes only to the case's own user", async () => {
    const own = await sentCaseWithQueued({ to: PII.email });
    expect((await sendQueued(own.queuedId, { db, transport: createFakeTransport() })).status).toBe(
      "sent",
    );
    const stranger = await sentCaseWithQueued({ to: "otro.viajero@example.test" });
    expect(await sendQueued(stranger.queuedId, { db, transport: createFakeTransport() })).toEqual({
      status: "failed",
      reason: "recipient_not_allowed",
    });
  });

  it("a transport error marks the row failed", async () => {
    const { queuedId } = await sentCaseWithQueued();
    const broken = {
      send: async () => {
        throw new Error("boom");
      },
    };
    expect(await sendQueued(queuedId, { db, transport: broken })).toEqual({
      status: "failed",
      reason: "transport_error",
    });
    expect(await message(queuedId)).toMatchObject({
      status: "failed",
      failure_reason: "transport_error",
    });
  });

  /** A forwarded user document (C6): a queued operator row with a user_document attached. */
  async function forwarded() {
    const q = await sentCaseWithQueued();
    const key = `${q.caseId}/${randomUUID()}.pdf`;
    const up = await db.storage
      .from(USER_DOCUMENTS_BUCKET)
      .upload(key, new TextEncoder().encode("%PDF-1.7\n% placeholder\n%%EOF\n"), {
        contentType: "application/pdf",
      });
    if (up.error) throw up.error;
    const att = await db
      .from("attachments")
      .insert({
        case_id: q.caseId,
        message_id: q.queuedId,
        kind: "user_document",
        storage_path: key,
        filename: "documento.pdf",
        content_type: "application/pdf",
      })
      .select("id")
      .single();
    if (att.error) throw att.error;
    return { ...q, key, attachmentId: att.data.id };
  }

  const fileExists = async (key: string) =>
    !(await db.storage.from(USER_DOCUMENTS_BUCKET).download(key)).error;

  it("forward → send → the user document is gone from storage and marked deleted", async () => {
    const f = await forwarded();
    expect(await fileExists(f.key)).toBe(true);
    const transport = createFakeTransport();
    expect((await sendQueued(f.queuedId, { db, transport })).status).toBe("sent");
    // It went out with the mail, and only then was it deleted.
    expect(transport.outbox[0].attachments.map((a) => a.kind)).toEqual(["user_document"]);
    expect(await fileExists(f.key)).toBe(false);
    const att = await db.from("attachments").select("deleted_at").eq("id", f.attachmentId).single();
    expect(att.data?.deleted_at).not.toBeNull();
    const { events } = await stored(f.caseId);
    expect(events.filter((e) => e.kind === "user_document_deleted").map((e) => e.data)).toEqual([
      { attachment_id: f.attachmentId },
    ]);
  });

  it("forward → failed send → the user document is still there for a retry", async () => {
    const f = await forwarded();
    const broken = {
      send: async () => {
        throw new Error("boom");
      },
    };
    expect(await sendQueued(f.queuedId, { db, transport: broken })).toEqual({
      status: "failed",
      reason: "transport_error",
    });
    expect(await fileExists(f.key)).toBe(true);
    const att = await db.from("attachments").select("deleted_at").eq("id", f.attachmentId).single();
    expect(att.data?.deleted_at).toBeNull();
  });

  it("the purge runs once the row is marked sent, and never after a failed send", async () => {
    const calls: { id: string; status: string | undefined }[] = [];
    const purgeForwardedDocuments = async (id: string) => {
      calls.push({ id, status: (await message(id)).status });
    };
    const ok = await forwarded();
    await sendQueued(ok.queuedId, {
      db,
      transport: createFakeTransport(),
      purgeForwardedDocuments,
    });
    expect(calls).toEqual([{ id: ok.queuedId, status: "sent" }]);

    const bad = await forwarded();
    const broken = {
      send: async () => {
        throw new Error("boom");
      },
    };
    await sendQueued(bad.queuedId, { db, transport: broken, purgeForwardedDocuments });
    const refused = await sentCaseWithQueued({ to: "x@evil.com" });
    await sendQueued(refused.queuedId, { db, purgeForwardedDocuments });
    expect(calls).toHaveLength(1);
  });

  it("sendPending sends every queued row once", async () => {
    const a = await sentCaseWithQueued();
    const b = await sentCaseWithQueued({ to: "x@evil.com" });
    const transport = createFakeTransport();
    const first = await sendPending({ db, transport });
    expect(first.find((r) => r.messageId === a.queuedId)?.result.status).toBe("sent");
    expect(first.find((r) => r.messageId === b.queuedId)?.result).toEqual({
      status: "failed",
      reason: "recipient_not_allowed",
    });
    expect((await message(a.queuedId)).status).toBe("sent");
    // Nothing is left to send: a second run sends nothing again.
    const sentBefore = transport.outbox.length;
    expect(await sendPending({ db, transport })).toEqual([]);
    expect(transport.outbox).toHaveLength(sentBefore);
  });
});
