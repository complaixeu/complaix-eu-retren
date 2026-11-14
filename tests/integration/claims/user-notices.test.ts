import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createCase } from "@/features/claims";
import { applyReplyCategory, ESCALATION_DAY } from "@/features/claims/actions";
import { createClassifier } from "@/features/claims/classifier";
import { queueEscalationSignatureRequest } from "@/features/claims/notices";
import { ESCALATION_SIGNATURE_KIND } from "@/features/claims/outbound";
import { sendPending, TEAM_QUEUE_EVENT } from "@/features/claims/send-queued";
import { runTick } from "@/features/claims/tick";
import { closeAt } from "@/features/claims/timers";
import { createFakeTransport, type FakeTransport } from "@/features/claims/transport";
import { renderTemplate } from "@/features/documents";
import { getOperatorConfig } from "@/features/rules";
import { fixedClock } from "@/shared/clock";
import type { CaseStatus, ReplyCategory } from "@/shared/contracts";
import type { Json } from "@/shared/supabase";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { loadFixture } from "../../fixtures/mail/golden";
import { PII, submissionFixture } from "../../fixtures/claims/submission";

// C8 end to end on the local Supabase: whatever path a case takes (C2, C6, C7), once the sender
// has run the outbox holds exactly the user mails ARCHITECTURE §7 allows, of the right kinds, and
// nothing else reaches the user. Fake transport, fake classifier, never the network.
const NOW = new Date("2030-03-01T10:00:00.000Z");
const clock = fixedClock(NOW.toISOString());
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

const OPERATOR_ADDRESS = (() => {
  const ch = getOperatorConfig("iryo").channel;
  if (ch.type !== "email") throw new Error("the iryo config must have an email channel");
  return ch.address;
})();
const ATTACKER = "x@evil.example";

let db: ServiceClient;
beforeAll(() => {
  db = createServiceClient();
});

