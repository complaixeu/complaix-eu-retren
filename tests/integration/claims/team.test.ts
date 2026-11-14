import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  TEAM_RESOLVED_EVENT,
  TeamActionError,
  getCaseView,
  injectOperatorReply,
  listCases,
  listQueue,
  resolveQueueItem,
  runDemoTick,
} from "@/features/claims/team";
import { ingestForTeam } from "@/features/claims/team-ingest";
import { getOperatorConfig } from "@/features/rules";
import type { CaseStatus } from "@/shared/contracts";
import type { Json } from "@/shared/supabase";
import { createServiceClient } from "@/shared/supabase/server";
import { PII, submissionFixture } from "../../fixtures/claims/submission";
import { waitForDb } from "../../fixtures/claims/db-ready";

// [C9] The team view's logic against the local Supabase: the queue, a case's timeline, resolving
// an item (append-only), injecting a scripted reply and moving the demo clock. Fake mail only.
const db = createServiceClient();
const DAY = 86_400_000;
const DEMO = { DEMO_MODE: "1", MAIL_PROVIDER: "fake" };

const OPERATOR_ADDRESS = (() => {
  const ch = getOperatorConfig("iryo").channel;
  if (ch.type !== "email") throw new Error("the iryo config must have an email channel");
  return ch.address;
})();

const seeded: string[] = [];
beforeAll(async () => {
  await waitForDb(db);
});
// The next files send at most a fixed number of queued rows per tick: leave none of ours queued.
afterAll(async () => {
  if (seeded.length === 0) return;
  const { error } = await db
    .from("messages")
    .update({ status: "failed", failure_reason: "test_cleanup" })
    .in("case_id", seeded)
    .eq("status", "queued");
  if (error) throw error;
});

async function seedCase(status: CaseStatus = "sent", sentDaysAgo = 1) {
  const ref = `RTN-${randomUUID().slice(0, 8).toUpperCase()}`;
  const sentAt = new Date(Date.now() - sentDaysAgo * DAY).toISOString();
  const { data, error } = await db
    .from("cases")
    .insert({
      public_ref: ref,
      operator: "iryo",
      status,
      submission: submissionFixture(90) as unknown as NonNullable<Json>,
      user_email: PII.email,
      sent_at: sentAt,
      next_action_at: sentAt,
      send_count: 1,
    })
    .select("id")
    .single();
  if (error) throw error;
  seeded.push(data.id);
  const claimMessageId = `<${randomUUID()}@retren.example>`;
  const { error: e } = await db.from("messages").insert({
    case_id: data.id,
    direction: "outbound",
    from_address: "reclamaciones@retren.invalid",
    to_address: OPERATOR_ADDRESS,
    subject: `[${ref}] Reclamación`,
    message_id: claimMessageId,
    status: "sent",
    template: "initial_claim",
    body_text: "initial claim",
    created_at: sentAt,
  });
  if (e) throw e;
  return { id: data.id, ref, claimMessageId };
}

async function queueEvent(caseId: string, kind: string, data: Record<string, unknown>) {
  const { data: row, error } = await db
    .from("case_events")
    .insert({ case_id: caseId, kind, data: data as NonNullable<Json> })
    .select("id")
    .single();
  if (error) throw error;
  return row.id;
}

describe("listQueue", () => {
  it("lists team_queue and escalation events with their reason codes, newest first", async () => {
    const c = await seedCase();
    const wrong = await queueEvent(c.id, "team_queue", { reason: "wrong_sender" });
    const lost = await queueEvent(c.id, "team_queue", {
      reason: "delivery_unknown",
      source: "outbound",
    });
    const filing = await queueEvent(c.id, "escalation_filing_required", { bodies: ["dgtt"] });
    const sig = await queueEvent(c.id, "escalation_signature_needed", {});
    await queueEvent(c.id, "message_sent", {});

    const mine = (await listQueue(db)).filter((i) => i.caseId === c.id);
    expect(mine.map((i) => [i.id, i.reason]).sort()).toEqual(
      [
        [wrong, "wrong_sender"],
        [lost, "delivery_unknown"],
        [filing, "escalation_filing_required"],
        [sig, "escalation_signature_needed"],
      ].sort(),
    );
    expect(mine.every((i) => i.publicRef === c.ref && i.source === "event")).toBe(true);
  });

  it("lists inbound mail with no case, and stops listing it once resolved", async () => {
    const messageId = `<${randomUUID()}@operator.example>`;
    const { data, error } = await db
      .from("messages")
      .insert({
        case_id: null,
        direction: "inbound",
        from_address: OPERATOR_ADDRESS,
        to_address: "reclamaciones@retren.invalid",
        subject: "Re: [RTN-NOPE] Reclamación",
        message_id: messageId,
        status: "received",
        inbound_queue_reason: "unknown_reference",
      })
      .select("id")
      .single();
    if (error) throw error;

    const item = (await listQueue(db)).find((i) => i.id === data.id);
    expect(item).toMatchObject({
      source: "message",
      caseId: null,
      publicRef: null,
      reason: "unknown_reference",
    });

    await resolveQueueItem(db, { source: "message", id: data.id });
    expect((await listQueue(db)).some((i) => i.id === data.id)).toBe(false);
    // Never deleted: the mail is still stored.
    const stored = await db.from("messages").select("id, team_resolved_at").eq("id", data.id);
    expect(stored.data?.[0]?.team_resolved_at).not.toBeNull();
  });
});

