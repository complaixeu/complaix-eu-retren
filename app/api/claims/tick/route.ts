// POST /api/claims/tick: the hourly timer tick (docs/plans/C-claims.md C7). Called by pg_cron
// (migration *_claims_tick_schedule.sql) with `Authorization: Bearer <TICK_SECRET>` and body {}.
// In DEMO_MODE=1 the body may carry `{ "now": "<ISO date-time>" }` to move the clock forward.
import { ZodError } from "zod";
// Same domain (C owns app/api/claims/), so a relative import into its internals. The tick is
// not part of claims' public API (index.ts), which other domains use.
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

  const result = await runTick(createServiceClient(), now);
  return Response.json(result);
}
