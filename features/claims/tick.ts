// The timer tick (docs/plans/C-claims.md C7): what POST /api/claims/tick runs every hour.
// Internal to domain C: not exported from index.ts.
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { renderTemplate } from "@/features/documents";
import { getOperatorConfig } from "@/features/rules";
import { systemClock } from "@/shared/clock";
import { OperatorId, type CaseStatus, type Clock } from "@/shared/contracts";
import type { TablesInsert } from "@/shared/supabase";
import type { ServiceClient } from "@/shared/supabase/server";
import { transition } from "./state-machine";
import { TIMER_STATUSES, dueActions, type DueAction } from "./timers";

/** The case_events kind of every timer action; `data` is `{ action, day }`, no personal data. */
export const TIMER_EVENT_KIND = "timer_action";

/**
 * Sender of the queued mails. TODO(C3): the transport owns the real From and the threading
 * headers (Message-ID, In-Reply-To, References); it rewrites them when it sends.
 */
export const TIMER_FROM_ADDRESS = "reclamaciones@retren.invalid";

const UNIQUE_VIOLATION = "23505";

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

export interface TickResult {
  now: string;
  /** Actions applied in this run (case ids only, no personal data). */
  actions: { caseId: string; action: DueAction["kind"] }[];
  /** Due actions not applied: inactive operator or no email channel, or another tick won. */
  skipped: { caseId: string; action: DueAction["kind"]; reason: string }[];
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

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const sameInstant = (a: string | null, b: Date | null) =>
  a === null || b === null ? a === iso(b) : Date.parse(a) === b.getTime();

/**
 * Applies every due timer action at `now`. Idempotent: what already fired is read from the
 * case's `timer_action` events (at most one per action, enforced by a unique index), and each
 * case update is guarded by the status and send_count it was computed from, so a second or
 * concurrent tick for the same `now` changes nothing.
 * Mail is only queued in `messages`; the transport (C3) sends it.
 */
export async function runTick(db: ServiceClient, now: Date): Promise<TickResult> {
  const result: TickResult = { now: now.toISOString(), actions: [], skipped: [] };

  const { data: cases, error } = await db
    .from("cases")
    .select(
      "id, public_ref, operator, status, user_email, sent_at, send_count, paused, next_action_at",
    )
    .in("status", [...TIMER_STATUSES])
    .not("sent_at", "is", null)
    .or(`next_action_at.is.null,next_action_at.lte.${now.toISOString()}`)
    .order("next_action_at", { ascending: true, nullsFirst: true })
    .limit(500);
  if (error) throw error;
  if (!cases.length) return result;

  const { data: events, error: evError } = await db
    .from("case_events")
    .select("case_id, data")
    .eq("kind", TIMER_EVENT_KIND)
    .in(
      "case_id",
      cases.map((c) => c.id),
    );
  if (evError) throw evError;
  const fired = new Map<string, string[]>();
  for (const e of events) {
    const action = (e.data as { action?: unknown } | null)?.action;
    if (typeof action === "string") fired.set(e.case_id, [...(fired.get(e.case_id) ?? []), action]);
  }

  for (const row of cases as CaseRow[]) {
    const due = dueActions(
      {
        status: row.status,
        sentAt: row.sent_at,
        paused: row.paused,
        sendCount: row.send_count,
        fired: fired.get(row.id) ?? [],
      },
      now,
    );
    const [action] = due.actions;

    if (!action) {
      if (!sameInstant(row.next_action_at, due.nextActionAt)) {
        await guardedUpdate(db, row, { next_action_at: iso(due.nextActionAt) });
      }
      continue;
    }

    const recipient = recipientFor(action, row);
    if (typeof recipient !== "string") {
      result.skipped.push({ caseId: row.id, action: action.kind, reason: recipient.skip });
      continue;
    }

    // Throws if the schedule ever proposes an illegal move.
    const to = transition(row.status, action.event);
    const patch = {
      status: to,
      send_count: row.send_count + (action.countsTowardCap ? 1 : 0),
      next_action_at: iso(due.nextActionAt),
    };
    const event: TablesInsert<"case_events"> = {
      case_id: row.id,
      kind: TIMER_EVENT_KIND,
      from_status: row.status,
      to_status: to,
      data: { action: action.kind, day: action.day },
    };

    if (to === row.status) {
      // A reminder keeps the status, so the status can't tell two ticks apart: the event is the
      // claim. The unique index case_events_timer_action_once lets only one tick record it.
      const { error: claimError } = await db.from("case_events").insert(event);
      if (claimError?.code === UNIQUE_VIOLATION) {
        result.skipped.push({ caseId: row.id, action: action.kind, reason: "already_applied" });
        continue;
      }
      if (claimError) throw claimError;
      if (!(await guardedUpdate(db, row, patch))) {
        // The case changed in between (a reply arrived): the reminder is dropped, never sent late.
        await insertEvent(db, {
          case_id: row.id,
          kind: "timer_action_dropped",
          data: { action: action.kind, reason: "case_changed" },
        });
        result.skipped.push({ caseId: row.id, action: action.kind, reason: "case_changed" });
        continue;
      }
    } else {
      // The escalation and the close change the status: the guarded update is the claim.
      if (!(await guardedUpdate(db, row, patch))) {
        result.skipped.push({ caseId: row.id, action: action.kind, reason: "already_applied" });
        continue;
      }
      await insertEvent(db, event);
    }

    const operator = OperatorId.parse(row.operator);
    const rendered = renderTemplate(action.template, operator, {
      ref: row.public_ref,
      sentDate: row.sent_at!.slice(0, 10),
      day: String(action.day),
    });
    const { error: insMsgError } = await db.from("messages").insert({
      case_id: row.id,
      direction: "outbound",
      from_address: TIMER_FROM_ADDRESS,
      to_address: recipient,
      subject: rendered.subject,
      body_text: rendered.text,
      status: "queued",
    });
    if (insMsgError) throw insMsgError;

    result.actions.push({ caseId: row.id, action: action.kind });
  }
  return result;
}

/** The operator's verified address for operator mail, the case's user for the close notice. */
function recipientFor(action: DueAction, row: CaseRow): string | { skip: string } {
  if (action.recipient === "user") return row.user_email;
  const config = getOperatorConfig(OperatorId.parse(row.operator));
  if (!config.active) return { skip: "operator_inactive" };
  if (config.channel.type !== "email") return { skip: "operator_has_no_email_channel" };
  return config.channel.address;
}

async function insertEvent(db: ServiceClient, row: TablesInsert<"case_events">): Promise<void> {
  const { error } = await db.from("case_events").insert(row);
  if (error) throw error;
}

/** Updates the case only if it still has the status and send_count the action was computed from. */
async function guardedUpdate(
  db: ServiceClient,
  row: CaseRow,
  patch: { status?: CaseStatus; send_count?: number; next_action_at: string | null },
): Promise<boolean> {
  const { data, error } = await db
    .from("cases")
    .update(patch)
    .eq("id", row.id)
    .eq("status", row.status)
    .eq("send_count", row.send_count)
    .select("id");
  if (error) throw error;
  return data.length === 1;
}