describe("resolveQueueItem", () => {
  it("appends a team_queue_resolved event with no personal data and never deletes", async () => {
    const c = await seedCase();
    const id = await queueEvent(c.id, "team_queue", { reason: "other" });
    await resolveQueueItem(db, { source: "event", id });

    expect((await listQueue(db)).some((i) => i.id === id)).toBe(false);
    const events = await db.from("case_events").select("*").eq("case_id", c.id);
    const resolved = events.data?.filter((e) => e.kind === TEAM_RESOLVED_EVENT) ?? [];
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.data).toEqual({ resolves: id, resolved_kind: "team_queue" });
    expect(JSON.stringify(resolved)).not.toContain(PII.email);
    // The original event is still there.
    expect(events.data?.some((e) => e.id === id)).toBe(true);
  });

  it("refuses a second resolution, an unknown id and an event that is not a queue item", async () => {
    const c = await seedCase();
    const id = await queueEvent(c.id, "team_queue", { reason: "other" });
    await resolveQueueItem(db, { source: "event", id });
    await expect(resolveQueueItem(db, { source: "event", id })).rejects.toMatchObject({
      code: "already_resolved",
    });
    await expect(resolveQueueItem(db, { source: "event", id: randomUUID() })).rejects.toMatchObject(
      { code: "not_found" },
    );
    const other = await queueEvent(c.id, "message_sent", {});
    await expect(resolveQueueItem(db, { source: "event", id: other })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(resolveQueueItem(db, { source: "event", id: "x" })).rejects.toBeInstanceOf(
      TeamActionError,
    );
  });
});

