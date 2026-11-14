import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { USER_DOCUMENTS_BUCKET } from "@/features/claims/actions";
import { createClassifier } from "@/features/claims/classifier";
import { RAW_MAIL_BUCKET, ingestMessage, type IngestDeps } from "@/features/claims/inbound";
import { dbPollState } from "@/features/claims/poll-inbox";
import { getOperatorConfig } from "@/features/rules";
import { fixedClock } from "@/shared/clock";
import type { CaseStatus } from "@/shared/contracts";
import type { Json } from "@/shared/supabase";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { PII, submissionFixture } from "../../fixtures/claims/submission";
import { waitForDb } from "../../fixtures/claims/db-ready";
import { MAIL_FIXTURES_DIR } from "../../fixtures/mail/golden";

// ingestMessage (plan C4) against the local Supabase, with the golden .eml fixtures: matched,
// unknown reference, wrong sender, spoofed reference, the same Message-ID twice, our own mail, a
// redirected copy and unrelated mail (skipped: nothing stored). Fake classifier, fake mail only.
const NOW = new Date("2030-03-01T10:00:00.000Z");
const DAY = 86_400_000;
const OUR_MAILBOX = "retren@retren.example";
const REDIRECT = "team@retren.example";
const ENV = {
  MAIL_PROVIDER: "fake",
  SMTP_USER: OUR_MAILBOX,
  MAIL_REDIRECT_ALL_TO: REDIRECT,
};
const OPERATOR_ADDRESS = (() => {
  const ch = getOperatorConfig("iryo").channel;
  if (ch.type !== "email") throw new Error("the iryo config must have an email channel");
  return ch.address;
})();

let db: ServiceClient;
let deps: IngestDeps;
beforeAll(async () => {
  db = createServiceClient();
  await waitForDb(db);
  deps = { db, env: ENV, clock: fixedClock(NOW.toISOString()), classifier: createClassifier(ENV) };
});
afterEach(() => vi.restoreAllMocks());

// The database is shared by every integration file, and the tick sends the oldest 100 queued rows
// (OUTBOUND_TICK_LIMIT). Neither the mail these tests queue nor the notices a later tick would
// queue for their cases may crowd out a later file's rows.
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
  // …and the cases must not be due for a later file's tick (the 3-month close applies even to a
  // paused case, and would queue a notice for each): a closed case is never looked at again.
  const closed = await db.from("cases").update({ status: "closed" }).in("id", seededCases);
  if (closed.error) throw closed.error;
});

type Seeded = { id: string; ref: string; claimMessageId: string; noticeMessageId: string };

