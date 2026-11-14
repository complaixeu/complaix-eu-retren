import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClassifier } from "@/features/claims/classifier";
import { ingestMessage, type IngestDeps } from "@/features/claims/inbound";
import { fixedClock } from "@/shared/clock";
import type { CaseStatus, OperatorId } from "@/shared/contracts";
import type { Json } from "@/shared/supabase";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { PII, submissionFixture } from "../../fixtures/claims/submission";
import { waitForDb } from "../../fixtures/claims/db-ready";
import { MAIL_FIXTURES_DIR } from "../../fixtures/mail/golden";

// Per-operator test inboxes on the inbound path (MAIL_OPERATOR_INBOXES, C3, C4), against the local
// Supabase with the golden fixtures. Placeholder addresses only (example.com); fake classifier.
const NOW = new Date("2030-03-01T10:00:00.000Z");
const DAY = 86_400_000;
const OUR_MAILBOX = "retren@retren.example";
const IRYO_TESTER = "iryo-tester@example.com";
const RENFE_TESTER = "renfe-tester@example.com";
const ENV = {
  MAIL_PROVIDER: "fake",
  SMTP_USER: OUR_MAILBOX,
  MAIL_REDIRECT_ALL_TO: "team@retren.example",
  MAIL_OPERATOR_INBOXES: `iryo:${IRYO_TESTER},renfe:${RENFE_TESTER}`,
};

let db: ServiceClient;
let deps: IngestDeps;
beforeAll(async () => {
  db = createServiceClient();
  await waitForDb(db);
  deps = { db, env: ENV, clock: fixedClock(NOW.toISOString()), classifier: createClassifier(ENV) };
});
afterEach(() => vi.restoreAllMocks());

// The shared database is read by every integration file: cases seeded here are closed at the end,
// and their queued mail is failed, so a later file's tick never picks them up.
const seededCases: string[] = [];
afterAll(async () => {
  if (!seededCases.length) return;
  const { error } = await db
    .from("messages")
    .update({ status: "failed", failure_reason: "test_cleanup" })
    .in("case_id", seededCases)
    .eq("direction", "outbound")
    .eq("status", "queued");
  if (error) throw error;
  const closed = await db.from("cases").update({ status: "closed" }).in("id", seededCases);
  if (closed.error) throw closed.error;
});

type Seeded = { id: string; ref: string; claimMessageId: string };

/** A case of `operator` whose initial claim went out (status `sent`). */
async function seedCase(operator: OperatorId, status: CaseStatus = "sent"): Promise<Seeded> {
  const ref = `RTN-${randomUUID().slice(0, 8).toUpperCase()}`;
  const sentAt = new Date(NOW.getTime() - 10 * DAY).toISOString();
  const { data, error } = await db
    .from("cases")
    .insert({
      public_ref: ref,
      operator,
      status,
      submission: submissionFixture(90) as unknown as NonNullable<Json>,
      user_email: PII.email,
      sent_at: sentAt,
      send_count: 1,
    })
    .select("id")
    .single();
  if (error) throw error;
  const claimMessageId = `<${ref.toLowerCase()}.${randomUUID()}@retren.example>`;
  const { error: e } = await db.from("messages").insert({
    case_id: data.id,
    direction: "outbound",
    from_address: "reclamaciones@retren.invalid",
    to_address: "placeholder@example.com",
    subject: `[${ref}] Reclamación`,
    message_id: claimMessageId,
    status: "sent",
    template: "initial_claim",
    created_at: sentAt,
  });
  if (e) throw e;
  seededCases.push(data.id);
  return { id: data.id, ref, claimMessageId };
}

/**
 * A golden approved fixture, threaded onto `c`'s claim and carrying `c`'s reference, sent from
 * `from` instead of the operator's own address. Its Message-ID is fresh.
 */
function replyFrom(
  from: string,
  c: Seeded,
  fixture = "approved-01.eml",
): { raw: Buffer; messageId: string } {
  const messageId = `<fixture-${randomUUID()}@mail.example>`;
  const text = readFileSync(join(MAIL_FIXTURES_DIR, "iryo", fixture), "utf8")
    .replace(/^Message-ID: .*$/m, `Message-ID: ${messageId}`)
    .replace(/^From: .*$/m, `From: ${from}`)
    .replace(/\[RTN-[A-Z0-9]+\]/g, `[${c.ref}]`)
    .replace(/<claim-rtn-[a-z0-9]+@retren\.example>/g, c.claimMessageId);
  return { raw: Buffer.from(text.replace(/\r?\n/g, "\r\n")), messageId };
}

async function stored(messageId: string) {
  const { data, error } = await db.from("messages").select("*").eq("message_id", messageId);
  if (error) throw error;
  return data;
}

