// The tick's outbound step (C3): after the timer actions (./tick.ts), POST /api/claims/tick sends
// what is due. Internal to domain C.
import { fixedClock } from "@/shared/clock";
import type { ServiceClient } from "@/shared/supabase/server";
import { sendInitialClaim } from "./initial-claim";
import { sendPending, type OutboundDeps } from "./send-queued";

/** Ids and reason codes only: the tick's response holds no personal data. */
export interface OutboundTickResult {
  initialClaims: { caseId: string; ok: boolean; reason?: string }[];
  sent: { messageId: string; status: string; reason?: string }[];
  /** Set when nothing could be sent at all (a configuration that must never send). */
  sendError?: "config";
}

export const OUTBOUND_TICK_LIMIT = 100;

/**
 * 1. The initial claim of every waiting_period case whose earliest_send_at has passed at `now`.
 *    Idempotent: a sent case is no longer in waiting_period, and claims_send_initial_claim
 *    re-checks under a row lock, so a second or concurrent tick sends nothing again. A refused
 *    case (inactive operator, missing ticket) is tried again next tick; its team-queue event is
 *    logged once.
 * 2. Every queued outbound row (the timers', C6's, the notices), through sendQueued.
 * One case or row that throws is recorded as `error` and never stops the others.
 */
export async function runOutbound(
  db: ServiceClient,
  now: Date,
  deps: Omit<OutboundDeps, "db" | "clock"> = {},
  limit = OUTBOUND_TICK_LIMIT,
): Promise<OutboundTickResult> {
  const result: OutboundTickResult = { initialClaims: [], sent: [] };
  const opts: OutboundDeps = { ...deps, db, clock: fixedClock(now) };

  const due = await db
    .from("cases")
    .select("id")
    .eq("status", "waiting_period")
    .not("earliest_send_at", "is", null)
    .lte("earliest_send_at", now.toISOString())
    // A refused case (inactive operator, missing ticket) waits until its next look.
    .or(`next_action_at.is.null,next_action_at.lte.${now.toISOString()}`)
    .order("earliest_send_at", { ascending: true })
    .limit(limit);
  if (due.error) throw due.error;

  for (const { id } of due.data) {
    try {
      const out = await sendInitialClaim(id, opts);
      result.initialClaims.push(
        out.ok ? { caseId: id, ok: true } : { caseId: id, ok: false, reason: out.reason },
      );
    } catch {
      result.initialClaims.push({ caseId: id, ok: false, reason: "error" });
    }
  }

  try {
    for (const r of await sendPending(opts, { limit })) {
      result.sent.push({
        messageId: r.messageId,
        status: r.result.status,
        ...(r.result.status !== "sent" && { reason: r.result.reason }),
      });
    }
  } catch {
    // A configuration that must never send (assertSendConfig): nothing was touched.
    result.sendError = "config";
  }
  return result;
}
