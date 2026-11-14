import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { localSupabase } from "../../support/local-supabase";

// [C9] The team view (/equipo): the login gate, injecting a scripted operator reply that goes
// through the real inbound path, and moving the demo clock. Roles and labels only
// (docs/plans/README.md §3). Fake mail and classifier, local Supabase, DEMO_MODE=1.
//
// Serial: moving the clock runs the tick for every case in the database.
test.describe.configure({ mode: "serial" });

const OPERATOR_ADDRESS = "atencion.cliente@iryo.eu";
const PASSWORD = `pw-${randomUUID()}`;
const DAY = 86_400_000;

let admin: SupabaseClient;
let member: string;
let outsider: string;

test.beforeAll(async () => {
  const sb = localSupabase();
  admin = createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false } });
  const tag = randomUUID().slice(0, 8);
  member = `equipo.${tag}@retren.test`;
  outsider = `fuera.${tag}@retren.test`;
  for (const email of [member, outsider]) {
    const { error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw error;
  }
  const { error } = await admin.from("team_members").insert({ email: member });
  if (error) throw error;
});

test.afterAll(async () => {
  await admin.from("team_members").delete().eq("email", member);
});

/** An iryo case whose initial claim went out today, so it is waiting for the operator. */
async function seedSentCase(): Promise<{ id: string; ref: string }> {
  const ref = `RTN-${randomUUID().slice(0, 8).toUpperCase()}`;
  const sentAt = new Date().toISOString();
  const { data, error } = await admin
    .from("cases")
    .insert({
      public_ref: ref,
      operator: "iryo",
      status: "sent",
      submission: {},
      user_email: "viajero.prueba@example.test",
      sent_at: sentAt,
      next_action_at: sentAt,
      send_count: 1,
    })
    .select("id")
    .single();
  if (error) throw error;
  const { error: e } = await admin.from("messages").insert({
    case_id: data.id,
    direction: "outbound",
    from_address: "reclamaciones@retren.invalid",
    to_address: OPERATOR_ADDRESS,
    subject: `[${ref}] Reclamación`,
    message_id: `<${randomUUID()}@retren.example>`,
    status: "sent",
    template: "initial_claim",
    body_text: "initial claim",
    created_at: sentAt,
  });
  if (e) throw e;
  return { id: data.id, ref };
}

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/equipo");
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

const heading = (page: Page, name: string) => page.getByRole("heading", { level: 1, name });
const messages = (page: Page) => page.getByRole("region", { name: "Mensajes" });

test("the login gate: nothing is shown without a team session", async ({ page }) => {
  await page.goto("/equipo");
  await expect(page).toHaveURL(/\/equipo\/entrar$/);
  await expect(heading(page, "Acceso del equipo")).toBeVisible();

  const { ref, id } = await seedSentCase();
  await page.goto(`/equipo/casos/${id}`);
  await expect(page).toHaveURL(/\/equipo\/entrar$/);
  await expect(page.getByText(ref)).toHaveCount(0);

  // A wrong password, and a user who is not on the allowlist, get the same refusal.
  await signIn(page, member, "wrong-password");
  await expect(page.getByRole("alert").filter({ hasText: "Correo o contraseña" })).toBeVisible();
  await signIn(page, outsider);
  await expect(page.getByRole("alert").filter({ hasText: "Correo o contraseña" })).toBeVisible();
  await expect(heading(page, "Cola del equipo")).toHaveCount(0);

  await signIn(page, member);
  await expect(heading(page, "Cola del equipo")).toBeVisible();
  await expect(page.getByRole("link", { name: ref })).toBeVisible();

  await page.getByRole("button", { name: "Cerrar sesión" }).click();
  await expect(page).toHaveURL(/\/equipo\/entrar$/);
  await page.goto("/equipo");
  await expect(heading(page, "Acceso del equipo")).toBeVisible();
});

test("an operator reply that asks for the IBAN moves the case to waiting_user and queues the notice", async ({
  page,
}) => {
  const { ref } = await seedSentCase();
  await signIn(page, member);
  await page.getByRole("link", { name: ref }).click();
  await expect(heading(page, `Caso ${ref}`)).toBeVisible();

  await page.getByLabel("Respuesta guionizada").selectOption({ label: "Pide datos (IBAN) (01)" });
  await page.getByRole("button", { name: "Inyectar respuesta" }).click();

  await expect(page.getByRole("status")).toContainText("el caso ha cambiado de estado");
  const summary = page.getByRole("region", { name: "Resumen" });
  await expect(summary).toContainText("Esperando al usuario");
  // The operator's mail, classified, and the notice to the user waiting in the outbox.
  await expect(messages(page)).toContainText("asks_for_data");
  await expect(messages(page)).toContainText("user_request_document");
  await expect(messages(page)).toContainText("queued");
  // Operator mail is shown as plain text.
  await expect(messages(page).getByText("facilite el IBAN")).toBeVisible();
});

test("moving the clock to day 30 queues and sends a reminder, for the case viewed only", async ({
  page,
}) => {
  const other = await seedSentCase();
  const { ref } = await seedSentCase();
  await signIn(page, member);
  await page.getByRole("link", { name: ref }).click();
  await expect(messages(page)).not.toContainText("reminder_");

  await page.getByLabel("Días a adelantar").fill("30");
  await page.getByRole("button", { name: "Adelantar el reloj" }).click();
  await expect(page.getByRole("status")).toContainText("Reloj adelantado");

  await expect(messages(page)).toContainText("reminder_d30");
  await expect(messages(page)).toContainText("sent");

  // Another case, equally due, was not touched.
  await page.goto(`/equipo/casos/${other.id}`);
  await expect(heading(page, `Caso ${other.ref}`)).toBeVisible();
  await expect(messages(page)).not.toContainText("reminder_");

  // The demo clock belongs to this session and is shown on the case page.
  const expected = new Date(Date.now() + 30 * DAY).toLocaleDateString("es-ES", {
    dateStyle: "long",
    timeZone: "Europe/Madrid",
  });
  await expect(page.getByRole("region", { name: "Reloj de demostración" })).toContainText(expected);
});

test("a queue item can be resolved and then is no longer listed", async ({ page }) => {
  const { id, ref } = await seedSentCase();
  const { error } = await admin
    .from("case_events")
    .insert({ case_id: id, kind: "team_queue", data: { reason: "wrong_sender" } });
  if (error) throw error;

  await signIn(page, member);
  const queue = page.getByRole("region", { name: "Pendiente de revisar" });
  await expect(queue).toContainText("wrong_sender");
  await page.getByRole("button", { name: new RegExp(`Marcar como resuelto: ${ref}`) }).click();
  await expect(page.getByRole("status")).toContainText("marcado como resuelto");
  await expect(queue.getByRole("link", { name: ref })).toHaveCount(0);
});