async function caseState(caseId: string) {
  const [c, events, outbox] = await Promise.all([
    db.from("cases").select("status").eq("id", caseId).single(),
    db.from("case_events").select("kind, data").eq("case_id", caseId).order("created_at"),
    db.from("messages").select("*").eq("case_id", caseId).eq("status", "queued"),
  ]);
  if (c.error || events.error || outbox.error) throw c.error ?? events.error ?? outbox.error;
  return { status: c.data.status, events: events.data, outbox: outbox.data };
}

const queueReasons = (events: { kind: string; data: Json }[]) =>
  events
    .filter((e) => e.kind === "team_queue")
    .map((e) => (e.data as Record<string, unknown>).reason);

describe("per-operator test inboxes on the inbound path (local Supabase)", () => {
  it("a reply from Renfe's mapped inbox, with the right reference, is accepted for the Renfe case", async () => {
    const c = await seedCase("renfe");
    const m = replyFrom(RENFE_TESTER, c);
    const classify = vi.spyOn(deps.classifier!, "forCase");
    const out = await ingestMessage(m.raw, deps);
    expect(out).toMatchObject({ outcome: "applied", caseId: c.id, category: "approved" });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(await stored(m.messageId)).toMatchObject([
      { case_id: c.id, direction: "inbound", from_address: RENFE_TESTER, category: "approved" },
    ]);
    expect(queueReasons((await caseState(c.id)).events)).toEqual([]);
  });

  it("the same sender on an Iryo case is rejected: the Renfe inbox is never Iryo's", async () => {
    const c = await seedCase("iryo");
    const m = replyFrom(RENFE_TESTER, c);
    const classify = vi.spyOn(deps.classifier!, "forCase");
    expect(await ingestMessage(m.raw, deps)).toMatchObject({
      outcome: "team_queue",
      caseId: c.id,
      reason: "wrong_sender",
    });
    expect(classify).not.toHaveBeenCalled();
    const s = await caseState(c.id);
    expect(s.status).toBe("sent");
    expect(queueReasons(s.events)).toEqual(["wrong_sender"]);
    expect(s.outbox).toEqual([]);
  });

  it("Iryo's mapped inbox is accepted for the Iryo case", async () => {
    const c = await seedCase("iryo");
    const m = replyFrom(IRYO_TESTER, c);
    expect(await ingestMessage(m.raw, deps)).toMatchObject({
      outcome: "applied",
      caseId: c.id,
      category: "approved",
    });
    expect((await caseState(c.id)).status).toBe("resolved");
  });

  it("an unmapped sender is still rejected, even on a case whose operator has a test inbox", async () => {
    const c = await seedCase("iryo");
    const m = replyFrom("someone@example.org", c);
    const classify = vi.spyOn(deps.classifier!, "forCase");
    expect(await ingestMessage(m.raw, deps)).toMatchObject({
      outcome: "team_queue",
      caseId: c.id,
      reason: "wrong_sender",
    });
    expect(classify).not.toHaveBeenCalled();
    expect((await caseState(c.id)).outbox).toEqual([]);
  });

  it("an injection fixture from a mapped inbox: nothing is ever sent to the address it contains", async () => {
    const c = await seedCase("iryo");
    const m = replyFrom(IRYO_TESTER, c, "injection-01.eml");
    // Other suites seed refused rows to such addresses on purpose: compare before and after.
    const toEvil = async () =>
      (await db.from("messages").select("id").ilike("to_address", "%evil%")).data?.length;
    const before = await toEvil();
    const out = await ingestMessage(m.raw, deps);
    expect(out).toMatchObject({ outcome: "applied", category: "other" });
    const s = await caseState(c.id);
    expect(queueReasons(s.events)).toEqual(["other"]);
    expect(s.outbox).toEqual([]);
    expect(await toEvil()).toBe(before);
  });

  it("without MAIL_OPERATOR_INBOXES the test inbox is an unknown sender again", async () => {
    const c = await seedCase("iryo");
    const m = replyFrom(IRYO_TESTER, c);
    const plain = { ...deps, env: { ...ENV, MAIL_OPERATOR_INBOXES: undefined } };
    expect(await ingestMessage(m.raw, plain)).toMatchObject({
      outcome: "team_queue",
      caseId: c.id,
      reason: "wrong_sender",
    });
  });

  it("a malformed MAIL_OPERATOR_INBOXES stops the inbound path before anything is stored", async () => {
    const c = await seedCase("iryo");
    const m = replyFrom(IRYO_TESTER, c);
    const broken = { ...deps, env: { ...ENV, MAIL_OPERATOR_INBOXES: `iryo:${OUR_MAILBOX}` } };
    await expect(ingestMessage(m.raw, broken)).rejects.toThrow(/MAIL_OPERATOR_INBOXES/);
    expect(await stored(m.messageId)).toEqual([]);
  });
});
