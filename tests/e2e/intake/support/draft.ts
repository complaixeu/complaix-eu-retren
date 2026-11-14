import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import type { TicketData } from "@/shared/contracts";
import { localSupabase } from "../../../support/local-supabase";
import { REVIEW } from "../../../fixtures/intake/review";
import { PLACEHOLDER_PDF } from "../../../fixtures/intake/tickets";

/**
 * Test-only shortcuts for the steps after the upload: a service client on the local Supabase
 * (never a remote one, see localSupabase) to seed drafts and read what a step stored.
 */
export function serviceDb() {
  const sb = localSupabase();
  return createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false } });
}

/**
 * Creates a draft whose `data` already holds what earlier steps would have stored (by default
 * the reviewed trip of [A4]) and makes it this browser's current draft through the cookie.
 */
export async function startDraftWith(
  context: BrowserContext,
  baseURL: string,
  data: Record<string, unknown> = { review: REVIEW },
): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  const { error } = await serviceDb()
    .from("intake_drafts")
    .insert({
      id,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      data,
    });
  if (error) throw new Error(`seeding the draft failed: ${error.message}`);
  const { hostname } = new URL(baseURL);
  await context.addCookies([
    {
      name: "retren_draft",
      value: id,
      domain: hostname,
      path: "/reclamar",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return id;
}

/** The consents stored for a draft. */
export async function consentsOf(draftId: string) {
  const { data, error } = await serviceDb().from("consents").select("*").eq("draft_id", draftId);
  if (error) throw new Error(`reading consents failed: ${error.message}`);
  return data as {
    id: string;
    draft_id: string;
    accepted_at: string;
    text_version: string;
    ip: string | null;
    trip_snapshot: Record<string, unknown>;
  }[];
}

/** The id in this browser's draft cookie, once the upload step has set it. */
export async function currentDraftId(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find((c) => c.name === "retren_draft");
  if (!cookie) throw new Error("no draft cookie");
  return cookie.value;
}

/** Merges `patch` into a draft's data, as a later step's action would. */
export async function mergeIntoDraft(draftId: string, patch: Record<string, unknown>) {
  const { error } = await serviceDb().rpc("intake_merge_draft_data", {
    p_id: draftId,
    p_patch: patch,
  });
  if (error) throw new Error(`merging into the draft failed: ${error.message}`);
}

// The review step's helpers ([A4]).

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

/** Replaces the current draft's `data` with `data` (e.g. an extraction, until A3 writes it). */
export async function seedDraftData(context: BrowserContext, data: Record<string, unknown>) {
  const { error } = await serviceDb()
    .from("intake_drafts")
    .update({ data })
    .eq("id", await currentDraftId(context));
  if (error) throw new Error(`seeding the draft failed: ${error.message}`);
}

/** The current draft's `data`, as stored. */
export async function draftData(context: BrowserContext): Promise<Record<string, unknown>> {
  const { data, error } = await serviceDb()
    .from("intake_drafts")
    .select("data")
    .eq("id", await currentDraftId(context))
    .single();
  if (error) throw new Error(`reading the draft failed: ${error.message}`);
  return (data?.data ?? {}) as Record<string, unknown>;
}

/** A complete, valid review, as typed into the review step's form. */
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
