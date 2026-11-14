import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/claims/tick/route";
import { createCase } from "@/features/claims";
import { TICKET_BUCKET } from "@/features/claims/initial-claim";
import { fixedClock } from "@/shared/clock";
import { createServiceClient } from "@/shared/supabase/server";
import { submissionFixture } from "../../fixtures/claims/submission";
import { waitForDb } from "../../fixtures/claims/db-ready";
import { TICKET_PLACEHOLDER_PNG } from "../../fixtures/claims/ticket";

// The tick sends what is due (C3 wiring for C10's "eligible → tick → claim sent"): after the
// timer actions it sends the initial claim of every waiting_period case past earliest_send_at,
// then every queued row. Fake transport (MAIL_PROVIDER=fake), never the network.
const db = createServiceClient();
const SECRET = "test-tick-secret-c3-0123456789abcdef";
// submissionFixture(90): earliest_send_at is 2026-01-17T12:30Z (rules mock, 48 h).
const NOW = "2026-01-18T09:00:00.000Z";

const tick = () =>
  POST(
    new Request("http://localhost/api/claims/tick", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ now: NOW }),
    }),
  );

type Body = {
  outbound: {
    initialClaims: { caseId: string; ok: boolean; reason?: string }[];
    sent: { messageId: string; status: string; reason?: string }[];
  };
};

const saved = { TICK_SECRET: process.env.TICK_SECRET, DEMO_MODE: process.env.DEMO_MODE };
beforeAll(async () => {
  process.env.TICK_SECRET = SECRET;
  process.env.DEMO_MODE = "1";
  await waitForDb(db);
  const { data } = await db.storage.getBucket(TICKET_BUCKET);
  if (!data) {
    const { error } = await db.storage.createBucket(TICKET_BUCKET, { public: false });
    if (error && !/already exists/i.test(error.message)) throw error;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function readyCase(): Promise<string> {
  const ticketPath = `test-c3-tick/${randomUUID()}.png`;
  const up = await db.storage
    .from(TICKET_BUCKET)
    .upload(ticketPath, TICKET_PLACEHOLDER_PNG, { contentType: "image/png" });
  if (up.error) throw up.error;
  const out = await createCase(submissionFixture(90, { ticketPath }), {
    clock: fixedClock("2026-01-16T10:00:00.000Z"),
  });
  expect(out.status).toBe("waiting_period");
  return out.caseId;
}

async function state(caseId: string) {
  const [c, m] = await Promise.all([
    db.from("cases").select("*").eq("id", caseId).single(),
    db.from("messages").select("*").eq("case_id", caseId),
  ]);
  if (c.error || m.error) throw c.error ?? m.error;
  return { row: c.data, messages: m.data };
}

describe("POST /api/claims/tick: outbound", () => {
  it("sends the initial claim of a ready case; a second tick sends nothing new", async () => {
    const caseId = await readyCase();

    const first = await tick();
    expect(first.status).toBe(200);
    const body = (await first.json()) as Body;
    expect(body.outbound.initialClaims).toContainEqual({ caseId, ok: true });

    const after = await state(caseId);
    expect(after.row).toMatchObject({ status: "sent", send_count: 1 });
    expect(Date.parse(after.row.sent_at!)).toBe(Date.parse(NOW));
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]).toMatchObject({ template: "initial_claim", status: "sent" });
    expect(body.outbound.sent.map((s) => s.messageId)).not.toContain(after.messages[0].id);

    const second = await tick();
    expect(second.status).toBe(200);
    const body2 = (await second.json()) as Body;
    expect(body2.outbound.initialClaims.map((r) => r.caseId)).not.toContain(caseId);
    const again = await state(caseId);
    expect(again.row).toMatchObject({ status: "sent", send_count: 1 });
    expect(again.messages).toHaveLength(1);
    expect(again.messages[0].provider_id).toBe(after.messages[0].provider_id);
  });

  it("an inactive operator is refused once and not retried every tick", async () => {
    const ticketPath = `test-c3-tick/${randomUUID()}.png`;
    await db.storage
      .from(TICKET_BUCKET)
      .upload(ticketPath, TICKET_PLACEHOLDER_PNG, { contentType: "image/png" });
    const base = submissionFixture(90);
    const out = await createCase(
      submissionFixture(90, { ticketPath, ticket: { ...base.ticket, operator: "renfe" } }),
      { clock: fixedClock("2026-01-16T10:00:00.000Z") },
    );
    const body = (await (await tick()).json()) as Body;
    expect(body.outbound.initialClaims).toContainEqual({
      caseId: out.caseId,
      ok: false,
      reason: "operator_inactive",
    });
    const body2 = (await (await tick()).json()) as Body;
    expect(body2.outbound.initialClaims.map((r) => r.caseId)).not.toContain(out.caseId);
    expect((await state(out.caseId)).messages).toEqual([]);
  });

  it("then sends what the timers queued (a C7-style row)", async () => {
    const caseId = await readyCase();
    await tick();
    const { row } = await state(caseId);
    const queued = await db
      .from("messages")
      .insert({
        case_id: caseId,
        direction: "outbound",
        from_address: "reclamaciones@retren.invalid",
        to_address: "atencion.cliente@iryo.eu",
        subject: `[${row.public_ref}] Recordatorio`,
        body_text: "Recordatorio.",
        status: "queued",
      })
      .select("id")
      .single();
    if (queued.error) throw queued.error;

    const body = (await (await tick()).json()) as Body;
    expect(body.outbound.sent).toContainEqual({ messageId: queued.data.id, status: "sent" });
    const m = await db.from("messages").select("status").eq("id", queued.data.id).single();
    expect(m.data?.status).toBe("sent");
  });
});