async function seedCase(s: {
  status: CaseStatus;
  sentAt?: string;
  sendCount?: number;
}): Promise<{ id: string; ref: string }> {
  const ref = `RTN-${randomUUID().slice(0, 8).toUpperCase()}`;
  const sentAt = s.sentAt ?? daysAgo(10);
  const { data, error } = await db
    .from("cases")
    .insert({
      public_ref: ref,
      operator: "iryo",
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
  const { error: e } = await db.from("messages").insert({
    case_id: data.id,
    direction: "outbound",
    from_address: "reclamaciones@retren.invalid",
    to_address: OPERATOR_ADDRESS,
    subject: `[${ref}] Reclamación`,
    message_id: `<${randomUUID()}@retren.invalid>`,
    status: "sent",
    template: "initial_claim",
    body_text: "initial claim",
    created_at: sentAt,
  });
  if (e) throw e;
  return { id: data.id, ref };
}

/** An operator reply on the case, as C4 would record it, then the category's action (C6). */
async function operatorReplies(
  c: { id: string; ref: string },
  category: ReplyCategory,
  body = "Texto de prueba del operador.",
) {
  const { data, error } = await db
    .from("messages")
    .insert({
      case_id: c.id,
      direction: "inbound",
      from_address: OPERATOR_ADDRESS,
      to_address: "reclamaciones@retren.invalid",
      subject: `Re: [${c.ref}] Reclamación`,
      message_id: `<${randomUUID()}@operator.example>`,
      status: "received",
      body_text: body,
    })
    .select("id")
    .single();
  if (error) throw error;
  return applyReplyCategory({ caseId: c.id, messageId: data.id, category }, { db, clock });
}

/** The sender (C3), for these cases only. */
async function send(transport: FakeTransport, ...caseIds: string[]) {
  return sendPending({ db, clock, transport, env: {} }, { caseIds });
}

/** Every outbound row of the case except the seeded initial claim. */
async function outbox(caseId: string) {
  const { data, error } = await db
    .from("messages")
    .select("id, to_address, status, template, failure_reason, delivered_to")
    .eq("case_id", caseId)
    .eq("direction", "outbound")
    .order("created_at");
  if (error) throw error;
  // In JS: a SQL `<>` would also drop the rows whose template is still null.
  return data.filter((r) => r.template !== "initial_claim");
}

const isUser = (to: string) => to.trim().toLowerCase() === PII.email;

/**
 * Exactly `kinds` were sent to the user (in order), nothing else to the user in any status, and
 * nothing to anyone but the user or the operator. The fake transport agrees with the rows.
 */
async function expectUserMails(caseId: string, transport: FakeTransport, kinds: string[]) {
  const rows = await outbox(caseId);
  expect(rows.every((r) => r.status === "sent")).toBe(true);
  const toUser = rows.filter((r) => isUser(r.to_address));
  expect(toUser.map((r) => r.template)).toEqual(kinds);
  for (const r of rows) {
    expect([PII.email, OPERATOR_ADDRESS]).toContain(r.to_address.trim().toLowerCase());
  }
  const delivered = transport.outbox.flatMap((m) => m.to);
  expect(delivered.filter(isUser)).toHaveLength(kinds.length);
  expect(delivered).not.toContain(ATTACKER);
  return rows;
}

describe("user notices across the case paths (sender run)", () => {
  it("asks for data (C6): one user_request_document", async () => {
    const t = createFakeTransport();
    const c = await seedCase({ status: "reply_received" });
    await operatorReplies(c, "asks_for_data");
    await send(t, c.id);
    await expectUserMails(c.id, t, ["user_request_document"]);
  });

  it("approved (C6): one user_final_result that asks to confirm receipt", async () => {
    const t = createFakeTransport();
    const c = await seedCase({ status: "reply_received" });
    const seen: Record<string, string>[] = [];
    const render: typeof renderTemplate = (kind, operator, vars) => {
      if (kind === "user_final_result") seen.push(vars);
      return renderTemplate(kind, operator, vars);
    };
    const { data } = await db
      .from("messages")
      .insert({
        case_id: c.id,
        direction: "inbound",
        from_address: OPERATOR_ADDRESS,
        to_address: "reclamaciones@retren.invalid",
        subject: `Re: [${c.ref}] Reclamación`,
        message_id: `<${randomUUID()}@operator.example>`,
        status: "received",
        body_text: "Aprobado.",
      })
      .select("id")
      .single();
    await applyReplyCategory(
      { caseId: c.id, messageId: data!.id, category: "approved" },
      { db, clock, render },
    );
    await send(t, c.id);
    await expectUserMails(c.id, t, ["user_final_result"]);
    expect(seen).toEqual([expect.objectContaining({ result: "approved", confirmReceipt: "yes" })]);
  });

  it("denied once (C6): the insistence goes to the operator, nothing to the user", async () => {
    const t = createFakeTransport();
    const c = await seedCase({ status: "reply_received" });
    await operatorReplies(c, "denied");
    await send(t, c.id);
    const rows = await expectUserMails(c.id, t, []);
    expect(rows.map((r) => r.template)).toEqual(["insistence_after_denial"]);
  });

  it("denied twice before d45 → escalation → 3-month close (C6, C7): one final result", async () => {
    const t = createFakeTransport();
    const sentAt = daysAgo(10);
    const c = await seedCase({ status: "reply_received", sentAt });
    await operatorReplies(c, "denied");
    await send(t, c.id);
    await db.from("cases").update({ status: "reply_received" }).eq("id", c.id);
    await operatorReplies(c, "denied");
    await send(t, c.id);
    await expectUserMails(c.id, t, []);

    // d45: the escalation to the operator, not the user.
    await runTick(db, new Date(Date.parse(sentAt) + ESCALATION_DAY * DAY + 3_600_000));
    await send(t, c.id);
    await expectUserMails(c.id, t, []);

    // 3 months: closed, and the user hears the final result once.
    await runTick(db, new Date(closeAt(sentAt).getTime() + 3_600_000));
    await send(t, c.id);
    const rows = await expectUserMails(c.id, t, ["user_final_result"]);
    expect(rows.map((r) => r.template)).toEqual([
      "insistence_after_denial",
      "escalation_d45",
      "user_final_result",
    ]);
    const { data } = await db.from("cases").select("status").eq("id", c.id).single();
    expect(data?.status).toBe("closed");
  });

  it("denied twice with no slot left for the escalation (C6): closed, one final result", async () => {
    const t = createFakeTransport();
    const c = await seedCase({ status: "reply_received", sendCount: 5 });
    await db.from("case_events").insert({
      case_id: c.id,
      kind: "reply_action",
      from_status: "denied",
      to_status: "sent",
      data: { event: "insistence_sent" },
    });
    await db.from("cases").update({ send_count: 6 }).eq("id", c.id);
    await operatorReplies(c, "denied");
    await send(t, c.id);
    await expectUserMails(c.id, t, ["user_final_result"]);
  });

  it.each(["refers_to_form", "other", "acknowledgement"] as const)(
    "%s (C6): nothing to the user",
    async (category) => {
      const t = createFakeTransport();
      const c = await seedCase({ status: "reply_received" });
      await operatorReplies(c, category);
      await send(t, c.id);
      expect(await expectUserMails(c.id, t, [])).toEqual([]);
    },
  );

  it("injection fixture (C5, C6): classified other, nothing to the user or the attacker", async () => {
    const t = createFakeTransport();
    const c = await seedCase({ status: "reply_received" });
    const fixture = loadFixture("iryo", "injection-01.eml");
    expect(fixture.mail.text).toContain(ATTACKER);
    const verdict = await createClassifier({ LLM_PROVIDER: "fake" })
      .forCase({ operator: "iryo", userEmail: PII.email })
      .classify(fixture.mail);
    expect(verdict.category).toBe("other");
    await operatorReplies(c, verdict.category, fixture.mail.text);
    await send(t, c.id);
    expect(await expectUserMails(c.id, t, [])).toEqual([]);
    expect(t.outbox).toEqual([]);
  });

  it("not eligible (C2): one user_final_result", async () => {
    const t = createFakeTransport();
    const out = await createCase(submissionFixture(20), {
      clock: fixedClock("2026-01-16T10:00:00.000Z"),
    });
    expect(out.status).toBe("closed");
    await send(t, out.caseId);
    await expectUserMails(out.caseId, t, ["user_final_result"]);
  });

  it("3-month close (C7): one user_final_result", async () => {
    const t = createFakeTransport();
    const sentAt = daysAgo(100);
    const c = await seedCase({ status: "escalated", sentAt, sendCount: 5 });
    for (const action of ["reminder_d12", "reminder_d30", "last_notice_d40", "escalation_d45"]) {
      await db
        .from("case_events")
        .insert({ case_id: c.id, kind: "timer_action", data: { action } });
    }
    await runTick(db, NOW);
    await send(t, c.id);
    await expectUserMails(c.id, t, ["user_final_result"]);
  });
});

describe("the sender refuses user mail outside the allowlist", () => {
  /** A row queued straight into the outbox, as a buggy or future writer might. */
  async function rogue(caseId: string, to: string, template: string | null) {
    const { data, error } = await db
      .from("messages")
      .insert({
        case_id: caseId,
        direction: "outbound",
        from_address: "avisos@retren.invalid",
        to_address: to,
        subject: "Aviso",
        status: "queued",
        body_text: "texto",
        template,
      })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  async function teamQueue(caseId: string) {
    const { data, error } = await db
      .from("case_events")
      .select("data")
      .eq("case_id", caseId)
      .eq("kind", TEAM_QUEUE_EVENT);
    if (error) throw error;
    return data.map((e) => e.data as Record<string, unknown>);
  }

  it.each([
    ["reminder_d12", PII.email, "user_kind_not_allowed"],
    ["escalation_d45", PII.email, "user_kind_not_allowed"],
    ["insistence_after_denial", PII.email, "user_kind_not_allowed"],
    [null, PII.email, "user_kind_not_allowed"],
    ["escalation_filing_required", PII.email, "user_kind_not_allowed"],
    ["user_final_result", "otro.viajero@example.test", "recipient_not_allowed"],
    ["user_request_document", OPERATOR_ADDRESS, "recipient_not_allowed"],
  ])("%s to %s: failed (%s), the team told, nothing sent", async (template, to, reason) => {
    const t = createFakeTransport();
    const c = await seedCase({ status: "sent" });
    const id = await rogue(c.id, to, template);
    const [res] = await send(t, c.id);
    expect(res).toEqual({ messageId: id, result: { status: "failed", reason } });
    expect(t.outbox).toEqual([]);
    const { data } = await db
      .from("messages")
      .select("status, failure_reason")
      .eq("id", id)
      .single();
    expect(data).toEqual({ status: "failed", failure_reason: reason });
    const queue = await teamQueue(c.id);
    expect(queue).toContainEqual(expect.objectContaining({ reason, message_id: id }));
    const text = JSON.stringify(queue);
    for (const v of Object.values(PII)) expect(text).not.toContain(v);
    expect(text).not.toContain(to);
  });

  it("user_escalation_signature to the user: refused until it is a TemplateKind", async () => {
    // Nothing of ours can render it yet (queueEscalationSignatureRequest refuses), so a row of
    // that kind can only come from somewhere else: never sent.
    const t = createFakeTransport();
    const c = await seedCase({ status: "escalated" });
    const id = await rogue(c.id, PII.email, ESCALATION_SIGNATURE_KIND);
    const [res] = await send(t, c.id);
    expect(res).toEqual({
      messageId: id,
      result: { status: "failed", reason: "user_kind_not_allowed" },
    });
    expect(t.outbox).toEqual([]);
    expect(await teamQueue(c.id)).toContainEqual(
      expect.objectContaining({
        reason: "user_kind_not_allowed",
        message_id: id,
        template: ESCALATION_SIGNATURE_KIND,
      }),
    );
  });

  it("a null-template row whose linked event names an operator kind, to the user: refused", async () => {
    // The sender derives the kind from the event that links the row (C6's operator_mail_queued).
    const t = createFakeTransport();
    const c = await seedCase({ status: "sent" });
    const id = await rogue(c.id, PII.email, null);
    const { error } = await db.from("case_events").insert({
      case_id: c.id,
      kind: "operator_mail_queued",
      data: { template: "insistence_after_denial", message_id: id },
    });
    if (error) throw error;
    const [res] = await send(t, c.id);
    expect(res).toEqual({
      messageId: id,
      result: { status: "failed", reason: "user_kind_not_allowed" },
    });
    expect(t.outbox).toEqual([]);
    const { data } = await db.from("messages").select("template").eq("id", id).single();
    expect(data?.template).toBe("insistence_after_denial");
  });
});

describe("queueEscalationSignatureRequest (§7.3)", () => {
  it("refuses until the kind is a TemplateKind: no render, no mail, the team is told once", async () => {
    const t = createFakeTransport();
    const c = await seedCase({ status: "escalated", sendCount: 6 });
    const calls: string[] = [];
    const render: typeof renderTemplate = (kind, operator, vars) => {
      calls.push(kind);
      return renderTemplate(kind, operator, vars);
    };
    for (let i = 0; i < 2; i++) {
      expect(await queueEscalationSignatureRequest(c.id, { db, render })).toEqual({
        ok: false,
        reason: "template_kind_missing",
      });
    }
    expect(calls).toEqual([]);
    await send(t, c.id);
    expect(await outbox(c.id)).toEqual([]);
    expect(t.outbox).toEqual([]);

    const { data, error } = await db
      .from("case_events")
      .select("data")
      .eq("case_id", c.id)
      .eq("kind", TEAM_QUEUE_EVENT);
    if (error) throw error;
    expect(data.map((e) => e.data)).toEqual([
      expect.objectContaining({
        reason: "escalation_signature_needed",
        template: ESCALATION_SIGNATURE_KIND,
      }),
    ]);
    const text = JSON.stringify(data);
    for (const v of Object.values(PII)) expect(text).not.toContain(v);
  });

  it("an unknown case: case_not_found, nothing written", async () => {
    const id = randomUUID();
    expect(await queueEscalationSignatureRequest(id, { db })).toEqual({
      ok: false,
      reason: "case_not_found",
    });
    const { data } = await db.from("case_events").select("id").eq("case_id", id);
    expect(data).toEqual([]);
  });
});