describe("getCaseView and listCases", () => {
  it("shows events and messages, with the body of operator mail only", async () => {
    const c = await seedCase();
    await db.from("messages").insert({
      case_id: c.id,
      direction: "inbound",
      from_address: OPERATOR_ADDRESS,
      to_address: "reclamaciones@retren.invalid",
      subject: "Re: reclamación",
      message_id: `<${randomUUID()}@operator.example>`,
      status: "received",
      category: "other",
      body_text: "<b>texto del operador</b>",
    });
    const open = await queueEvent(c.id, "team_queue", { reason: "other" });

    const view = await getCaseView(db, c.id);
    expect(view?.case).toMatchObject({ publicRef: c.ref, status: "sent", operator: "iryo" });
    expect(view?.messages.map((m) => [m.direction, m.kind, m.status])).toEqual([
      ["outbound", "initial_claim", "sent"],
      ["inbound", "other", "received"],
    ]);
    expect(view?.messages[0]?.body).toBeNull();
    expect(view?.messages[1]?.body).toBe("<b>texto del operador</b>");
    expect(view?.open.map((i) => i.id)).toEqual([open]);
    expect(JSON.stringify(view)).not.toContain(PII.email);

    expect((await listCases(db)).some((s) => s.id === c.id)).toBe(true);
    expect(await getCaseView(db, randomUUID())).toBeNull();
    expect(await getCaseView(db, "not-a-uuid")).toBeNull();
  });

  // Found by C10: C6 queues its mail with no template (the sender fills it in on send), so a
  // queued insistence, notice or forward showed as "sin tipo". The kind comes from the event that
  // queued it ({template, message_id}), like the sender derives it.
  it("shows the kind of a queued outbound row from the event that queued it", async () => {
    const c = await seedCase();
    const { data: queued, error } = await db
      .from("messages")
      .insert({
        case_id: c.id,
        direction: "outbound",
        from_address: "reclamaciones@retren.invalid",
        to_address: OPERATOR_ADDRESS,
        subject: `[${c.ref}] Insistencia`,
        status: "queued",
        body_text: "insistence",
      })
      .select("id")
      .single();
    if (error) throw error;
    await queueEvent(c.id, "operator_mail_queued", {
      template: "insistence_after_denial",
      message_id: queued.id,
    });
    // A queued row that no event names stays without a kind.
    const { error: e2 } = await db.from("messages").insert({
      case_id: c.id,
      direction: "outbound",
      from_address: "reclamaciones@retren.invalid",
      to_address: OPERATOR_ADDRESS,
      subject: `[${c.ref}] Sin evento`,
      status: "queued",
      body_text: "unknown",
    });
    if (e2) throw e2;

    const view = await getCaseView(db, c.id);
    expect(view?.messages.map((m) => [m.direction, m.kind, m.status])).toEqual([
      ["outbound", "initial_claim", "sent"],
      ["outbound", "insistence_after_denial", "queued"],
      ["outbound", null, "queued"],
    ]);
  });

  // The sender's other fallback (messageKind): a C7 row queued without a template is named by the
  // `timer_action` event written in the same transaction (same created_at). close_3m is the
  // user_final_result notice.
  it("shows the kind of a queued timer row from its timer_action event", async () => {
    const c = await seedCase();
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const rows = [
      { action: "reminder_d12", createdAt: at(1_000), to: OPERATOR_ADDRESS },
      { action: "close_3m", createdAt: at(2_000), to: PII.email },
    ];
    for (const r of rows) {
      const { error } = await db.from("messages").insert({
        case_id: c.id,
        direction: "outbound",
        from_address: "reclamaciones@retren.invalid",
        to_address: r.to,
        subject: `[${c.ref}] ${r.action}`,
        status: "queued",
        body_text: r.action,
        created_at: r.createdAt,
      });
      if (error) throw error;
      const ev = await db.from("case_events").insert({
        case_id: c.id,
        kind: "timer_action",
        data: { action: r.action },
        created_at: r.createdAt,
      });
      if (ev.error) throw ev.error;
    }

    const view = await getCaseView(db, c.id);
    expect(view?.messages.map((m) => [m.direction, m.kind, m.status])).toEqual([
      ["outbound", "initial_claim", "sent"],
      ["outbound", "reminder_d12", "queued"],
      ["outbound", "user_final_result", "queued"],
    ]);
  });
});

