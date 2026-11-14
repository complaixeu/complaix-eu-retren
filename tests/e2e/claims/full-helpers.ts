// Server-side setup and read-back for the full product e2e (docs/plans/C-claims.md C10). Runs in
// the Playwright worker (Node), never in the browser. It seeds a case only through domain C's
// real code (createCase, then sendInitialClaim, so the initial claim is genuinely `sent`), plays
// the user's reply through the real inbound path (ingestMessage), and reads one case's rows back.
// Every read is scoped to one case id: the local database is shared with every other test.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { createCase } from "@/features/claims";
import { USER_DOCUMENTS_BUCKET } from "@/features/claims/actions";
import { ingestMessage, type IngestResult } from "@/features/claims/inbound";
import { TICKET_BUCKET, sendInitialClaim } from "@/features/claims/initial-claim";
import { scriptedReply } from "@/features/claims/team";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { submissionFixture } from "../../fixtures/claims/submission";
import { TICKET_PLACEHOLDER_PNG } from "../../fixtures/claims/ticket";
import { testAppEnv } from "../../support/local-supabase";

/** The operator's verified address (rules config for iryo). */
export const OPERATOR_ADDRESS = "atencion.cliente@iryo.eu";
export const PASSWORD = `pw-${randomUUID()}`;
const DAY = 86_400_000;

let client: ServiceClient | undefined;

/** The same env as the app under test (local Supabase, fake mail and classifier, demo mode). */
export function db(): ServiceClient {
  if (!client) {
    for (const [k, v] of Object.entries(testAppEnv(0))) process.env[k] ??= v;
    // The fake transport is the only one this process may ever build.
    process.env.MAIL_PROVIDER = "fake";
    process.env.LLM_PROVIDER = "fake";
    client = createServiceClient();
  }
  return client;
}

/** A team member who can sign in to /equipo. Removed by `removeTeamMember`. */
export async function createTeamMember(): Promise<string> {
  const email = `equipo.c10.${randomUUID().slice(0, 8)}@retren.test`;
  const { error } = await db().auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  const added = await db().from("team_members").insert({ email });
  if (added.error) throw added.error;
  return email;
}