/** A case whose initial claim went to the operator (and, optionally, a notice to the user). */
async function seedCase(status: CaseStatus = "sent"): Promise<Seeded> {
  const ref = `RTN-${randomUUID().slice(0, 8).toUpperCase()}`;
  const sentAt = new Date(NOW.getTime() - 10 * DAY).toISOString();
  const { data, error } = await db
    .from("cases")
    .insert({
      public_ref: ref,
      operator: "iryo",
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
  const noticeMessageId = `<${ref.toLowerCase()}.${randomUUID()}@retren.example>`;
  const { error: e } = await db.from("messages").insert([
    {
      case_id: data.id,
      direction: "outbound",
      from_address: "reclamaciones@retren.invalid",
      to_address: OPERATOR_ADDRESS,
      subject: `[${ref}] Reclamación`,
      message_id: claimMessageId,
      status: "sent",
      template: "initial_claim",
      created_at: sentAt,
    },
    {
      case_id: data.id,
      direction: "outbound",
      from_address: "avisos@retren.invalid",
      to_address: PII.email,
      subject: `[${ref}] Necesitamos un documento`,
      message_id: noticeMessageId,
      status: "sent",
      template: "user_request_document",
      created_at: new Date(NOW.getTime() - DAY).toISOString(),
    },
  ]);
  if (e) throw e;
  seededCases.push(data.id);
  return { id: data.id, ref, claimMessageId, noticeMessageId };
}

/**
 * A golden fixture rewritten onto a seeded case: its [RTN-T…] becomes the case reference, the
 * header threading onto our claim (`claim-rtn-…@retren.example`) becomes the claim's real
 * Message-ID, and its own Message-ID is fresh so every run is independent.
 */
function eml(
  name: string,
  c: Pick<Seeded, "ref" | "claimMessageId"> | null,
  over: { messageId?: string; ref?: string } = {},
): { raw: Buffer; messageId: string } {
  const messageId = over.messageId ?? `<fixture-${randomUUID()}@mail.example>`;
  let text = readFileSync(join(MAIL_FIXTURES_DIR, "iryo", name), "utf8");
  text = text.replace(/^Message-ID: .*$/m, `Message-ID: ${messageId}`);
  const ref = over.ref ?? c?.ref;
  if (ref) text = text.replace(/\[RTN-[A-Z0-9]+\]/g, `[${ref}]`);
  if (c) text = text.replace(/<claim-rtn-[a-z0-9]+@retren\.example>/g, c.claimMessageId);
  return { raw: Buffer.from(text.replace(/\r?\n/g, "\r\n")), messageId };
}

/** A tests/fixtures/claims/inbound fixture (reference only, no thread) for a seeded case. */
function refOnly(name: string, ref: string): { raw: Buffer; messageId: string } {
  const messageId = `<fixture-${randomUUID()}@mail.example>`;
  const text = readFileSync(
    join(process.cwd(), "tests", "fixtures", "claims", "inbound", name),
    "utf8",
  )
    .replace(/^Message-ID: .*$/m, `Message-ID: ${messageId}`)
    .replace(/\[RTN-T100\]/g, `[${ref}]`);
  return { raw: Buffer.from(text.replace(/\r?\n/g, "\r\n")), messageId };
}

/** A hand-built mail (CRLF), with optional extra headers and attachment. */
function mail(h: {
  from: string;
  to?: string;
  subject: string;
  inReplyTo?: string;
  body?: string;
  attachment?: { filename: string; contentType: string; bytes: Buffer };
}): { raw: Buffer; messageId: string } {
  const messageId = `<hand-${randomUUID()}@mail.example>`;
  const head = [
    `From: ${h.from}`,
    `To: ${h.to ?? OUR_MAILBOX}`,
    `Subject: ${h.subject}`,
    `Date: Mon, 02 Nov 2026 10:00:00 +0100`,
    `Message-ID: ${messageId}`,
    ...(h.inReplyTo ? [`In-Reply-To: ${h.inReplyTo}`, `References: ${h.inReplyTo}`] : []),
    "MIME-Version: 1.0",
  ];
  const body = h.body ?? "Texto de prueba ficticio.";
  if (!h.attachment) {
    return {
      raw: Buffer.from(
        [...head, "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n"),
      ),
      messageId,
    };
  }
  const b = "c4-boundary";
  const a = h.attachment;
  return {
    raw: Buffer.from(
      [
        ...head,
        `Content-Type: multipart/mixed; boundary="${b}"`,
        "",
        `--${b}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        body,
        `--${b}`,
        `Content-Type: ${a.contentType}; name="${a.filename}"`,
        `Content-Disposition: attachment; filename="${a.filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        a.bytes.toString("base64"),
        `--${b}--`,
        "",
      ].join("\r\n"),
    ),
    messageId,
  };
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

const rawKey = (messageId: string) => `${createHash("sha256").update(messageId).digest("hex")}.eml`;

async function rawExists(messageId: string): Promise<boolean> {
  const { data } = await db.storage.from(RAW_MAIL_BUCKET).download(rawKey(messageId));
  return !!data;
}

const queueReasons = (events: { kind: string; data: Json }[]) =>
  events
    .filter((e) => e.kind === "team_queue")
    .map((e) => (e.data as Record<string, unknown>).reason);

/** Nothing about this Message-ID reached the database or storage, and nothing was logged. */
async function expectNothingStored(messageId: string) {
  expect(await stored(messageId)).toEqual([]);
  expect(await rawExists(messageId)).toBe(false);
}

describe("ingestMessage (local Supabase)", () => {
  it("matched: recorded, raw mail stored privately, operator_replied, classified and acted on", async () => {
    const c = await seedCase();
    const m = eml("approved-01.eml", c);
    const out = await ingestMessage(m.raw, deps);
    expect(out).toMatchObject({ outcome: "applied", caseId: c.id, category: "approved" });

    const [row] = await stored(m.messageId);
    expect(row).toMatchObject({
      case_id: c.id,
      direction: "inbound",
      status: "received",
      from_address: OPERATOR_ADDRESS,
      in_reply_to: c.claimMessageId,
      category: "approved",
      inbound_queue_reason: null,
      raw_path: `${RAW_MAIL_BUCKET}/${rawKey(m.messageId)}`,
    });
    expect(await rawExists(m.messageId)).toBe(true);
    const s = await caseState(c.id);
    expect(s.status).toBe("resolved");
    expect(s.events.map((e) => e.kind)).toEqual([
      "operator_replied",
      "reply_action",
      "user_notice_queued",
    ]);
    expect(s.outbox.map((x) => x.to_address)).toEqual([PII.email]);
  });

  it("matched by the thread alone (no reference in the subject)", async () => {
    const c = await seedCase();
    const m = eml("asks_for_data-01.eml", c);
    const noRef = Buffer.from(m.raw.toString().replace(/\s*\[RTN-[A-Z0-9]+\]/g, ""));
    expect(await ingestMessage(noRef, deps)).toMatchObject({
      outcome: "applied",
      category: "asks_for_data",
    });
    expect((await caseState(c.id)).status).toBe("waiting_user");
  });

  it("unknown reference: recorded without a case, in the team queue, never classified", async () => {
    const m = eml("spoofed-ref-01.eml", null, { ref: "RTN-0000ZZZZ" });
    const out = await ingestMessage(m.raw, deps);
    expect(out).toMatchObject({ outcome: "team_queue", caseId: null, reason: "unknown_reference" });
    const [row] = await stored(m.messageId);
    expect(row).toMatchObject({
      case_id: null,
      inbound_queue_reason: "unknown_reference",
      category: null,
    });
    expect(await rawExists(m.messageId)).toBe(true);
  });

  it("wrong sender: threaded onto our claim from outside the operator's domain → team queue", async () => {
    for (const file of ["wrong-sender-01.eml", "wrong-sender-02.eml"]) {
      const c = await seedCase();
      const m = eml(file, c);
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
      expect((await stored(m.messageId))[0]).toMatchObject({ case_id: c.id, category: null });
    }
  });

  it("our reference only, operator domain, aligned dkim=pass (no thread): matched and classified", async () => {
    const c = await seedCase();
    const m = refOnly("ref-only-dkim-pass.eml", c.ref);
    expect(await ingestMessage(m.raw, deps)).toMatchObject({
      outcome: "applied",
      caseId: c.id,
      category: "approved",
    });
    expect((await caseState(c.id)).status).toBe("resolved");
    expect((await stored(m.messageId))[0]).toMatchObject({ case_id: c.id, category: "approved" });
  });

  it("our reference only, without a trusted dkim=pass or from a foreign sender: spoofed", async () => {
    for (const file of [
      "ref-only-no-auth.eml",
      "ref-only-dkim-fail.eml",
      "ref-only-forged-auth.eml",
      "ref-only-other-dkim-domain.eml",
      "ref-only-foreign-sender.eml",
    ]) {
      const c = await seedCase();
      const m = refOnly(file, c.ref);
      const classify = vi.spyOn(deps.classifier!, "forCase");
      expect(await ingestMessage(m.raw, deps), file).toMatchObject({
        outcome: "team_queue",
        caseId: c.id,
        reason: "spoofed_reference",
      });
      expect(classify, file).not.toHaveBeenCalled();
      classify.mockRestore();
      const s = await caseState(c.id);
      expect(s.status, file).toBe("sent");
      expect(s.outbox, file).toEqual([]);
      expect((await stored(m.messageId))[0].category, file).toBeNull();
    }
  });

  it("a reference only naming no case, even with dkim=pass: unknown reference", async () => {
    const m = refOnly("ref-only-dkim-pass.eml", "RTN-0000YYYY");
    expect(await ingestMessage(m.raw, deps)).toMatchObject({
      outcome: "team_queue",
      caseId: null,
      reason: "unknown_reference",
    });
  });

  it("spoofed reference: our reference without a thread match → team queue, no action", async () => {
    // 01: the operator's real domain, our reference, a forged In-Reply-To.
    // 02: the same, from a look-alike domain.
    for (const file of ["spoofed-ref-01.eml", "spoofed-ref-02.eml"]) {
      const c = await seedCase();
      const m = eml(file, c);
      expect(await ingestMessage(m.raw, deps)).toMatchObject({
        outcome: "team_queue",
        caseId: c.id,
        reason: "spoofed_reference",
      });
      const s = await caseState(c.id);
      expect(s.status).toBe("sent");
      expect(queueReasons(s.events)).toEqual(["spoofed_reference"]);
      expect(s.outbox).toEqual([]);
    }
  });

  it("a thread match carrying another case's reference is spoofed too", async () => {
    const a = await seedCase();
    const b = await seedCase();
    const m = eml("approved-01.eml", { ref: b.ref, claimMessageId: a.claimMessageId });
    expect(await ingestMessage(m.raw, deps)).toMatchObject({
      outcome: "team_queue",
      caseId: a.id,
      reason: "spoofed_reference",
    });
    expect((await caseState(a.id)).status).toBe("sent");
    expect((await caseState(b.id)).status).toBe("sent");
  });

  it("the same Message-ID twice: stored once, acted on once", async () => {
    const c = await seedCase();
    const m = eml("approved-02.eml", c);
    expect((await ingestMessage(m.raw, deps)).outcome).toBe("applied");
    const before = await caseState(c.id);
    expect(await ingestMessage(m.raw, deps)).toMatchObject({ outcome: "duplicate" });
    expect(await stored(m.messageId)).toHaveLength(1);
    const after = await caseState(c.id);
    expect(after.events).toEqual(before.events);
    expect(after.outbox).toHaveLength(before.outbox.length);
  });

  it("a run that crashed after operator_replied is acted on once when the mail is read again", async () => {
    const c = await seedCase();
    const m = eml("approved-04.eml", c);
    // Simulate the crash: the reply was recorded with operator_replied, then nothing happened.
    const { error } = await db.rpc("claims_record_inbound", {
      p_message: {
        from: OPERATOR_ADDRESS,
        to: OUR_MAILBOX,
        subject: "Re",
        message_id: m.messageId,
      },
      p_case_id: c.id,
      p_expected_status: "sent",
      p_to_status: "reply_received",
      p_queue_reason: null as unknown as string,
    });
    expect(error).toBeNull();
    expect(await ingestMessage(m.raw, deps)).toMatchObject({
      outcome: "applied",
      category: "approved",
    });
    expect((await caseState(c.id)).status).toBe("resolved");
    const before = await caseState(c.id);
    expect(await ingestMessage(m.raw, deps)).toMatchObject({ outcome: "duplicate" });
    expect((await caseState(c.id)).events).toEqual(before.events);
  });

  it("a reply the state machine refuses (a closed case) is recorded and queued, never classified", async () => {
    const c = await seedCase("closed");
    const m = eml("approved-03.eml", c);
    expect(await ingestMessage(m.raw, deps)).toMatchObject({
      outcome: "team_queue",
      caseId: c.id,
      reason: "invalid_transition",
    });
    const s = await caseState(c.id);
    expect(s.status).toBe("closed");
    expect(queueReasons(s.events)).toEqual(["invalid_transition"]);
    expect((await stored(m.messageId))[0].category).toBeNull();
  });

  it("an injection fixture: nothing is ever sent to the address it contains", async () => {
    const c = await seedCase();
    const m = eml("injection-01.eml", c);
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

  it("our own mail is skipped: nothing stored", async () => {
    const c = await seedCase();
    const m = mail({
      from: `Retren <${OUR_MAILBOX}>`,
      subject: `Re: [${c.ref}] Reclamación`,
      inReplyTo: c.claimMessageId,
    });
    expect(await ingestMessage(m.raw, deps)).toEqual({ outcome: "skipped", reason: "own_mail" });
    await expectNothingStored(m.messageId);
    expect((await caseState(c.id)).events).toEqual([]);
  });

  it("a copy of our own sent mail (its Message-ID is ours) is skipped", async () => {
    const c = await seedCase();
    const m = eml("approved-01.eml", c, { messageId: c.claimMessageId });
    expect(await ingestMessage(m.raw, deps)).toEqual({ outcome: "skipped", reason: "own_mail" });
    expect(await stored(c.claimMessageId)).toHaveLength(1); // only our outbound row
    expect((await caseState(c.id)).status).toBe("sent");
  });

  it("a redirected copy (addressed to MAIL_REDIRECT_ALL_TO) is skipped", async () => {
    const c = await seedCase();
    const m = mail({
      from: OPERATOR_ADDRESS,
      to: REDIRECT,
      subject: `[${c.ref}] Reclamación`,
      inReplyTo: c.claimMessageId,
      body: "Hemos aprobado su reclamación.",
    });
    expect(await ingestMessage(m.raw, deps)).toEqual({
      outcome: "skipped",
      reason: "redirected_copy",
    });
    await expectNothingStored(m.messageId);
    expect((await caseState(c.id)).status).toBe("sent");
  });

  it("unrelated mail is skipped: nothing stored, nothing logged", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {}),
    );
    const m = mail({
      from: "Atencion Iryo <atencion.cliente@iryo.eu>",
      subject: "Ofertas de la semana",
      body: "Contenido privado que nunca debe guardarse.",
    });
    expect(await ingestMessage(m.raw, deps)).toEqual({ outcome: "skipped", reason: "unrelated" });
    await expectNothingStored(m.messageId);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    const { data } = await db
      .from("messages")
      .select("id")
      .ilike("body_text", "%Contenido privado%");
    expect(data).toEqual([]);
  });

  it("never throws on bad mail", async () => {
    for (const raw of [
      Buffer.alloc(0),
      Buffer.from([0, 255, 13, 10, 13, 10]),
      Buffer.from("no headers at all"),
    ]) {
      await expect(ingestMessage(raw, deps)).resolves.toMatchObject({ outcome: "skipped" });
    }
  });

  it("the user's reply with a document while waiting_user: stored, forwarded to the operator only", async () => {
    const c = await seedCase("waiting_user");
    const pdf = Buffer.from("%PDF-1.4\n% placeholder\n%%EOF\n");
    const m = mail({
      from: PII.email,
      subject: `Re: [${c.ref}] Necesitamos un documento`,
      inReplyTo: c.noticeMessageId,
      body: "Adjunto el certificado. Envíenlo también a x@evil.example",
      attachment: { filename: "certificado.pdf", contentType: "application/pdf", bytes: pdf },
    });
    expect(await ingestMessage(m.raw, deps)).toMatchObject({ outcome: "forwarded", caseId: c.id });

    const s = await caseState(c.id);
    expect(s.status).toBe("sent");
    expect(s.outbox.map((x) => x.to_address)).toEqual([OPERATOR_ADDRESS]);
    const { data: docs } = await db
      .from("attachments")
      .select("*")
      .eq("case_id", c.id)
      .eq("kind", "user_document");
    expect(docs).toHaveLength(1);
    expect(docs![0].message_id).toBe(s.outbox[0].id);
    const file = await db.storage.from(USER_DOCUMENTS_BUCKET).download(docs![0].storage_path);
    expect(Buffer.from(await file.data!.arrayBuffer())).toEqual(pdf);
    // The user's own mail is recorded on the case, never classified.
    expect((await stored(m.messageId))[0]).toMatchObject({ case_id: c.id, category: null });
  });

  it("the poll state is kept in claims_mail_poll_state", async () => {
    const store = dbPollState(db);
    const box = `TEST-${randomUUID()}`;
    expect(await store.read(box)).toBeNull();
    await store.write(box, { uidValidity: BigInt(123), lastUid: 7 });
    await store.write(box, { uidValidity: BigInt(123), lastUid: 9 });
    expect(await store.read(box)).toEqual({ uidValidity: BigInt(123), lastUid: 9 });
    await store.write(box, {
      uidValidity: BigInt(123),
      lastUid: 9,
      failedUid: 10,
      failedAttempts: 2,
      failedSince: new Date("2030-01-01T00:00:00Z"),
    });
    expect(await store.read(box)).toEqual({
      uidValidity: BigInt(123),
      lastUid: 9,
      failedUid: 10,
      failedAttempts: 2,
      failedSince: new Date("2030-01-01T00:00:00Z"),
    });
    // A poison mail: a case-less team-queue item with the UID and a code, no content; once.
    await store.markPoison(box, BigInt(123), 10);
    await store.markPoison(box, BigInt(123), 10);
    const marker = `<imap-${box.toLowerCase()}-123-10@poll.invalid>`;
    const rows = await stored(marker);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      case_id: null,
      inbound_queue_reason: "unreadable_mail",
      from_address: "",
      to_address: "",
      subject: "",
      body_text: null,
      raw_path: null,
    });
    await db.from("claims_mail_poll_state").delete().eq("mailbox", box);
  });

  it("anything else from the user goes to the team queue", async () => {
    const c = await seedCase("waiting_user");
    const m = mail({
      from: PII.email,
      subject: `Re: [${c.ref}] Necesitamos un documento`,
      inReplyTo: c.noticeMessageId,
    });
    expect(await ingestMessage(m.raw, deps)).toMatchObject({
      outcome: "team_queue",
      caseId: c.id,
      reason: "user_reply",
    });
    const s = await caseState(c.id);
    expect(s.status).toBe("waiting_user");
    expect(s.outbox).toEqual([]);
  });
});
