// Who may open the team view (docs/plans/C-claims.md C9). Internal to domain C.
//
// With Supabase Auth configured, the visitor signs in with email and password and must be on the
// allowlist: the database decides (is_team_member(), migration *_claims_team_view.sql), asked
// with the visitor's own token, never with the service role. Without Auth configured the page
// exists only with DEMO_MODE=1.
//
// The session is the Auth access token in an httpOnly cookie (set by the login action). It lasts
// as long as the token (an hour by default); then the person signs in again. No refresh token is
// kept: nothing here can renew a session on its own.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/shared/supabase";

type Env = Record<string, string | undefined>;

export type AccessMode = "disabled" | "open" | "auth";

/** Cookie holding the Auth access token of a signed-in team member. */
export const TEAM_SESSION_COOKIE = "retren_team_at";

export type AuthClient = SupabaseClient<Database>;
/** Builds a client with the anon key, acting as the user when a token is given. */
export type MakeAuthClient = (url: string, anonKey: string, token?: string) => AuthClient;

export const makeAuthClient: MakeAuthClient = (url, anonKey, token) =>
  createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(token && { global: { headers: { Authorization: `Bearer ${token}` } } }),
  });

function authConfig(env: Env): { url: string; anonKey: string } | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

export function teamAccessMode(env: Env = process.env): AccessMode {
  if (authConfig(env)) return "auth";
  return env.DEMO_MODE === "1" ? "open" : "disabled";
}

/**
 * The team member behind an access token, or null. Two checks, both on the server: Auth says the
 * token is a live session (getUser asks the Auth server, it does not trust the token's contents),
 * and the database says the user is on the allowlist.
 */
export async function verifyTeamToken(
  token: string | undefined,
  env: Env = process.env,
  make: MakeAuthClient = makeAuthClient,
): Promise<{ email: string } | null> {
  const cfg = authConfig(env);
  if (!cfg || !token) return null;
  try {
    const client = make(cfg.url, cfg.anonKey, token);
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user?.email) return null;
    const member = await client.rpc("is_team_member");
    if (member.error || member.data !== true) return null;
    return { email: data.user.email };
  } catch {
    return null;
  }
}

/**
 * Ends a session on the Auth server, so the token stops working even if someone copied it
 * (admin sign-out revokes the session the token belongs to). Never throws: logging out always
 * clears the cookie, and an expired token has nothing left to revoke.
 */
export async function revokeTeamSession(
  token: string | undefined,
  revoke: (jwt: string) => Promise<unknown>,
): Promise<void> {
  if (!token) return;
  try {
    await revoke(token);
  } catch {
    // Nothing more to do: the cookie is cleared by the caller.
  }
}

/**
 * Signs in with email and password. Returns the token only for an allowlisted user; a wrong
 * password and an address that is not on the list look the same to the caller.
 */
export async function signInTeamMember(
  email: string,
  password: string,
  env: Env = process.env,
  make: MakeAuthClient = makeAuthClient,
): Promise<{ accessToken: string; maxAge: number } | null> {
  const cfg = authConfig(env);
  if (!cfg) return null;
  try {
    const { data, error } = await make(cfg.url, cfg.anonKey).auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    if (error || !data.session) return null;
    const { access_token: accessToken, expires_in: maxAge } = data.session;
    if (!(await verifyTeamToken(accessToken, env, make))) return null;
    return { accessToken, maxAge };
  } catch {
    return null;
  }
}
