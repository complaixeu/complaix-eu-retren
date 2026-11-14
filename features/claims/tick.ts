// The timer tick (docs/plans/C-claims.md C7): what POST /api/claims/tick runs every hour.
// Internal to domain C: not exported from index.ts.
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { renderTemplate } from "@/features/documents";
import { getOperatorConfig } from "@/features/rules";
import { systemClock } from "@/shared/clock";
import { OperatorId, type CaseStatus, type Clock } from "@/shared/contracts";
import type { Json } from "@/shared/supabase";
import type { ServiceClient } from "@/shared/supabase/server";
import { DEFAULT_NOTICE_FROM } from "./create-case";
import { transition } from "./state-machine";
import { TIMER_STATUSES, dueActions, madridDate, type DueAction } from "./timers";

/** The case_events kind of every timer action; `data` is `{ action, day, at }`, no personal data. */
export const TIMER_EVENT_KIND = "timer_action";

/** Most cases one tick looks at; the rest wait for the next hour. */
export const TICK_CASE_LIMIT = 500;
/** Case ids per events query (keeps the PostgREST URL short). */
const EVENTS_BATCH = 100;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/**
 * `Authorization: Bearer <TICK_SECRET>`, compared in constant time. Both sides are hashed first,
 * so the buffers always have the same length and the length of the secret does not leak.
 * Without a configured secret nothing is authorised.
 */
export function isTickAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret) return false;
  const match = /^Bearer (.+)$/.exec(header ?? "");
  if (!match) return false;
  return timingSafeEqual(sha256(match[1]), sha256(secret));
}

const TickBody = z.object({ now: z.iso.datetime({ offset: true }).optional() }).loose();

/** The tick's `now`: the clock, or the body's `now` override when (and only when) DEMO_MODE=1. */
export function resolveTickNow(
  body: unknown,
  env: Record<string, string | undefined> = process.env,
  clock: Clock = systemClock,
): Date {
  if (env.DEMO_MODE !== "1") return clock.now();
  const parsed = TickBody.parse(body ?? {});
  return parsed.now ? new Date(parsed.now) : clock.now();
}

type ActionRef = { caseId: string; action: DueAction["kind"] };

export interface TickResult {
  now: string;
  /** Actions applied in this run (case ids only, no personal data). */
  actions: ActionRef[];
  /** Due actions not applied: inactive operator, no email channel, or another tick won. */
  skipped: (ActionRef & { reason: string })[];
  /** Cases whose write failed (action null: only next_action_at); nothing was kept, the next tick retries. */
  failed: { caseId: string; action: DueAction["kind"] | null }[];
}

export interface TickDeps {
  /** B's renderTemplate; injectable so tests can see the variables or force a failure. */
  render?: typeof renderTemplate;
  /** From address of the queued mail; defaults to MAIL_FROM, then DEFAULT_NOTICE_FROM. */
  from?: string;
}

type CaseRow = {
  id: string;
  public_ref: string;
  operator: string;
  status: CaseStatus;
  user_email: string;
  sent_at: string | null;
  send_count: number;
  paused: boolean;
  next_action_at: string | null;
};

type Fired = { action: string; at: string };

