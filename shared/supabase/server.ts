import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

export type ServiceClient = SupabaseClient<Database>;

/**
 * Server-only Supabase client with the service role. The claims tables have RLS on and no
 * policies, so only this client can read or write them. Never import it from client code.
 */
export function createServiceClient(
  env: Record<string, string | undefined> = process.env,
): ServiceClient {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
