import { createHash, randomUUID } from "node:crypto";
import type { Clock } from "@/shared/contracts";
import { systemClock } from "@/shared/clock";
import type { Json } from "@/shared/supabase";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import type { TicketUpload } from "../upload/read";
import { TICKET_TYPES, type TicketContentType } from "../upload/rules";
import { parseDraftId } from "./cookie";
import { intakeClient, type IntakeDraftRow, type IntakeDraftStatus } from "./db";
import { DRAFT_TTL_MS } from "./ttl";

/**
 * Intake drafts: the server-side state of one claim in progress (docs/plans/A-intake.md A1).
 * Server-only: the table and the `tickets` bucket have RLS on and no policies, so only the
 * service role reaches them. Later steps build on these functions: A3 merges the extraction into
 * `data`, A4 the review edits, A5 the answers, and A6 links its consent to the draft id.
 */

export { DRAFT_TTL_MS };
export { INTAKE_DRAFT_STATUSES, type IntakeDraftStatus } from "./db";

/** Domain A's private bucket for the original tickets; a draft's `ticket.path` is a key in it. */
export const TICKET_BUCKET = "tickets";

/** How long a preview link to the ticket works. */
const PREVIEW_URL_TTL_SECONDS = 5 * 60;

/** Free-form step data. Each step owns its own top-level key (e.g. `extraction`, `answers`). */
export type IntakeDraftData = { [key: string]: Json };

export interface IntakeDraftTicket {
  /** Key inside the `tickets` bucket. Random, and unrelated to the draft id. */
  path: string;
  contentType: TicketContentType;
  /** The user's own file name, only to show it back. */
  filename: string;
  sizeBytes: number;
}

export interface IntakeDraft {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  status: IntakeDraftStatus;
  ticket: IntakeDraftTicket | null;
  data: IntakeDraftData;
}

export interface DraftDeps {
  db?: ServiceClient;
  clock?: Clock;
}

let defaultDb: ServiceClient | undefined;
const dbOf = (deps: DraftDeps) => intakeClient(deps.db ?? (defaultDb ??= createServiceClient()));
const nowOf = (deps: DraftDeps) => (deps.clock ?? systemClock).now();

const iso = (value: string) => new Date(value).toISOString();

function toDraft(row: IntakeDraftRow): IntakeDraft {
  const ticket: IntakeDraftTicket | null =
    row.ticket_path && row.ticket_content_type && row.ticket_filename && row.ticket_size_bytes
      ? {
          path: row.ticket_path,
          contentType: row.ticket_content_type as TicketContentType,
          filename: row.ticket_filename,
          sizeBytes: row.ticket_size_bytes,
        }
      : null;
  return {
    id: row.id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    expiresAt: iso(row.expires_at),
    status: row.status,
    ticket,
    data: (row.data ?? {}) as IntakeDraftData,
  };
}

