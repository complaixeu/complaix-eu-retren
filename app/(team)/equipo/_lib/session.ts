// Server-side gate of every team page and action (docs/plans/C-claims.md C9).
// Relative imports on purpose: same domain (C owns app/(team)/), and the team logic stays off
// claims' public API (like app/api/claims/tick/route.ts).
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import {
  TEAM_SESSION_COOKIE,
  teamAccessMode,
  verifyTeamToken,
} from "../../../../features/claims/team-access";

export const LOGIN_PATH = "/equipo/entrar";

/**
 * Who is looking: a team member (checked against Auth and the allowlist on every call), or, only
 * with DEMO_MODE=1 and no Auth configured, an open demo. Without either the page does not exist
 * (404). Everything that reads or writes data calls this first, pages and server actions alike:
 * an action is a public endpoint, so it never trusts that the page was gated.
 */
export async function requireTeam(): Promise<{ email: string | null }> {
  // Env and cookies are per request: never frozen into a prerendered shell.
  await connection();
  const mode = teamAccessMode();
  if (mode === "disabled") notFound();
  if (mode === "open") return { email: null };
  const token = (await cookies()).get(TEAM_SESSION_COOKIE)?.value;
  const member = await verifyTeamToken(token);
  if (!member) redirect(LOGIN_PATH);
  return member;
}
