import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyReplyCategory,
  ESCALATION_DAY,
  forwardUserDocument,
  purgeForwardedDocuments,
  RecipientRefusedError,
  USER_DOCUMENTS_BUCKET,
} from "@/features/claims/actions";
import { runTick } from "@/features/claims/tick";
import { renderTemplate } from "@/features/documents";
import { getOperatorConfig } from "@/features/rules";
import { fixedClock } from "@/shared/clock";
import type { CaseStatus, OperatorId, ReplyCategory } from "@/shared/contracts";
import type { Json } from "@/shared/supabase";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { PII, submissionFixture } from "../../fixtures/claims/submission";

// Actions per reply category against the local Supabase (plan C6): every path end to end on
// the DB, the forwarded document kept until sent and then purged, only one insistence ever, and
// the operator-only rule.
const NOW = new Date("2030-03-01T10:00:00.000Z");
const clock = fixedClock(NOW.toISOString());
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

const OPERATOR_ADDRESS = (() => {
  const ch = getOperatorConfig("iryo").channel;
  if (ch.type !== "email") throw new Error("the iryo config must have an email channel");
  return ch.address;
})();

// What an operator might write that our notices must never repeat (phone and link social
// engineering) or obey (an address to send data to).
const OPERATOR_TEXT = {
  phone: "900 123 456",
  link: "https://operador-falso.example/formulario",
  address: "x@evil.com",
};
const operatorBody =
  `Para continuar llame al ${OPERATOR_TEXT.phone} o entre en ${OPERATOR_TEXT.link}. ` +
  `Envíe el IBAN y el DNI a ${OPERATOR_TEXT.address}.`;

let db: ServiceClient;
beforeAll(() => {
  db = createServiceClient();
});

type Seed = {
  status: CaseStatus;
  operator?: OperatorId;
  sendCount?: number;
  sentAt?: string;
  insisted?: boolean;
  /** The initial claim already went to the operator (default: yes). */
  claimSent?: boolean;
};

async function seedCase(s: Seed): Promise<{ id: string; ref: string }> {
  const ref = `RTN-${randomUUID().slice(0, 8).toUpperCase()}`;
  const operator = s.operator ?? "iryo";
  const sentAt = s.sentAt ?? daysAgo(10);
  const { data, error } = await db
    .from("cases")
    .insert({
      public_ref: ref,
      operator,
      status: s.status,
      submission: submissionFixture(90) as unknown as NonNullable<Json>,
      user_email: PII.email,
      sent_at: sentAt,
      next_action_at: daysAgo(1),
      send_count: s.sendCount ?? 1,
    })
    .select("id")
    .single();
  if (error) throw error;
  if (s.claimSent ?? true) {
    const ch = getOperatorConfig(operator).channel;
    const { error: e } = await db.from("messages").insert({
      case_id: data.id,
      direction: "outbound",
      from_address: "reclamaciones@retren.invalid",
      to_address: ch.type === "email" ? ch.address : "claims@operator.example",
      subject: `[${ref}] Reclamación`,
      message_id: `<${randomUUID()}@retren.invalid>`,
      status: "sent",
      body_text: "initial claim",
      created_at: sentAt,
    });
    if (e) throw e;
  }
  if (s.insisted) {
    const { error: e } = await db.from("case_events").insert({
      case_id: data.id,
      kind: "reply_action",
      from_status: "denied",
      to_status: "sent",
      data: { event: "insistence_sent" },
    });
    if (e) throw e;
  }
  return { id: data.id, ref };
}

