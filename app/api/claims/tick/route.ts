// POST /api/claims/tick: the hourly timer tick (docs/plans/C-claims.md C7). Called by pg_cron
// (migration *_claims_tick_schedule.sql) with `Authorization: Bearer <TICK_SECRET>` and body {}.
// In DEMO_MODE=1 the body may carry `{ "now": "<ISO date-time>" }` to move the clock forward.
import { ZodError } from "zod";
// Relative on purpose: same domain (C owns app/api/claims/), and the tick stays off claims' public API.
import { runInbound } from "../../../../features/claims/inbound-tick";
import { runOutbound } from "../../../../features/claims/outbound-tick";
import { isTickAuthorized, resolveTickNow, runTick } from "../../../../features/claims/tick";
import { createServiceClient } from "@/shared/supabase/server";

export async function POST(request: Request): Promise<Response> {
  if (!isTickAuthorized(request.headers.get("authorization"), process.env.TICK_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  let now: Date;
  try {
    now = resolveTickNow(body);
  } catch (e) {
    if (e instanceof ZodError) {
      return Response.json({ error: "now must be an ISO date-time" }, { status: 400 });
    }
    throw e;
  }

  const db = createServiceClient();
  // First the mailbox (C4, MAIL_PROVIDER=gmail only), so a reply stops the schedule before the
  // timers run; then the timer actions (C7).
  const inbound = await runInbound(db, now);
  const result = await runTick(db, now);
  // Then what is due goes out (C3): initial claims past earliest_send_at, then every queued row.
  const outbound = await runOutbound(db, now);
  return Response.json({ ...result, inbound, outbound });
}
