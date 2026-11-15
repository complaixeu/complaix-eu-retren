import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEMO_FIXTURES } from "@/features/claims/demo-fixtures";
import {
  TeamActionError,
  checkInboxNow,
  injectOperatorReply,
  runDemoTick,
  scriptedReply,
} from "@/features/claims/team";
import { createFakeTransport } from "@/features/claims/transport";
import { getOperatorConfig } from "@/features/rules";
import type { CaseStatus } from "@/shared/contracts";
import type { Json } from "@/shared/supabase";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { FakeImap, memoryState } from "../../fixtures/claims/fake-imap";
import { PII, submissionFixture } from "../../fixtures/claims/submission";
import { waitForDb } from "../../fixtures/claims/db-ready";

// [C9] Real mail on DEV, proven without a network: gmail with a redirect outside production. The
// clock and "Check inbox now" are allowed, and every mail goes to the redirected inbox through an
// injected fake transport. Simulated replies are refused (the real mailbox answers). The IMAP
// source is FakeImap (tests/fixtures/claims/fake-imap.ts), read-only and in memory.
const db: ServiceClient = createServiceClient();
const DAY = 86_400_000;
const REDIRECT = "team@example.com";
const REAL = {
  DEMO_MODE: "1",
  MAIL_PROVIDER: "gmail",
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "465",
  SMTP_SECURE: "true",
  SMTP_USER: "retren@example.com",
  SMTP_PASS: "not-a-real-password",
  IMAP_HOST: "imap.example.test",
  IMAP_PORT: "993",
  IMAP_SECURE: "true",
  MAIL_REDIRECT_ALL_TO: REDIRECT,
};
const OPERATOR_ADDRESS = (() => {
  const ch = getOperatorConfig("iryo").channel;
  if (ch.type !== "email") throw new Error("the iryo config must have an email channel");
  return ch.address;
})();

const seeded: string[] = [];
beforeAll(async () => {
  await waitForDb(db);
});
// Other files send at most a fixed number of queued rows per tick: leave none of ours queued.
afterAll(async () => {
  if (seeded.length === 0) return;
  const { error } = await db
    .from("messages")
    .update({ status: "failed", failure_reason: "test_cleanup" })
    .in("case_id", seeded)
    .eq("status", "queued");
  if (error) throw error;
});

/** An iryo case whose initial claim went out `sentDaysAgo` days ago. */
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

const later = (days: number) => new Date(Date.now() + days * DAY + 3_600_000);

