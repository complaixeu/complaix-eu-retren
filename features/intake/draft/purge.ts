import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { UPLOAD_PREFIX } from "../upload/direct";
import { intakeClient } from "./db";
import { TICKET_BUCKET } from "./store";
import { DRAFT_TTL_MS } from "./ttl";

/** The areas of the tickets bucket the purge looks after; anything else is left alone. */
const PURGED_PREFIXES = ["drafts/", UPLOAD_PREFIX];
const PAGE = 1000;
const CHUNK = 100;

export interface PurgeResult {
  /** Expired drafts deleted (with their tickets). */
  drafts: number;
  /** Objects deleted: the expired drafts' tickets and the orphans. */
  objects: number;
}

const chunks = <T>(items: T[], size = CHUNK) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

/**
 * Data minimization for intake: deletes every draft expired at `now` with its ticket, and every
 * object under `drafts/` or `uploads/` older than the draft TTL that no draft points at (an upload
 * that was never finished, or a leftover from a failed delete). Server-only and idempotent.
 *
 * Nothing calls it on a schedule yet: a scheduler (cron, the claims tick) is infrastructure and
 * Nestor decides it.
 */
export async function purgeExpiredDrafts(
  now: Date,
  deps: { db?: ServiceClient } = {},
): Promise<PurgeResult> {
  const raw = deps.db ?? createServiceClient();
  const db = intakeClient(raw);
  const bucket = raw.storage.from(TICKET_BUCKET);

  const expired = await db
    .from("intake_drafts")
    .delete()
    .lte("expires_at", now.toISOString())
    .select("ticket_path");
  if (expired.error) throw new Error(`expired drafts delete failed: ${expired.error.message}`);
  const expiredPaths = (expired.data ?? []).flatMap((r) => (r.ticket_path ? [r.ticket_path] : []));

  const cutoff = now.getTime() - DRAFT_TTL_MS;
  const old: string[] = [];
  for (const prefix of PURGED_PREFIXES) {
    const folder = prefix.slice(0, -1);
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await bucket.list(folder, {
        limit: PAGE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`ticket listing failed: ${error.message}`);
      for (const item of data ?? []) {
        // Folders come back without an id.
        if (item.id && item.created_at && Date.parse(item.created_at) < cutoff) {
          old.push(`${prefix}${item.name}`);
        }
      }
      if (!data || data.length < PAGE) break;
    }
  }

  // Old objects still pointed at by a draft (a live draft can outlive its object's TTL) stay.
  const referenced = new Set<string>();
  for (const part of chunks(old.filter((p) => p.startsWith("drafts/")))) {
    const { data, error } = await db
      .from("intake_drafts")
      .select("ticket_path")
      .in("ticket_path", part);
    if (error) throw new Error(`draft lookup failed: ${error.message}`);
    for (const r of data ?? []) if (r.ticket_path) referenced.add(r.ticket_path);
  }

  const doomed = [...new Set([...expiredPaths, ...old.filter((p) => !referenced.has(p))])];
  for (const part of chunks(doomed)) {
    const { error } = await bucket.remove(part);
    if (error) throw new Error(`ticket delete failed: ${error.message}`);
  }
  return { drafts: expired.data?.length ?? 0, objects: doomed.length };
}