async function seedReply(
  caseId: string,
  ref: string,
  over: { from?: string; category?: ReplyCategory } = {},
): Promise<{ id: string; messageId: string }> {
  const messageId = `<${randomUUID()}@operator.example>`;
  const { data, error } = await db
    .from("messages")
    .insert({
      case_id: caseId,
      direction: "inbound",
      from_address: over.from ?? OPERATOR_ADDRESS,
      to_address: "reclamaciones@retren.invalid",
      subject: `Re: [${ref}] Reclamación`,
      message_id: messageId,
      status: "received",
      body_text: operatorBody,
      ...(over.category && { category: over.category }),
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id, messageId };
}

/** The case, its events and its queued outbox (the seeded initial claim is `sent`). */
async function stored(caseId: string) {
  const [c, events, messages] = await Promise.all([
    db.from("cases").select("*").eq("id", caseId).single(),
    db.from("case_events").select("*").eq("case_id", caseId).order("created_at"),
    db
      .from("messages")
      .select("*")
      .eq("case_id", caseId)
      .eq("direction", "outbound")
      .eq("status", "queued"),
  ]);
  if (c.error || events.error || messages.error) throw c.error ?? events.error ?? messages.error;
  return { row: c.data, events: events.data, outbox: messages.data };
}

const kinds = (events: { kind: string; data: Json }[]) =>
  events.map((e) => {
    const d = e.data as Record<string, unknown>;
    return [e.kind, d.event ?? d.reason ?? d.template ?? null];
  });

const noPersonalData = (data: unknown) => {
  const text = JSON.stringify(data);
  for (const value of Object.values(PII)) expect(text).not.toContain(value);
};

/** A user notice: only ours, only to the case user, never echoing the operator. */
function expectOurNotice(mail: { to_address: string; subject: string; body_text: string | null }) {
  expect(mail.to_address).toBe(PII.email);
  for (const v of Object.values(OPERATOR_TEXT)) {
    expect(mail.subject).not.toContain(v);
    expect(mail.body_text ?? "").not.toContain(v);
  }
}

async function reply(
  seed: Seed,
  category: ReplyCategory,
  deps: Parameters<typeof applyReplyCategory>[1] = {},
) {
  const c = await seedCase(seed);
  const m = await seedReply(c.id, c.ref);
  const out = await applyReplyCategory(
    { caseId: c.id, messageId: m.id, category },
    { db, clock, ...deps },
  );
  return { ...c, message: m, out, ...(await stored(c.id)) };
}

describe("applyReplyCategory (local Supabase)", () => {
  it("acknowledgement: waits, nothing queued, the reply gets its category", async () => {
    const r = await reply({ status: "reply_received" }, "acknowledgement");
    expect(r.out).toMatchObject({ action: "wait", status: "reply_received", messageIds: [] });
    expect(r.row.status).toBe("reply_received");
    expect(r.outbox).toEqual([]);
    expect(kinds(r.events)).toEqual([["reply_action", "acknowledged"]]);
    const { data } = await db.from("messages").select("category").eq("id", r.message.id).single();
    expect(data?.category).toBe("acknowledgement");
  });

  it("asks_for_data: waiting_user and our document request to the user only", async () => {
    const r = await reply({ status: "reply_received" }, "asks_for_data");
    expect(r.out).toMatchObject({ action: "request_document", status: "waiting_user" });
    expect(r.row.status).toBe("waiting_user");
    expect(r.outbox).toHaveLength(1);
    expect(r.outbox[0]).toMatchObject({ status: "queued", category: null });
    expect(r.outbox[0].subject).toContain(`[${r.ref}]`);
    expectOurNotice(r.outbox[0]);
    expect(kinds(r.events)).toEqual([
      ["reply_action", "data_requested"],
      ["user_notice_queued", "user_request_document"],
    ]);
    expect(r.row.send_count).toBe(1);
    for (const e of r.events) noPersonalData(e.data);
  });

  it("approved: resolved, and the final result asks the user to confirm receipt", async () => {
    const r = await reply({ status: "reply_received" }, "approved");
    expect(r.row).toMatchObject({ status: "resolved", next_action_at: null, send_count: 1 });
    expect(r.outbox).toHaveLength(1);
    expectOurNotice(r.outbox[0]);
    expect(kinds(r.events)).toEqual([
      ["reply_action", "approved"],
      ["user_notice_queued", "user_final_result"],
    ]);
  });

  it("templates get the case's own data, never the operator's text", async () => {
    const seen: Record<string, string>[] = [];
    const render: typeof renderTemplate = (kind, operator, vars) => {
      seen.push(vars);
      return renderTemplate(kind, operator, vars);
    };
    await reply({ status: "reply_received" }, "denied", { render });
    await reply({ status: "reply_received" }, "approved", { render });
    expect(seen).toHaveLength(2);
    for (const vars of seen) {
      expect(vars).toMatchObject({
        documentNumber: PII.documentNumber,
        passengerName: `${PII.firstName} ${PII.lastName}`,
      });
      for (const v of Object.values(OPERATOR_TEXT)) {
        expect(JSON.stringify(vars)).not.toContain(v);
      }
    }
  });

  it("first denial: one insistence to the operator, threaded, counted, back to sent", async () => {
    const r = await reply({ status: "reply_received" }, "denied");
    expect(r.out).toMatchObject({ action: "insist", status: "sent" });
    expect(r.row).toMatchObject({ status: "sent", send_count: 2 });
    expect(Date.parse(r.row.next_action_at!)).toBe(NOW.getTime());
    expect(r.outbox).toHaveLength(1);
    expect(r.outbox[0]).toMatchObject({
      to_address: OPERATOR_ADDRESS,
      in_reply_to: r.message.messageId,
      status: "queued",
    });
    expect(r.outbox[0].subject).toContain(`[${r.ref}]`);
    expect(kinds(r.events)).toEqual([
      ["reply_action", "rejected"],
      ["reply_action", "insistence_sent"],
      ["operator_mail_queued", "insistence_after_denial"],
    ]);
    for (const e of r.events) noPersonalData(e.data);
  });

  it("first denial at send_count = 5: denied plus the team queue (send_cap), no mail", async () => {
    const r = await reply({ status: "reply_received", sendCount: 5 }, "denied");
    expect(r.out).toMatchObject({ action: "team_queue", teamQueue: "send_cap", status: "denied" });
    expect(r.row).toMatchObject({ status: "denied", send_count: 5 });
    expect(r.outbox).toEqual([]);
    expect(kinds(r.events)).toEqual([
      ["reply_action", "rejected"],
      ["team_queue", "send_cap"],
    ]);
  });

  it("a capped first denial on d42 still gets the d45 escalation from the tick", async () => {
    const r = await reply(
      { status: "reply_received", sendCount: 5, sentAt: daysAgo(42) },
      "denied",
    );
    expect(r.row.status).toBe("denied");
    const d45 = Date.parse(daysAgo(42)) + ESCALATION_DAY * DAY;
    expect(Date.parse(r.row.next_action_at!)).toBe(d45);

    const tick = await runTick(db, new Date(d45 + 3_600_000));
    expect(tick.actions).toContainEqual({ caseId: r.id, action: "escalation_d45" });
    const after = await stored(r.id);
    expect(after.row).toMatchObject({ status: "escalated", send_count: 6 });
    expect(after.outbox.map((m) => m.to_address)).toEqual([OPERATOR_ADDRESS]);
  });

  it("second denial before d45: left denied until the window opens, nothing queued", async () => {
    const r = await reply({ status: "reply_received", insisted: true, sendCount: 2 }, "denied");
    expect(r.out).toMatchObject({ action: "await_escalation", status: "denied" });
    expect(r.row).toMatchObject({ status: "denied", send_count: 2 });
    expect(Date.parse(r.row.next_action_at!)).toBe(Date.parse(daysAgo(10)) + ESCALATION_DAY * DAY);
    expect(r.outbox).toEqual([]);
  });

  it("second denial on d45: left denied, the tick looks now", async () => {
    const r = await reply(
      { status: "reply_received", insisted: true, sendCount: 2, sentAt: daysAgo(ESCALATION_DAY) },
      "denied",
    );
    expect(r.out).toMatchObject({ action: "await_escalation", status: "denied" });
    expect(Date.parse(r.row.next_action_at!)).toBe(NOW.getTime());
    expect(r.outbox).toEqual([]);
  });

  it("second denial with no slot left for the escalation: closed, the final result", async () => {
    const r = await reply({ status: "reply_received", insisted: true, sendCount: 6 }, "denied");
    expect(r.out).toMatchObject({ action: "close", status: "closed" });
    expect(r.row).toMatchObject({ status: "closed", next_action_at: null, send_count: 6 });
    expect(r.outbox).toHaveLength(1);
    expectOurNotice(r.outbox[0]);
    expect(kinds(r.events).slice(1)).toEqual([
      ["reply_action", "rejected"],
      ["reply_action", "close"],
      ["user_notice_queued", "user_final_result"],
    ]);
  });

  it.each(["refers_to_form", "other"] as const)(
    "%s: the team queue, no state change, nothing queued",
    async (category) => {
      const r = await reply({ status: "reply_received" }, category);
      expect(r.out).toMatchObject({ action: "team_queue", teamQueue: category });
      expect(r.row.status).toBe("reply_received");
      expect(r.outbox).toEqual([]);
      expect(kinds(r.events)).toEqual([["team_queue", category]]);
      expect(r.events[0].data).toEqual({ reason: category, category, message_id: r.message.id });
    },
  );

  it.each([
    ["closed", "approved"],
    ["resolved", "denied"],
    ["denied", "denied"],
    ["escalated", "asks_for_data"],
  ] as const)("a %s case and a %s reply: the team queue, never a failure", async (status, cat) => {
    const r = await reply({ status }, cat);
    expect(r.out).toMatchObject({ action: "team_queue", teamQueue: "invalid_transition" });
    expect(r.row.status).toBe(status);
    expect(r.outbox).toEqual([]);
    expect(kinds(r.events)).toEqual([["team_queue", "invalid_transition"]]);
  });

  it("a template that fails to render: the team queue (render_failed), no change", async () => {
    const render = () => {
      throw new Error("missing variable");
    };
    const r = await reply({ status: "reply_received" }, "approved", { render });
    expect(r.out).toMatchObject({ action: "team_queue", teamQueue: "render_failed" });
    expect(r.row.status).toBe("reply_received");
    expect(r.outbox).toEqual([]);
    expect(kinds(r.events)).toEqual([["team_queue", "render_failed"]]);
  });

  it("retries run out: the team queue (retry_exhausted), never a failure", async () => {
    const busy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "rpc") return Reflect.get(target, prop, receiver);
        return (fn: string, args?: object) =>
          fn === "claims_apply_reply_action"
            ? Promise.resolve({ data: null, error: { code: "40001", message: "changed" } })
            : target.rpc(fn as never, args as never);
      },
    });
    const r = await reply({ status: "reply_received" }, "approved", { db: busy });
    expect(r.out).toMatchObject({ action: "team_queue", teamQueue: "retry_exhausted" });
    expect(r.row.status).toBe("reply_received");
    expect(kinds(r.events)).toEqual([["team_queue", "retry_exhausted"]]);
  });

  it("an insistence to an address other than the claim's: denied plus the team queue", async () => {
    const spoofed = (id: OperatorId) => ({
      ...getOperatorConfig(id),
      channel: { type: "email" as const, address: OPERATOR_TEXT.address },
    });
    const r = await reply({ status: "reply_received" }, "denied", { getOperatorConfig: spoofed });
    expect(r.out).toMatchObject({
      action: "team_queue",
      teamQueue: "operator_not_emailable",
      status: "denied",
    });
    expect(r.outbox).toEqual([]);
    expect(r.row.send_count).toBe(1);
  });

  it("only one insistence ever, even for two concurrent denials", async () => {
    const c = await seedCase({ status: "reply_received" });
    const [a, b] = await Promise.all([seedReply(c.id, c.ref), seedReply(c.id, c.ref)]);
    const outs = await Promise.all(
      [a, b].map((m) =>
        applyReplyCategory({ caseId: c.id, messageId: m.id, category: "denied" }, { db, clock }),
      ),
    );
    expect(outs.map((o) => o.action).sort()).toEqual(["insist", "team_queue"]);
    const s = await stored(c.id);
    expect(s.row).toMatchObject({ status: "sent", send_count: 2 });
    expect(s.outbox.filter((m) => m.to_address === OPERATOR_ADDRESS)).toHaveLength(1);
    expect(
      s.events.filter((e) => (e.data as { event?: string }).event === "insistence_sent"),
    ).toHaveLength(1);

    // A later denial (after C4's operator_replied) never insists again: it waits for d45.
    await db.from("cases").update({ status: "reply_received" }).eq("id", c.id);
    const m3 = await seedReply(c.id, c.ref);
    const third = await applyReplyCategory(
      { caseId: c.id, messageId: m3.id, category: "denied" },
      { db, clock },
    );
    expect(third.action).toBe("await_escalation");
    const after = await stored(c.id);
    expect(after.outbox.filter((m) => m.to_address === OPERATOR_ADDRESS)).toHaveLength(1);
  });

  it("never obeys the operator: no mail ever goes to an address inside the reply", async () => {
    for (const category of ["asks_for_data", "denied", "other"] as const) {
      const r = await reply({ status: "reply_received" }, category);
      for (const m of r.outbox) expect([PII.email, OPERATOR_ADDRESS]).toContain(m.to_address);
    }
    const { count } = await db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("to_address", OPERATOR_TEXT.address);
    expect(count).toBe(0);
  });
});