describe("the clock with real mail (gmail, redirected)", () => {
  it("sends the due mail through the injected transport, to the redirect only", async () => {
    const c = await seedCase("sent", 0);
    const transport = createFakeTransport();
    const out = await runDemoTick(db, later(30), c.id, REAL, { transport });
    expect(out.timerActions).toBeGreaterThanOrEqual(1);

    expect(transport.outbox.length).toBeGreaterThan(0);
    for (const mail of transport.outbox) expect(mail.to).toEqual([REDIRECT]);

    const rows = await db
      .from("messages")
      .select("template, status")
      .eq("case_id", c.id)
      .eq("direction", "outbound");
    expect(rows.data?.find((r) => r.template === "reminder_d30")?.status).toBe("sent");
  });

  it("is refused in production, even with the redirect, and sends nothing", async () => {
    const c = await seedCase("sent", 0);
    const transport = createFakeTransport();
    await expect(
      runDemoTick(db, later(30), c.id, { ...REAL, RETREN_ENV: "production" }, { transport }),
    ).rejects.toMatchObject({ code: "demo_only" });
    expect(transport.outbox).toEqual([]);
  });

  it("is refused without a redirect: nothing is queued or sent", async () => {
    const c = await seedCase("sent", 0);
    const noRedirect = { ...REAL, MAIL_REDIRECT_ALL_TO: undefined };
    const transport = createFakeTransport();
    const before = await db.from("messages").select("id").eq("case_id", c.id);
    await expect(runDemoTick(db, later(30), c.id, noRedirect, { transport })).rejects.toMatchObject(
      { code: "demo_only" },
    );
    const after = await db.from("messages").select("id").eq("case_id", c.id);
    expect(after.data?.length).toBe(before.data?.length);
    expect(transport.outbox).toEqual([]);
  });

  it("the simulated reply is refused with real mail, and nothing is ingested", async () => {
    const c = await seedCase();
    const ingest = vi.fn(async () => ({ outcome: "applied" }));
    await expect(
      injectOperatorReply(db, { caseId: c.id, fixture: "approved-01" }, { ingest, env: REAL }),
    ).rejects.toMatchObject({ code: "demo_only" });
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe("Check inbox now", () => {
  it("reads a reply from the mailbox read-only, stores it, and runs the tick for that case", async () => {
    const c = await seedCase("sent", 1);
    // The golden "asks for the IBAN" reply, threaded onto this case's initial claim.
    const raw = scriptedReply(DEMO_FIXTURES.iryo!["asks_for_data-01"]!, {
      fixture: "asks_for_data-01",
      publicRef: c.ref,
      initialMessageId: c.claimMessageId,
      messageId: `<reply-${randomUUID()}@mail.example>`,
    });
    const mailbox = new FakeImap([
      { uid: 1, subject: `Re: Reclamacion [${c.ref}]`, from: "atencion.cliente@iryo.eu", raw },
    ]);
    const transport = createFakeTransport();

    const out = await checkInboxNow(db, new Date(), c.id, {
      env: REAL,
      client: mailbox,
      state: memoryState({ uidValidity: BigInt(1), lastUid: 0 }),
      transport,
    });

    expect(out.processed).toBe(1);
    expect(mailbox.opened).toEqual([{ path: "INBOX", readOnly: true }]);
    expect(mailbox.mutations).toEqual([]);

    const inbound = await db
      .from("messages")
      .select("category")
      .eq("case_id", c.id)
      .eq("direction", "inbound");
    expect(inbound.data?.map((m) => m.category)).toEqual(["asks_for_data"]);

    // The tick for this case sent the notice the reply queued, to the redirect only.
    expect(transport.outbox.length).toBeGreaterThan(0);
    for (const mail of transport.outbox) expect(mail.to).toEqual([REDIRECT]);
  });

  it("is refused with the fake mail, and the mailbox is never opened", async () => {
    const c = await seedCase();
    const mailbox = new FakeImap([]);
    await expect(
      checkInboxNow(db, new Date(), c.id, {
        env: { DEMO_MODE: "1", MAIL_PROVIDER: "fake" },
        client: mailbox,
        state: memoryState(),
      }),
    ).rejects.toMatchObject({ code: "demo_only" });
    expect(mailbox.calls).toEqual([]);
  });

  it("answers incomplete mail settings with a code, and never opens the mailbox", async () => {
    const c = await seedCase();
    const mailbox = new FakeImap([]);
    const incomplete = { ...REAL, IMAP_HOST: undefined };
    await expect(
      checkInboxNow(db, new Date(), c.id, {
        env: incomplete,
        client: mailbox,
        state: memoryState(),
      }),
    ).rejects.toMatchObject({ code: "mail_config" });
    await expect(
      checkInboxNow(db, new Date(), c.id, {
        env: { ...REAL, MAIL_OPERATOR_INBOXES: "iryo:not-an-address" },
        client: mailbox,
        state: memoryState(),
      }),
    ).rejects.toMatchObject({ code: "mail_config" });
    expect(mailbox.calls).toEqual([]);
  });

  it("answers a mailbox that cannot be read with a generic code, never the error text", async () => {
    const c = await seedCase();
    const mailbox = new FakeImap([]);
    mailbox.mailboxOpen = async () => {
      throw new Error("login failed for retren@example.com");
    };
    const err: unknown = await checkInboxNow(db, new Date(), c.id, {
      env: REAL,
      client: mailbox,
      state: memoryState(),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamActionError);
    expect((err as TeamActionError).code).toBe("inbound_failed");
    expect(String(err)).not.toContain("retren@example.com");
  });
});