export async function removeTeamMember(email: string): Promise<void> {
  await db().from("team_members").delete().eq("email", email);
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * An eligible iryo case whose initial claim was sent now, through the real code: the ticket is
 * stored, createCase evaluates the (fixture) submission with B's rules, and sendInitialClaim
 * builds the documents and sends through the fake transport.
 */
export async function seedSentCase(): Promise<{ id: string; ref: string; userEmail: string }> {
  const sb = db();
  const bucket = await sb.storage.getBucket(TICKET_BUCKET);
  if (!bucket.data) {
    const made = await sb.storage.createBucket(TICKET_BUCKET, { public: false });
    if (made.error && !/already exists/i.test(made.error.message)) throw made.error;
  }
  const ticketPath = `test-c10/${randomUUID()}.png`;
  const up = await sb.storage
    .from(TICKET_BUCKET)
    .upload(ticketPath, TICKET_PLACEHOLDER_PNG, { contentType: "image/png" });
  if (up.error) throw up.error;

  // The trip was 5 days ago, 90 minutes late: past iryo's minimum wait, inside its deadline.
  const now = Date.now();
  const travelDate = isoDate(now - 5 * DAY);
  const base = submissionFixture(90);
  const submission = submissionFixture(90, {
    draftId: `draft-c10-${randomUUID()}`,
    ticketPath,
    ticket: { ...base.ticket, travelDate, purchaseDate: isoDate(now - 20 * DAY) },
    answers: { ...base.answers, actualArrival: { date: travelDate, time: "13:30" } },
    consent: { ...base.consent, acceptedAt: new Date(now - 4 * DAY).toISOString() },
  });

  const created = await createCase(submission, { db: sb });
  expect(created.status).toBe("waiting_period");

  const sent = await sendInitialClaim(created.caseId, { db: sb });
  expect(sent).toMatchObject({ ok: true, delivery: { status: "sent" } });

  const { data, error } = await sb
    .from("cases")
    .select("status, user_email")
    .eq("id", created.caseId)
    .single();
  if (error) throw error;
  expect(data.status).toBe("sent");
  return { id: created.caseId, ref: created.publicRef, userEmail: data.user_email };
}

/** One case's rows: the case, its messages, its attachments. */
export async function caseRows(caseId: string) {
  const sb = db();
  const [c, m, a] = await Promise.all([
    sb
      .from("cases")
      .select("id, status, send_count, user_email, sent_at")
      .eq("id", caseId)
      .single(),
    sb
      .from("messages")
      .select(
        "id, direction, template, category, status, from_address, to_address, delivered_to, message_id, body_text, created_at",
      )
      .eq("case_id", caseId)
      .order("created_at", { ascending: true }),
    sb
      .from("attachments")
      .select("id, kind, message_id, storage_path, content_type, deleted_at")
      .eq("case_id", caseId),
  ]);
  if (c.error || m.error || a.error) throw c.error ?? m.error ?? a.error;
  return { case: c.data, messages: m.data, attachments: a.data };
}

/** Whether a user document is still in its private bucket. */
export async function userDocumentExists(storagePath: string): Promise<boolean> {
  const { data } = await db().storage.from(USER_DOCUMENTS_BUCKET).download(storagePath);
  return data !== null;
}

const USER_REPLY = path.join(process.cwd(), "tests/fixtures/claims/user-reply/document-01.eml");

/**
 * The case user answers our document request with one PDF: the fixture is threaded onto the
 * `user_request_document` notice we sent them and goes through the real inbound path, as the
 * IMAP poller would hand it over.
 */
export async function userRepliesWithDocument(caseId: string): Promise<IngestResult> {
  const { messages, case: c } = await caseRows(caseId);
  const notice = messages.find(
    (m) =>
      m.direction === "outbound" &&
      m.template === "user_request_document" &&
      m.status === "sent" &&
      m.to_address.toLowerCase() === c.user_email.toLowerCase(),
  );
  if (!notice?.message_id) throw new Error("the document request was not sent to the user yet");
  const ref = await db().from("cases").select("public_ref").eq("id", caseId).single();
  if (ref.error) throw ref.error;
  const raw = scriptedReply(readFileSync(USER_REPLY, "utf8"), {
    fixture: "user-document-01",
    publicRef: ref.data.public_ref,
    initialMessageId: notice.message_id,
    messageId: `<user-reply-${randomUUID()}@mail.example>`,
  });
  return ingestMessage(raw, { db: db() });
}

// ---------------------------------------------------------------------------------------------
// The team view, driven by roles and labels only.

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/equipo");
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByLabel("Contraseña").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Cola del equipo" })).toBeVisible();
}

export async function openCase(page: Page, c: { id: string; ref: string }): Promise<void> {
  await page.goto(`/equipo/casos/${c.id}`);
  await expect(page.getByRole("heading", { level: 1, name: `Caso ${c.ref}` })).toBeVisible();
}

export const summary = (page: Page) => page.getByRole("region", { name: "Resumen" });
export const messagesOf = (page: Page) => page.getByRole("region", { name: "Mensajes" });
export const historyOf = (page: Page) => page.getByRole("region", { name: "Historial" });
export const pendingOf = (page: Page) => page.getByRole("region", { name: "Pendiente de revisar" });

/** The case status, by its code in the summary ("Estado"). */
export async function expectStatus(page: Page, code: string): Promise<void> {
  await expect(summary(page).getByText(code, { exact: true })).toBeVisible();
}

/** One message of the "Mensajes" list, by its template or category code. */
export const messageItem = (page: Page, kind: string) =>
  messagesOf(page)
    .getByRole("listitem")
    .filter({ has: page.getByText(kind, { exact: true }) });

/** Reloads the case page without the last action's notice, so the next notice is this action's. */
async function freshCasePage(page: Page): Promise<void> {
  const url = new URL(page.url());
  url.search = "";
  await page.goto(url.toString());
  await expect(page.getByRole("status")).toHaveCount(0);
}

export async function inject(page: Page, label: string, notice: RegExp | string): Promise<void> {
  await freshCasePage(page);
  await page.getByLabel("Respuesta guionizada").selectOption({ label });
  await page.getByRole("button", { name: "Inyectar respuesta" }).click();
  await expect(page.getByRole("status")).toContainText(notice);
}

export async function advanceClock(page: Page, days: number): Promise<void> {
  await freshCasePage(page);
  await page.getByLabel("Días a adelantar").fill(String(days));
  await page.getByRole("button", { name: "Adelantar el reloj" }).click();
  await expect(page.getByRole("status")).toContainText("Reloj adelantado");
}