/** Stores the checked ticket in the private bucket and creates its draft (status `uploaded`). */
export async function createDraft(
  ticket: TicketUpload,
  deps: DraftDeps = {},
): Promise<IntakeDraft> {
  const db = dbOf(deps);
  const now = nowOf(deps);
  const type = TICKET_TYPES[ticket.type];
  const path = `drafts/${randomUUID()}.${type.extension}`;

  const stored = await db.storage
    .from(TICKET_BUCKET)
    .upload(path, ticket.bytes, { contentType: type.contentType, upsert: false });
  if (stored.error) throw new Error(`ticket upload failed: ${stored.error.message}`);

  const { data, error } = await db
    .from("intake_drafts")
    .insert({
      id: randomUUID(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      expires_at: new Date(now.getTime() + DRAFT_TTL_MS).toISOString(),
      status: "uploaded",
      ticket_path: path,
      ticket_content_type: type.contentType,
      ticket_filename: ticket.filename,
      ticket_size_bytes: ticket.bytes.byteLength,
    })
    .select()
    .single();
  if (error || !data) {
    await db.storage.from(TICKET_BUCKET).remove([path]);
    throw new Error(`draft insert failed: ${error?.message ?? "no row"}`);
  }
  return toDraft(data);
}

/** The draft, or null if the id is malformed, unknown or the draft has expired. */
export async function getDraft(id: string, deps: DraftDeps = {}): Promise<IntakeDraft | null> {
  const draftId = parseDraftId(id);
  if (!draftId) return null;
  const { data, error } = await dbOf(deps)
    .from("intake_drafts")
    .select()
    .eq("id", draftId)
    .gt("expires_at", nowOf(deps).toISOString())
    .maybeSingle();
  if (error) throw new Error(`draft read failed: ${error.message}`);
  return data ? toDraft(data) : null;
}

/**
 * Merges `patch` into the draft's `data` in one statement (top-level keys of the patch replace
 * the draft's, the rest stay; a key set to `null` stays as `null`), optionally moving `status`.
 * Returns the updated draft, or null if it doesn't exist or has expired.
 */
export async function mergeDraftData(
  id: string,
  patch: IntakeDraftData,
  options: DraftDeps & { status?: IntakeDraftStatus } = {},
): Promise<IntakeDraft | null> {
  const draftId = parseDraftId(id);
  if (!draftId) return null;
  const { data, error } = await dbOf(options).rpc("intake_merge_draft_data", {
    p_id: draftId,
    p_patch: patch,
    p_status: options.status ?? null,
    p_now: nowOf(options).toISOString(),
  });
  if (error) throw new Error(`draft update failed: ${error.message}`);
  const row = (data ?? [])[0];
  return row ? toDraft(row) : null;
}

/** Deletes the draft and its stored ticket. Nothing happens if it doesn't exist. */
export async function deleteDraft(id: string, deps: Pick<DraftDeps, "db"> = {}): Promise<void> {
  const draftId = parseDraftId(id);
  if (!draftId) return;
  const db = dbOf(deps);
  const { data, error } = await db
    .from("intake_drafts")
    .delete()
    .eq("id", draftId)
    .select("ticket_path");
  if (error) throw new Error(`draft delete failed: ${error.message}`);
  const paths = (data ?? []).flatMap((r) => (r.ticket_path ? [r.ticket_path] : []));
  if (paths.length > 0) {
    const removed = await db.storage.from(TICKET_BUCKET).remove(paths);
    if (removed.error) throw new Error(`ticket delete failed: ${removed.error.message}`);
  }
}

/** What the upload step shows of a stored ticket. Plain data, safe to pass to the browser. */
export interface TicketPreview {
  /** `ticketVersion(draft)`: changes whenever the ticket does, reveals nothing. */
  key: string;
  filename: string;
  /** "JPG", "PNG", "HEIC" or "PDF". */
  typeLabel: string;
  sizeBytes: number;
  /** A short-lived signed link for JPG and PNG; null for PDF and HEIC (browsers can't draw it). */
  imageUrl: string | null;
}

/**
 * An opaque value that changes whenever the draft's ticket does, for the browser to tell which
 * ticket it is showing. A hash, so neither the draft id nor the storage key reaches the page.
 */
export function ticketVersion(draft: IntakeDraft): string {
  return createHash("sha256")
    .update(`${draft.id}:${draft.ticket?.path ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

export async function ticketPreview(
  draft: IntakeDraft,
  deps: Pick<DraftDeps, "db"> = {},
): Promise<TicketPreview | null> {
  const ticket = draft.ticket;
  if (!ticket) return null;
  const type = Object.values(TICKET_TYPES).find((t) => t.contentType === ticket.contentType);
  let imageUrl: string | null = null;
  if (type?.previewable) {
    const signed = await dbOf(deps)
      .storage.from(TICKET_BUCKET)
      .createSignedUrl(ticket.path, PREVIEW_URL_TTL_SECONDS);
    // Without a link the step still shows the file card; the upload itself is fine.
    imageUrl = signed.data?.signedUrl ?? null;
  }
  return {
    key: ticketVersion(draft),
    filename: ticket.filename,
    typeLabel: type?.label ?? "",
    sizeBytes: ticket.sizeBytes,
    imageUrl,
  };
}
