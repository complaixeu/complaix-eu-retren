import { createClient } from "@supabase/supabase-js";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import type { TicketData } from "@/shared/contracts";
import { PLACEHOLDER_PDF } from "../../fixtures/intake/tickets";
import { localSupabase } from "../../support/local-supabase";

/**
 * Helpers for the intake specs that need a draft. The draft is made the way a user makes it (the
 * upload step); what a later step reads from it (the extraction, until A3 writes it) is seeded
 * straight into the local database with the service key, never through the app.
 */

/** Uploads a placeholder PDF on the first step, so the browser has a current draft. */
export async function uploadPlaceholderTicket(page: Page) {
  await page.goto("/reclamar/foto");
  await page.getByLabel("Foto o PDF del billete").setInputFiles({
    name: "billete.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(PLACEHOLDER_PDF),
  });
  await page.getByRole("button", { name: "Subir billete" }).click();
  await expect(page.getByRole("region", { name: "Tu billete" })).toBeVisible();
}

async function draftId(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find((c) => c.name === "retren_draft");
  if (!cookie) throw new Error("no draft cookie: upload a ticket first");
  return cookie.value;
}

function serviceDb() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false } });
}

/** Replaces the current draft's `data` (top-level keys) with `data`. */
export async function seedDraftData(context: BrowserContext, data: Record<string, unknown>) {
  const { error } = await serviceDb()
    .from("intake_drafts")
    .update({ data })
    .eq("id", await draftId(context));
  if (error) throw new Error(`seeding the draft failed: ${error.message}`);
}

/** The current draft's `data`, as stored. */
export async function draftData(context: BrowserContext): Promise<Record<string, unknown>> {
  const { data, error } = await serviceDb()
    .from("intake_drafts")
    .select("data")
    .eq("id", await draftId(context))
    .single();
  if (error) throw new Error(`reading the draft failed: ${error.message}`);
  return (data?.data ?? {}) as Record<string, unknown>;
}

/** A complete, valid review, typed into the review step's form. */
export const reviewValues = {
  operator: "Iryo",
  travelDate: "2026-03-12",
  origin: "Estación Uno",
  destination: "Estación Dos",
  scheduledDeparture: "09:10",
  scheduledArrival: "11:55",
  bookingRef: "ABC123",
  firstName: "Persona",
  lastName: "De Prueba",
} satisfies Partial<Record<keyof TicketData, string>>;

/** Fills every required field of the review step, confirms the localizador and continues. */
export async function completeReview(page: Page) {
  const v = reviewValues;
  await page.getByRole("radio", { name: v.operator }).check();
  await page.getByLabel("Localizador", { exact: true }).fill(v.bookingRef);
  await page.getByLabel("Fecha del viaje").fill(v.travelDate);
  await page.getByLabel("Estación de origen").fill(v.origin);
  await page.getByLabel("Estación de destino").fill(v.destination);
  await page.getByLabel("Hora de salida prevista").fill(v.scheduledDeparture);
  await page.getByLabel("Hora de llegada prevista").fill(v.scheduledArrival);
  await page.getByLabel("Nombre", { exact: true }).fill(v.firstName);
  await page.getByLabel("Apellidos").fill(v.lastName);
  await page.getByRole("checkbox", { name: "He comprobado el localizador" }).check();
  await page.getByRole("button", { name: "Continuar" }).click();
}