describe("injectOperatorReply", () => {
  it("hands C4 a mail threaded onto the case's initial claim with a fresh Message-ID", async () => {
    const c = await seedCase();
    const ingest = vi.fn(async () => ({ outcome: "applied", status: "waiting_user" }));
    const out = await injectOperatorReply(
      db,
      { caseId: c.id, fixture: "asks_for_data-01" },
      { ingest, env: DEMO, newMessageId: () => "<scripted-test@mail.example>" },
    );
    expect(out.outcome).toBe("applied");
    expect(ingest).toHaveBeenCalledTimes(1);
    const raw = (ingest.mock.calls[0] as unknown as [string])[0];
    expect(raw).toContain("Message-ID: <scripted-test@mail.example>");
    expect(raw).toContain(`In-Reply-To: ${c.claimMessageId}`);
    expect(raw).toContain(`References: ${c.claimMessageId}`);
    expect(raw).toContain(`[${c.ref}]`);
    expect(raw).toContain("IBAN");
  });

  it("goes through C4, C5 and C6 for real: an IBAN request moves the case and queues the notice", async () => {
    const c = await seedCase();
    const out = await injectOperatorReply(
      db,
      { caseId: c.id, fixture: "asks_for_data-01" },
      { ingest: ingestForTeam, env: DEMO },
    );
    expect(out).toMatchObject({ outcome: "applied", status: "waiting_user" });

    const view = await getCaseView(db, c.id);
    expect(view?.case.status).toBe("waiting_user");
    expect(view?.messages.map((m) => [m.direction, m.kind, m.status])).toContainEqual([
      "inbound",
      "asks_for_data",
      "received",
    ]);
    // The notice to the user is in the outbox.
    const outbox = view?.messages.filter(
      (m) => m.direction === "outbound" && m.status === "queued",
    );
    expect(outbox?.length).toBe(1);

    // The same fixture again is a new mail (fresh Message-ID), not a duplicate.
    const again = await injectOperatorReply(
      db,
      { caseId: c.id, fixture: "asks_for_data-01" },
      { ingest: ingestForTeam, env: DEMO },
    );
    expect(again.outcome).not.toBe("duplicate");
  });

  it("is demo only, and refuses unknown fixtures, cases and path tricks", async () => {
    const c = await seedCase();
    const ingest = vi.fn(async () => ({ outcome: "applied" }));
    const go = (caseId: string, fixture: string, env: Record<string, string> = DEMO) =>
      injectOperatorReply(db, { caseId, fixture }, { ingest, env });

    await expect(go(c.id, "approved-01", { DEMO_MODE: "0" })).rejects.toMatchObject({
      code: "demo_only",
    });
    await expect(go(c.id, "no-such-01")).rejects.toMatchObject({ code: "bad_fixture" });
    await expect(go(c.id, "../../../etc/passwd")).rejects.toMatchObject({ code: "bad_input" });
    await expect(go(randomUUID(), "approved-01")).rejects.toMatchObject({ code: "not_found" });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("refuses a case whose initial claim was never sent", async () => {
    const c = await seedCase();
    await db.from("messages").update({ status: "queued" }).eq("case_id", c.id);
    const ingest = vi.fn(async () => ({ outcome: "applied" }));
    await expect(
      injectOperatorReply(db, { caseId: c.id, fixture: "approved-01" }, { ingest, env: DEMO }),
    ).rejects.toMatchObject({ code: "no_initial_claim" });
  });

  it("turns a failure of the ingest into a code, with nothing leaked", async () => {
    const c = await seedCase();
    const ingest = vi.fn(async () => {
      throw new Error("secret connection string");
    });
    await expect(
      injectOperatorReply(db, { caseId: c.id, fixture: "approved-01" }, { ingest, env: DEMO }),
    ).rejects.toMatchObject({ code: "ingest_failed", message: "ingest_failed" });
  });
});

describe("runDemoTick", () => {
  it("is demo only, and never with a real mail provider", async () => {
    const c = await seedCase("sent", 0);
    for (const env of [{ DEMO_MODE: "0" }, { DEMO_MODE: "1", MAIL_PROVIDER: "gmail" }]) {
      await expect(runDemoTick(db, new Date(), c.id, env)).rejects.toMatchObject({
        code: "demo_only",
      });
    }
  });

  it("moved to d30, queues and sends the reminder due for the case viewed", async () => {
    const c = await seedCase("sent", 0);
    const now = new Date(Date.now() + 30 * DAY + 3_600_000);
    const out = await runDemoTick(db, now, c.id, DEMO);
    expect(out.timerActions).toBeGreaterThanOrEqual(1);

    const messages = await db
      .from("messages")
      .select("template, status, direction")
      .eq("case_id", c.id)
      .eq("direction", "outbound");
    const templates = messages.data?.map((m) => m.template) ?? [];
    // A stage whose window has passed is skipped (C7), so d30 is the reminder due now.
    expect(templates).toContain("reminder_d30");
    // The fake transport sent them.
    expect(messages.data?.filter((m) => m.template?.startsWith("reminder_"))).toSatisfy(
      (rows: { status: string }[]) => rows.every((r) => r.status === "sent"),
    );
  });

  it("touches only that case: another case's due reminder and queued mail stay as they are", async () => {
    const x = await seedCase("sent", 0);
    const y = await seedCase("sent", 0);
    // Y already has mail waiting in the outbox.
    const { error } = await db.from("messages").insert({
      case_id: y.id,
      direction: "outbound",
      from_address: "avisos@retren.invalid",
      to_address: PII.email,
      subject: `[${y.ref}] Aviso`,
      message_id: `<${randomUUID()}@retren.example>`,
      status: "queued",
      template: "user_request_document",
      body_text: "x",
    });
    if (error) throw error;

    await runDemoTick(db, new Date(Date.now() + 30 * DAY + 3_600_000), x.id, DEMO);

    const mine = await db.from("messages").select("template").eq("case_id", x.id);
    expect(mine.data?.map((m) => m.template)).toContain("reminder_d30");

    const theirs = await db
      .from("messages")
      .select("template, status")
      .eq("case_id", y.id)
      .eq("direction", "outbound");
    expect(theirs.data?.map((m) => [m.template, m.status]).sort()).toEqual([
      ["initial_claim", "sent"],
      ["user_request_document", "queued"],
    ]);
    const events = await db.from("case_events").select("kind").eq("case_id", y.id);
    expect(events.data?.some((e) => e.kind === "timer_action")).toBe(false);
    const row = await db.from("cases").select("send_count, status").eq("id", y.id).single();
    expect(row.data).toEqual({ send_count: 1, status: "sent" });
  });
});