/** Template variable for the date a stage was sent ("cita las fechas anteriores", §6). */
const DATE_VARS: Record<string, string> = {
  reminder_d12: "reminderD12Date",
  reminder_d30: "reminderD30Date",
  last_notice_d40: "lastNoticeD40Date",
  escalation_d45: "escalationD45Date",
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const sameInstant = (a: string | null, b: Date | null) =>
  a === null || b === null ? a === iso(b) : Date.parse(a) === b.getTime();

/**
 * Applies every due timer action at `now`. Each action is one transaction
 * (claims_apply_timer_action): the case update, guarded by the status, send_count and paused
 * flag it was computed from, the `timer_action` event (at most one per action, unique index) and
 * the queued outbox row. So a second or concurrent tick for the same `now` changes nothing, and
 * a failed write leaves nothing behind. Mail is only queued; the transport (C3) sends it.
 */
export async function runTick(
  db: ServiceClient,
  now: Date,
  deps: TickDeps = {},
): Promise<TickResult> {
  const result: TickResult = { now: now.toISOString(), actions: [], skipped: [], failed: [] };
  const render = deps.render ?? renderTemplate;
  const from = deps.from ?? process.env.MAIL_FROM ?? DEFAULT_NOTICE_FROM;

  const { data, error } = await db
    .from("cases")
    .select(
      "id, public_ref, operator, status, user_email, sent_at, send_count, paused, next_action_at",
    )
    .in("status", [...TIMER_STATUSES])
    .not("sent_at", "is", null)
    .or(`next_action_at.is.null,next_action_at.lte.${now.toISOString()}`)
    .order("next_action_at", { ascending: true, nullsFirst: true })
    .limit(TICK_CASE_LIMIT);
  if (error) throw error;
  const cases = data as CaseRow[];
  const fired = await firedActions(
    db,
    cases.map((c) => c.id),
  );

  for (const row of cases) {
    const caseFired = fired.get(row.id) ?? [];
    const due = dueActions(
      {
        status: row.status,
        sentAt: row.sent_at,
        paused: row.paused,
        sendCount: row.send_count,
        fired: caseFired.map((f) => f.action),
      },
      now,
    );
    const [action] = due.actions;
    try {
      if (!action) {
        if (!sameInstant(row.next_action_at, due.nextActionAt)) {
          await moveNextAction(db, row, due.nextActionAt);
        }
        continue;
      }

      const recipient = recipientFor(action, row);
      if (typeof recipient !== "string") {
        // Moves on to the next stage, so a skipped case doesn't come back on every tick.
        await moveNextAction(db, row, due.nextActionAt);
        result.skipped.push({ caseId: row.id, action: action.kind, reason: recipient.skip });
        continue;
      }

      // Throws if the schedule ever proposes an illegal move.
      const to = transition(row.status, action.event);
      const rendered = render(action.template, OperatorId.parse(row.operator), {
        ref: row.public_ref,
        sentDate: madridDate(row.sent_at!),
        day: String(action.day),
        ...Object.fromEntries(
          caseFired
            .filter((f) => DATE_VARS[f.action] && f.action !== action.kind)
            .map((f) => [DATE_VARS[f.action], madridDate(f.at)]),
        ),
      });
      const extra =
        action.kind === "escalation_d45"
          ? // A filing with DGTT or the Junta Arbitral is owed (C9 shows it); nothing is sent there.
            [
              {
                kind: "escalation_filing_required",
                data: { bodies: ["dgtt", "junta_arbitral"], day: action.day },
              },
            ]
          : [];

      const applied = await db.rpc("claims_apply_timer_action", {
        p_case_id: row.id,
        p_from_status: row.status,
        p_send_count: row.send_count,
        p_paused: row.paused,
        p_to_status: to,
        p_send_increment: action.countsTowardCap ? 1 : 0,
        // Nullable in SQL; the generated Args type marks every function parameter as non-null.
        p_next_action_at: iso(due.nextActionAt) as string,
        p_event_data: { action: action.kind, day: action.day, at: now.toISOString() },
        p_message: {
          recipient: action.recipient,
          template: action.template,
          from,
          to: recipient,
          subject: rendered.subject,
          body_text: rendered.text,
        } as unknown as Json,
        p_extra_events: extra,
      });
      if (applied.error) throw applied.error;
      if (applied.data === null) {
        result.skipped.push({ caseId: row.id, action: action.kind, reason: "already_applied" });
        continue;
      }
      result.actions.push({ caseId: row.id, action: action.kind });
    } catch (e) {
      // One failing case never stops the tick. Log the id and code only: no personal data.
      console.error("claims tick: case failed", row.id, (e as { code?: string }).code ?? "");
      result.failed.push({ caseId: row.id, action: action?.kind ?? null });
    }
  }
  return result;
}

/** The timer actions each case already got, read in batches of EVENTS_BATCH ids. */
async function firedActions(db: ServiceClient, ids: string[]): Promise<Map<string, Fired[]>> {
  const fired = new Map<string, Fired[]>();
  for (let i = 0; i < ids.length; i += EVENTS_BATCH) {
    const { data, error } = await db
      .from("case_events")
      .select("case_id, data, created_at")
      .eq("kind", TIMER_EVENT_KIND)
      .in("case_id", ids.slice(i, i + EVENTS_BATCH));
    if (error) throw error;
    for (const e of data) {
      const d = e.data as { action?: unknown; at?: unknown } | null;
      if (typeof d?.action !== "string") continue;
      const at = typeof d.at === "string" ? d.at : e.created_at;
      fired.set(e.case_id, [...(fired.get(e.case_id) ?? []), { action: d.action, at }]);
    }
  }
  return fired;
}

/** The operator's verified address for operator mail, the case's user for the close notice. */
function recipientFor(action: DueAction, row: CaseRow): string | { skip: string } {
  if (action.recipient === "user") return row.user_email;
  const config = getOperatorConfig(OperatorId.parse(row.operator));
  if (!config.active) return { skip: "operator_inactive" };
  if (config.channel.type !== "email") return { skip: "operator_has_no_email_channel" };
  return config.channel.address;
}

/** Sets next_action_at only if the case still has the status, send_count and pause it was read with. */
async function moveNextAction(db: ServiceClient, row: CaseRow, next: Date | null): Promise<void> {
  const { error } = await db
    .from("cases")
    .update({ next_action_at: iso(next) })
    .eq("id", row.id)
    .eq("status", row.status)
    .eq("send_count", row.send_count)
    .eq("paused", row.paused);
  if (error) throw error;
}
