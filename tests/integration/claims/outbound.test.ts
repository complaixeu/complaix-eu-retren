import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createCase } from "@/features/claims";
import { USER_DOCUMENTS_BUCKET } from "@/features/claims/actions";
import {
  DOCUMENTS_BUCKET,
  TEAM_QUEUE_EVENT,
  TICKET_BUCKET,
  sendInitialClaim,
} from "@/features/claims/initial-claim";
import { MAX_SENDS_PER_CASE } from "@/features/claims/timers";
import { CLAIM_TTL_MS, sendPending, sendQueued } from "@/features/claims/send-queued";
import { createFakeTransport, createGmailTransport } from "@/features/claims/transport";
import { getOperatorConfig } from "@/features/rules";
import { fixedClock } from "@/shared/clock";
import type { OperatorId } from "@/shared/contracts";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { PII, submissionFixture } from "../../fixtures/claims/submission";
import { TICKET_PLACEHOLDER_PNG } from "../../fixtures/claims/ticket";

// Outbound (plan C3) against the local Supabase: sendInitialClaim moves a ready case to `sent`
// with the claim and its 3 attachments in the outbox, and sendQueued is the one place a queued
// row is sent (fake transport only, never the network).
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
    // The sender read each file from private storage: the transport gets bytes, not paths.
    const ticket = mail.attachments.find((a) => a.kind === "ticket")!;
    expect(Buffer.from(ticket.content).equals(Buffer.from(TICKET_PLACEHOLDER_PNG))).toBe(true);
    for (const a of mail.attachments) expect(a.content.byteLength).toBeGreaterThan(0);

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
      expect(queue[0].data).toEqual({
        source: "outbound",
        reason: "operator_inactive",
        action: "initial_claim",
      });
      // Not retried every hour: the next look is a day later.
      expect(Date.parse(row.next_action_at!)).toBe(READY.getTime() + DAY);
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
      { source: "outbound", reason: "ticket_missing", action: "initial_claim" },
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
        env: { MAIL_REDIRECT_ALL_TO: "equipo@retren.example" },
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
  async function sentCaseWithQueued(
    row: { to?: string; subject?: string; body?: string; template?: string | null } = {},
  ) {
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
        template: row.template === undefined ? "reminder_d12" : row.template,
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

  it("with MAIL_REDIRECT_ALL_TO the stored to_address stays the operator's, delivered_to is the redirect", async () => {
    const { caseId, initialId, queuedId } = await sentCaseWithQueued();
    const transport = createFakeTransport();
    const env = { MAIL_REDIRECT_ALL_TO: "equipo@retren.example" };
    expect((await sendQueued(queuedId, { db, transport, env })).status).toBe("sent");
    expect(await message(queuedId)).toMatchObject({
      to_address: OPERATOR,
      delivered_to: ["equipo@retren.example"],
    });
    expect(transport.outbox[0].to).toEqual(["equipo@retren.example"]);
    // The initial claim's to_address (C6 checks its recipients against it, RT403) is real too.
    expect((await message(initialId)).to_address).toBe(OPERATOR);
    expect((await stored(caseId)).row.status).toBe("sent");
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
    const { queuedId } = await sentCaseWithQueued({ to: "intruso@evil.example" });
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
    const env = { MAIL_REDIRECT_ALL_TO: "equipo@retren.example" };
    expect(await sendQueued(queuedId, { db, transport, providerName: "smtp", env })).toEqual({
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
    const q = await sentCaseWithQueued({ template: "reply_asks_for_data" });
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
      { message_id: f.queuedId, attachment_ids: [f.attachmentId] },
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
    const refused = await sentCaseWithQueued({ to: "intruso@evil.example" });
    await sendQueued(refused.queuedId, { db, purgeForwardedDocuments });
    expect(calls).toHaveLength(1);
  });

  /** A query that always answers with an error (a DB read or write that fails). */
  function failingQuery(): unknown {
    const q: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: null, error: { message: "boom (test)" } });
        }
        return () => q;
      },
    });
    return q;
  }
  /** The service client, except that `from(table)` fails whenever `fails(table)` says so. */
  const dbWith = (fails: (table: string) => boolean) =>
    new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "from") {
          return (table: string) => (fails(table) ? failingQuery() : target.from(table as never));
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ServiceClient;

  const teamQueue = async (caseId: string) =>
    (await stored(caseId)).events.filter((e) => e.kind === TEAM_QUEUE_EVENT).map((e) => e.data);

  it("a failure after the claim, before the transport: failed internal_error, team queue", async () => {
    const { caseId, queuedId } = await sentCaseWithQueued();
    const transport = createFakeTransport();
    const out = await sendQueued(queuedId, { db: dbWith((t) => t === "cases"), transport });
    expect(out).toEqual({ status: "failed", reason: "internal_error" });
    expect(transport.outbox).toEqual([]);
    expect(await message(queuedId)).toMatchObject({
      status: "failed",
      failure_reason: "internal_error",
    });
    expect(await teamQueue(caseId)).toContainEqual(
      expect.objectContaining({
        source: "outbound",
        reason: "internal_error",
        message_id: queuedId,
      }),
    );
  });

  it("the transport accepted the mail but the write failed: delivery_unknown, never resent", async () => {
    const { caseId, queuedId } = await sentCaseWithQueued();
    let accepted = false;
    let broke = false;
    const fake = createFakeTransport();
    const transport = {
      async send(m: Parameters<typeof fake.send>[0]) {
        accepted = true;
        return fake.send(m);
      },
    };
    // The first write after the transport accepted the mail (marking the row sent) fails once.
    const flaky = dbWith((t) => {
      if (t === "messages" && accepted && !broke) return (broke = true);
      return false;
    });
    expect(await sendQueued(queuedId, { db: flaky, transport })).toEqual({
      status: "failed",
      reason: "delivery_unknown",
    });
    expect(fake.outbox).toHaveLength(1);
    expect(await message(queuedId)).toMatchObject({
      status: "failed",
      failure_reason: "delivery_unknown",
    });
    expect(await teamQueue(caseId)).toContainEqual(
      expect.objectContaining({ reason: "delivery_unknown", message_id: queuedId }),
    );
    expect(await sendPending({ db, transport }, { caseIds: [caseId] })).toEqual([]);
    expect(fake.outbox).toHaveLength(1);
  });

  it("a claim that expired while queued becomes delivery_unknown, swept by sendPending", async () => {
    const { caseId, queuedId } = await sentCaseWithQueued();
    const old = new Date(Date.now() - CLAIM_TTL_MS - 60_000).toISOString();
    expect(
      (await db.from("messages").update({ send_claimed_at: old }).eq("id", queuedId)).error,
    ).toBeNull();
    const transport = createFakeTransport();
    const out = await sendPending({ db, transport }, { caseIds: [caseId] });
    expect(out).toContainEqual({
      messageId: queuedId,
      result: { status: "failed", reason: "delivery_unknown" },
    });
    expect(transport.outbox).toEqual([]);
    expect(await message(queuedId)).toMatchObject({
      status: "failed",
      failure_reason: "delivery_unknown",
    });
    expect(await teamQueue(caseId)).toContainEqual(
      expect.objectContaining({ reason: "delivery_unknown", message_id: queuedId }),
    );
  });

  it("two concurrent sends of one row: exactly one goes out", async () => {
    const { queuedId } = await sentCaseWithQueued();
    const transport = createFakeTransport();
    const results = await Promise.all([
      sendQueued(queuedId, { db, transport }),
      sendQueued(queuedId, { db, transport }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["sent", "skipped"]);
    expect(transport.outbox).toHaveLength(1);
  });

  it("a failed initial claim goes to the team queue, and is not retried", async () => {
    const { caseId } = await readyCase();
    const broken = {
      send: async () => {
        throw new Error("boom");
      },
    };
    const out = await sendInitialClaim(caseId, { db, clock: fixedClock(READY), transport: broken });
    expect(out.ok && out.delivery).toEqual({ status: "failed", reason: "transport_error" });
    const { messages } = await stored(caseId);
    expect(messages[0]).toMatchObject({ template: "initial_claim", status: "failed" });
    expect(await teamQueue(caseId)).toContainEqual({
      source: "outbound",
      reason: "transport_error",
      message_id: messages[0].id,
      template: "initial_claim",
    });
    const transport = createFakeTransport();
    expect(await sendPending({ db, transport }, { caseIds: [caseId] })).toEqual([]);
    expect(transport.outbox).toEqual([]);
  });

  it("a spoofed [RTN-ref] mail changes neither the headers nor the staleness", async () => {
    const { caseId, publicRef, initialId, queuedId } = await sentCaseWithQueued();
    const initial = await message(initialId);
    const spoof = await db.from("messages").insert({
      case_id: caseId,
      direction: "inbound",
      from_address: "attacker@evil.example",
      to_address: "reclamaciones@retren.example",
      subject: `Re: [${publicRef}] reclamación`,
      status: "received",
      message_id: `<${randomUUID()}@evil.example>`,
    });
    expect(spoof.error).toBeNull();
    const transport = createFakeTransport();
    expect((await sendQueued(queuedId, { db, transport })).status).toBe("sent");
    expect(transport.outbox[0]).toMatchObject({
      inReplyTo: initial.message_id,
      references: [initial.message_id],
    });
  });

  it("keeps an In-Reply-To the row already has", async () => {
    const { queuedId } = await sentCaseWithQueued();
    await db.from("messages").update({ in_reply_to: "<given@iryo.eu>" }).eq("id", queuedId);
    const transport = createFakeTransport();
    expect((await sendQueued(queuedId, { db, transport })).status).toBe("sent");
    expect(transport.outbox[0].inReplyTo).toBe("<given@iryo.eu>");
    expect((await message(queuedId)).in_reply_to).toBe("<given@iryo.eu>");
  });

  it("only reminders go stale: an acknowledgement never stops a C6 insistence", async () => {
    const { caseId, queuedId } = await sentCaseWithQueued({ template: null });
    // C6 links its operator mail to an event that names the template.
    const ev = await db.from("case_events").insert({
      case_id: caseId,
      kind: "operator_mail_queued",
      data: { template: "insistence_after_denial", message_id: queuedId },
    });
    expect(ev.error).toBeNull();
    const ack = await db.from("messages").insert({
      case_id: caseId,
      direction: "inbound",
      from_address: OPERATOR,
      to_address: "reclamaciones@retren.example",
      subject: "Acuse",
      status: "received",
      category: "acknowledgement",
      message_id: `<${randomUUID()}@iryo.eu>`,
    });
    expect(ack.error).toBeNull();
    expect((await sendQueued(queuedId, { db, transport: createFakeTransport() })).status).toBe(
      "sent",
    );
    // The kind is recorded on the row (C8's allowlist reads it).
    expect((await message(queuedId)).template).toBe("insistence_after_denial");
  });

  it("a C7 reminder (no template on the row) is recognised from its timer event", async () => {
    const ready = await readyCase();
    const first = await sendInitialClaim(ready.caseId, {
      db,
      clock: fixedClock(READY),
      transport: createFakeTransport(),
    });
    if (!first.ok) throw new Error(first.reason);
    const queued = await db.rpc("claims_apply_timer_action", {
      p_case_id: ready.caseId,
      p_from_status: "sent",
      p_send_count: 1,
      p_paused: false,
      p_to_status: "sent",
      p_send_increment: 1,
      p_next_action_at: new Date(READY.getTime() + 30 * DAY).toISOString(),
      p_event_data: { action: "reminder_d12", day: 12, at: READY.toISOString() },
      p_message: {
        recipient: "operator",
        template: "reminder_d12",
        from: "reclamaciones@retren.invalid",
        to: OPERATOR,
        subject: `[${ready.publicRef}] Recordatorio`,
        body_text: "Recordatorio.",
      },
      p_extra_events: [],
    });
    expect(queued.error).toBeNull();
    const id = queued.data as string;
    await db.from("messages").insert({
      case_id: ready.caseId,
      direction: "inbound",
      from_address: OPERATOR,
      to_address: "reclamaciones@retren.example",
      subject: "Respuesta",
      status: "received",
      message_id: `<${randomUUID()}@iryo.eu>`,
    });
    expect(await sendQueued(id, { db, transport: createFakeTransport() })).toEqual({
      status: "failed",
      reason: "stale",
    });
    expect((await message(id)).template).toBe("reminder_d12");
  });

  it("a real provider without MAIL_REDIRECT_ALL_TO refuses before touching the row", async () => {
    const { queuedId } = await sentCaseWithQueued();
    const transport = createFakeTransport();
    await expect(
      sendQueued(queuedId, { db, transport, providerName: "gmail", env: {} }),
    ).rejects.toThrow(/MAIL_REDIRECT_ALL_TO/);
    await expect(
      sendQueued(queuedId, {
        db,
        transport,
        providerName: "gmail",
        env: { MAIL_REDIRECT_ALL_TO: "no-es-una-direccion" },
      }),
    ).rejects.toThrow(/MAIL_REDIRECT_ALL_TO/);
    expect(await message(queuedId)).toMatchObject({ status: "queued", send_claimed_at: null });
    expect(transport.outbox).toEqual([]);
  });

  it("gmail: the sender reads the attachment bytes from storage; From is SMTP_USER", async () => {
    const f = await forwarded();
    const env = {
      MAIL_PROVIDER: "gmail",
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "buzon@retren.example",
      SMTP_PASS: "app-password-test",
      MAIL_REDIRECT_ALL_TO: "equipo@retren.example",
    };
    const raw: string[] = [];
    const { createTransport } = await import("nodemailer");
    const stream = createTransport({ streamTransport: true, buffer: true, newline: "unix" });
    const transport = createGmailTransport(env, {
      transporter: {
        async sendMail(options) {
          const info = await stream.sendMail(options);
          raw.push((info.message as Buffer).toString("utf8"));
          return info;
        },
      },
    });
    expect(
      (await sendQueued(f.queuedId, { db, transport, providerName: "gmail", env })).status,
    ).toBe("sent");
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatch(/^From: Retren <buzon@retren\.example>$/m);
    expect(raw[0]).toMatch(/^To: equipo@retren\.example$/m);
    expect(raw[0]).toContain(Buffer.from("%PDF-1.7\n% placeholder\n%%EOF\n").toString("base64"));
    expect(raw[0]).not.toContain(f.key);
  });

  it("sendPending sends every queued row once", async () => {
    const a = await sentCaseWithQueued();
    const b = await sentCaseWithQueued({ to: "intruso@evil.example" });
    const transport = createFakeTransport();
    const caseIds = [a.caseId, b.caseId];
    const first = await sendPending({ db, transport }, { caseIds });
    expect(first.find((r) => r.messageId === a.queuedId)?.result.status).toBe("sent");
    expect(first.find((r) => r.messageId === b.queuedId)?.result).toEqual({
      status: "failed",
      reason: "recipient_not_allowed",
    });
    expect((await message(a.queuedId)).status).toBe("sent");
    // Nothing is left to send: a second run sends nothing again.
    const sentBefore = transport.outbox.length;
    expect(await sendPending({ db, transport }, { caseIds })).toEqual([]);
    expect(transport.outbox).toHaveLength(sentBefore);
  });
});
