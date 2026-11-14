import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { BrowserContext } from "@playwright/test";
import { localSupabase } from "../../../support/local-supabase";
import { REVIEW } from "../../../fixtures/intake/review";
import { PLACEHOLDER_PNG } from "../../../fixtures/intake/tickets";

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

/**
 * A draft ready to submit ([A7]): its ticket file in the private bucket, `data` as the earlier
 * steps leave it, and (unless `consent` is false) a stored consent. Made this browser's current
 * draft. Returns the draft id and the ticket's `drafts/` path.
 */
export async function startSubmittableDraft(
  context: BrowserContext,
  baseURL: string,
  data: Record<string, unknown>,
  options: { consent?: boolean } = {},
): Promise<{ id: string; ticketPath: string }> {
  const db = serviceDb();
  const ticketPath = `drafts/${randomUUID()}.png`;
  const stored = await db.storage
    .from("tickets")
    .upload(ticketPath, PLACEHOLDER_PNG, { contentType: "image/png" });
  if (stored.error) throw new Error(`seeding the ticket failed: ${stored.error.message}`);

  const id = await startDraftWith(context, baseURL, data);
  const linked = await db
    .from("intake_drafts")
    .update({
      ticket_path: ticketPath,
      ticket_content_type: "image/png",
      ticket_filename: "billete.png",
      ticket_size_bytes: PLACEHOLDER_PNG.byteLength,
    })
    .eq("id", id);
  if (linked.error) throw new Error(`linking the ticket failed: ${linked.error.message}`);

  if (options.consent !== false) {
    const consent = await db.from("consents").insert({
      draft_id: id,
      accepted_at: new Date().toISOString(),
      text_version: "v-test",
      ip: "198.51.100.23",
      trip_snapshot: { ticket: {} },
    });
    if (consent.error) throw new Error(`seeding the consent failed: ${consent.error.message}`);
  }
  return { id, ticketPath };
}

/** The cases created from a draft. */
export async function casesOfDraft(draftId: string) {
  const { data, error } = await serviceDb()
    .from("cases")
    .select("*")
    .eq("submission->>draftId", draftId);
  if (error) throw new Error(`reading cases failed: ${error.message}`);
  return data;
}

/** Deletes a draft row, as the other tab's clean-up would. */
export async function deleteDraftRow(draftId: string): Promise<void> {
  const { error } = await serviceDb().from("intake_drafts").delete().eq("id", draftId);
  if (error) throw new Error(`deleting the draft failed: ${error.message}`);
}

/** Whether a draft row still exists. */
export async function draftExists(draftId: string): Promise<boolean> {
  const { data, error } = await serviceDb().from("intake_drafts").select("id").eq("id", draftId);
  if (error) throw new Error(`reading the draft failed: ${error.message}`);
  return data.length > 0;
}

/** Whether an object exists in the private tickets bucket. */
export async function ticketObjectExists(path: string): Promise<boolean> {
  const { data } = await serviceDb().storage.from("tickets").exists(path);
  return data === true;
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
