import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { BrowserContext } from "@playwright/test";
import { localSupabase } from "../../../support/local-supabase";
import { REVIEW } from "../../../fixtures/intake/review";

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
