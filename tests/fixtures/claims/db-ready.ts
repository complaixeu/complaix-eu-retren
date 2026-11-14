import type { ServiceClient } from "@/shared/supabase/server";

/**
 * Waits until the local API answers database calls. Right after `db:reset` and the pgTAP run,
 * PostgREST can briefly answer "Database client error. Retrying the connection." for the first
 * file that runs; this waits that out (up to `timeoutMs`) instead of failing its first tests.
 */
export async function waitForDb(db: ServiceClient, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { error } = await db.rpc("claims_new_public_ref");
    if (!error) return;
    if (Date.now() > until) throw new Error(`local database not ready: ${error.message}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