async function seedDocument(caseId: string) {
  const path = `${caseId}/${randomUUID()}.pdf`;
  const up = await db.storage
    .from(USER_DOCUMENTS_BUCKET)
    .upload(path, new TextEncoder().encode("%PDF-1.7\n% placeholder\n%%EOF\n"), {
      contentType: "application/pdf",
    });
  if (up.error) throw up.error;
  const { data, error } = await db
    .from("attachments")
    .insert({
      case_id: caseId,
      kind: "user_document",
      storage_path: path,
      filename: "documento.pdf",
      content_type: "application/pdf",
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id, path };
}

async function inStorage(path: string): Promise<boolean> {
  const { data } = await db.storage.from(USER_DOCUMENTS_BUCKET).download(path);
  return data !== null;
}

async function attachment(id: string) {
  const { data, error } = await db.from("attachments").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

const setMessageStatus = async (id: string, status: "queued" | "sent" | "failed") => {
  const { error } = await db.from("messages").update({ status }).eq("id", id);
  if (error) throw error;
};

describe("forwardUserDocument and purgeForwardedDocuments (local Supabase)", () => {
  it("queues the document to the operator only and keeps it until the mail is sent", async () => {
    const c = await seedCase({ status: "waiting_user" });
    const ask = await seedReply(c.id, c.ref, { category: "asks_for_data" });
    // A later inbound mail from someone else must not become the thread parent.
    await seedReply(c.id, c.ref, { from: "otro@remitente.example" });
    const doc = await seedDocument(c.id);

    const out = await forwardUserDocument({ caseId: c.id, attachmentId: doc.id }, { db, clock });
    if (!("messageId" in out)) throw new Error("expected the document to be forwarded");
    expect(out.status).toBe("sent");

    const s = await stored(c.id);
    expect(s.row).toMatchObject({ status: "sent", send_count: 2 });
    expect(s.outbox).toHaveLength(1);
    expect(s.outbox[0]).toMatchObject({
      id: out.messageId,
      to_address: OPERATOR_ADDRESS,
      in_reply_to: ask.messageId,
      status: "queued",
    });
    expect(s.outbox[0].subject).toContain(`[${c.ref}]`);
    expect(kinds(s.events)).toEqual([
      ["user_document_forwarded", null],
      ["operator_mail_queued", "reply_asks_for_data"],
    ]);
    for (const e of s.events) noPersonalData(e.data);

    // Still there: the sender (C3) attaches it.
    expect(await inStorage(doc.path)).toBe(true);
    expect(await attachment(doc.id)).toMatchObject({ message_id: out.messageId, deleted_at: null });
  });

  it("purges only after the mail is sent, once", async () => {
    const c = await seedCase({ status: "waiting_user" });
    const doc = await seedDocument(c.id);
    const out = await forwardUserDocument({ caseId: c.id, attachmentId: doc.id }, { db, clock });
    if (!("messageId" in out)) throw new Error("expected the document to be forwarded");

    for (const status of ["queued", "failed"] as const) {
      await setMessageStatus(out.messageId, status);
      expect(await purgeForwardedDocuments(out.messageId, { db })).toBe(false);
      expect(await inStorage(doc.path)).toBe(true);
      expect((await attachment(doc.id)).deleted_at).toBeNull();
    }

    await setMessageStatus(out.messageId, "sent");
    expect(await purgeForwardedDocuments(out.messageId, { db })).toBe(true);
    expect(await inStorage(doc.path)).toBe(false);
    expect((await attachment(doc.id)).deleted_at).not.toBeNull();

    // A second purge is a no-op.
    expect(await purgeForwardedDocuments(out.messageId, { db })).toBe(true);
    const deletions = (await stored(c.id)).events.filter((e) => e.kind === "user_document_deleted");
    expect(deletions).toHaveLength(1);
    expect(deletions[0].data).toEqual({ message_id: out.messageId, attachment_ids: [doc.id] });
  });

  it("refuses a config that belongs to another operator: nothing written", async () => {
    const c = await seedCase({ status: "waiting_user" });
    const doc = await seedDocument(c.id);
    const otherOperator = () => getOperatorConfig("ouigo");
    await expect(
      forwardUserDocument(
        { caseId: c.id, attachmentId: doc.id },
        { db, clock, getOperatorConfig: otherOperator },
      ),
    ).rejects.toThrow(RecipientRefusedError);
    const s = await stored(c.id);
    expect(s.row.status).toBe("waiting_user");
    expect(s.outbox).toEqual([]);
    expect(s.events).toEqual([]);
    expect(await inStorage(doc.path)).toBe(true);
  });

  it("refuses an address other than the one the claim went to: nothing written", async () => {
    const c = await seedCase({ status: "waiting_user" });
    const doc = await seedDocument(c.id);
    const spoofed = (id: OperatorId) => ({
      ...getOperatorConfig(id),
      channel: { type: "email" as const, address: OPERATOR_TEXT.address },
    });
    await expect(
      forwardUserDocument(
        { caseId: c.id, attachmentId: doc.id },
        { db, clock, getOperatorConfig: spoofed },
      ),
    ).rejects.toThrow(RecipientRefusedError);
    const s = await stored(c.id);
    expect(s.row).toMatchObject({ status: "waiting_user", send_count: 1 });
    expect(s.outbox).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it("refuses when no claim went to the operator yet", async () => {
    const c = await seedCase({ status: "waiting_user", claimSent: false });
    const doc = await seedDocument(c.id);
    await expect(
      forwardUserDocument({ caseId: c.id, attachmentId: doc.id }, { db, clock }),
    ).rejects.toThrow(RecipientRefusedError);
    expect((await stored(c.id)).outbox).toEqual([]);
  });

  it("refuses an operator without a verified email (web form only)", async () => {
    const c = await seedCase({ status: "waiting_user", operator: "renfe" });
    const doc = await seedDocument(c.id);
    await expect(
      forwardUserDocument({ caseId: c.id, attachmentId: doc.id }, { db, clock }),
    ).rejects.toThrow(RecipientRefusedError);
    const s = await stored(c.id);
    expect(s.row.status).toBe("waiting_user");
    expect(s.outbox).toEqual([]);
    expect(s.events).toEqual([]);
    expect(await inStorage(doc.path)).toBe(true);
  });

  it("at send_count = 5: the team queue (send_cap) once, nothing queued, the document kept", async () => {
    const c = await seedCase({ status: "waiting_user", sendCount: 5 });
    const doc = await seedDocument(c.id);
    for (let i = 0; i < 2; i++) {
      const out = await forwardUserDocument({ caseId: c.id, attachmentId: doc.id }, { db, clock });
      expect(out).toEqual({ status: "waiting_user", teamQueue: "send_cap" });
    }
    const s = await stored(c.id);
    expect(s.row).toMatchObject({ status: "waiting_user", send_count: 5 });
    expect(s.outbox).toEqual([]);
    expect(kinds(s.events)).toEqual([["team_queue", "send_cap"]]);
    expect(s.events[0].data).toEqual({ reason: "send_cap", attachment_id: doc.id });
    expect(await inStorage(doc.path)).toBe(true);
  });

  it("refuses a case that isn't waiting on the user", async () => {
    const c = await seedCase({ status: "sent" });
    const doc = await seedDocument(c.id);
    await expect(
      forwardUserDocument({ caseId: c.id, attachmentId: doc.id }, { db, clock }),
    ).rejects.toThrow();
    expect(await inStorage(doc.path)).toBe(true);
    expect((await stored(c.id)).outbox).toEqual([]);
  });
});
