import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyReplyCategory,
  ESCALATION_DAY,
  forwardUserDocument,
  RecipientRefusedError,
  USER_DOCUMENTS_BUCKET,
} from "@/features/claims/actions";
import { getOperatorConfig } from "@/features/rules";
import { fixedClock } from "@/shared/clock";
import type { CaseStatus, OperatorId, ReplyCategory } from "@/shared/contracts";
import type { Json } from "@/shared/supabase";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { PII, submissionFixture } from "../../fixtures/claims/submission";

// Actions per reply category against the local Supabase (plan C6): every path end to end on
// the DB, the forwarded document deleted, only one insistence ever, and the operator-only rule.
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
};

async function seedCase(s: Seed): Promise<{ id: string; ref: string }> {
  const ref = `RTN-${randomUUID().slice(0, 8).toUpperCase()}`;
  const { data, error } = await db
    .from("cases")
    .insert({
      public_ref: ref,
      operator: s.operator ?? "iryo",
      status: s.status,
      submission: submissionFixture(90) as unknown as NonNullable<Json>,
      user_email: PII.email,
      sent_at: s.sentAt ?? daysAgo(10),
      next_action_at: daysAgo(1),
      send_count: s.sendCount ?? 1,
    })
    .select("id")
    .single();
  if (error) throw error;
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

async function seedReply(caseId: string, ref: string): Promise<{ id: string; messageId: string }> {
  const messageId = `<${randomUUID()}@operator.example>`;
  const { data, error } = await db
    .from("messages")
    .insert({
      case_id: caseId,
      direction: "inbound",
      from_address: OPERATOR_ADDRESS,
      to_address: "reclamaciones@retren.invalid",
      subject: `Re: [${ref}] Reclamación`,
      message_id: messageId,
      status: "received",
      body_text: operatorBody,
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id, messageId };
}

async function stored(caseId: string) {
  const [c, events, messages] = await Promise.all([
    db.from("cases").select("*").eq("id", caseId).single(),
    db.from("case_events").select("*").eq("case_id", caseId).order("created_at"),
    db.from("messages").select("*").eq("case_id", caseId).eq("direction", "outbound"),
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

async function reply(seed: Seed, category: ReplyCategory) {
  const c = await seedCase(seed);
  const m = await seedReply(c.id, c.ref);
  const out = await applyReplyCategory({ caseId: c.id, messageId: m.id, category }, { db, clock });
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

  it("first denial at send_count = 5: the team queue (send_cap), the last slot is kept for d45", async () => {
    const r = await reply({ status: "reply_received", sendCount: 5 }, "denied");
    expect(r.out).toMatchObject({ action: "team_queue", teamQueue: "send_cap" });
    expect(r.row).toMatchObject({ status: "reply_received", send_count: 5 });
    expect(r.outbox).toEqual([]);
    expect(kinds(r.events)).toEqual([["team_queue", "send_cap"]]);
  });

  it("second denial before d45: closed, and the final result to the user", async () => {
    const r = await reply({ status: "reply_received", insisted: true, sendCount: 2 }, "denied");
    expect(r.out).toMatchObject({ action: "close", status: "closed" });
    expect(r.row).toMatchObject({ status: "closed", next_action_at: null, send_count: 2 });
    expect(r.outbox).toHaveLength(1);
    expectOurNotice(r.outbox[0]);
    expect(kinds(r.events).slice(1)).toEqual([
      ["reply_action", "rejected"],
      ["reply_action", "close"],
      ["user_notice_queued", "user_final_result"],
    ]);
  });

  it("second denial with the d45 escalation due: left denied for the tick, nothing queued", async () => {
    const r = await reply(
      { status: "reply_received", insisted: true, sendCount: 2, sentAt: daysAgo(ESCALATION_DAY) },
      "denied",
    );
    expect(r.out).toMatchObject({ action: "await_escalation", status: "denied" });
    expect(r.row.status).toBe("denied");
    expect(Date.parse(r.row.next_action_at!)).toBe(NOW.getTime());
    expect(r.outbox).toEqual([]);
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

    // A later denial (after C4's operator_replied) never insists again.
    await db.from("cases").update({ status: "reply_received" }).eq("id", c.id);
    const m3 = await seedReply(c.id, c.ref);
    const third = await applyReplyCategory(
      { caseId: c.id, messageId: m3.id, category: "denied" },
      { db, clock },
    );
    expect(third.action).toBe("close");
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

describe("forwardUserDocument (local Supabase)", () => {
  it("queues the document to the operator only, moves to sent, then deletes it", async () => {
    const c = await seedCase({ status: "waiting_user" });
    await seedReply(c.id, c.ref);
    const doc = await seedDocument(c.id);
    expect(await inStorage(doc.path)).toBe(true);

    const out = await forwardUserDocument({ caseId: c.id, attachmentId: doc.id }, { db, clock });
    expect(out.status).toBe("sent");
    if (!("messageId" in out)) throw new Error("expected the document to be forwarded");

    const s = await stored(c.id);
    expect(s.row).toMatchObject({ status: "sent", send_count: 2 });
    expect(s.outbox).toHaveLength(1);
    expect(s.outbox[0]).toMatchObject({
      id: out.messageId,
      to_address: OPERATOR_ADDRESS,
      status: "queued",
    });
    expect(s.outbox[0].subject).toContain(`[${c.ref}]`);

    const { data: att } = await db.from("attachments").select("*").eq("id", doc.id).single();
    expect(att).toMatchObject({ kind: "user_document", message_id: out.messageId });
    expect(att?.deleted_at).not.toBeNull();
    expect(await inStorage(doc.path)).toBe(false);

    expect(kinds(s.events)).toEqual([
      ["user_document_forwarded", null],
      ["operator_mail_queued", "reply_asks_for_data"],
      ["user_document_deleted", null],
    ]);
    for (const e of s.events) noPersonalData(e.data);
  });

  it("refuses a non-operator recipient: nothing queued, the document kept", async () => {
    // Renfe has no verified claims email (web form only): there is nobody we may send it to.
    const c = await seedCase({ status: "waiting_user", operator: "renfe" });
    const doc = await seedDocument(c.id);
    await expect(
      forwardUserDocument({ caseId: c.id, attachmentId: doc.id }, { db, clock }),
    ).rejects.toThrow(RecipientRefusedError);

    // A config that names some other address than the verified one for the case's operator.
    const iryo = await seedCase({ status: "waiting_user" });
    const doc2 = await seedDocument(iryo.id);
    const spoofed = (id: OperatorId) => ({
      ...getOperatorConfig(id),
      id: "ouigo" as const,
      channel: { type: "email" as const, address: OPERATOR_TEXT.address },
    });
    await expect(
      forwardUserDocument(
        { caseId: iryo.id, attachmentId: doc2.id },
        { db, clock, getOperatorConfig: spoofed },
      ),
    ).rejects.toThrow(RecipientRefusedError);

    for (const [id, d] of [
      [c.id, doc],
      [iryo.id, doc2],
    ] as const) {
      const s = await stored(id);
      expect(s.row.status).toBe("waiting_user");
      expect(s.outbox).toEqual([]);
      expect(s.events).toEqual([]);
      expect(await inStorage(d.path)).toBe(true);
    }
  });

  it("at send_count = 5: the team queue (send_cap), nothing queued, the document kept", async () => {
    const c = await seedCase({ status: "waiting_user", sendCount: 5 });
    const doc = await seedDocument(c.id);
    const out = await forwardUserDocument({ caseId: c.id, attachmentId: doc.id }, { db, clock });
    expect(out).toEqual({ status: "waiting_user", teamQueue: "send_cap" });
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
