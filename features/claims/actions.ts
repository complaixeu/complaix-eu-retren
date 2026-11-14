// Actions per reply category (docs/plans/C-claims.md C6, ARCHITECTURE §5–§7).
// Internal to domain C: C4 (inbound) calls applyReplyCategory after recording the operator's
// message and applying `operator_replied`; the user's document reply calls forwardUserDocument.
// The category → action table is the pure planReplyAction; every write is one plpgsql function
// (migration *_claims_reply_actions.sql), so the state change, its events and the outbox rows
// land together or not at all. Mail is only queued; the transport (C3) sends it.
import { renderTemplate } from "@/features/documents";
import { getOperatorConfig as rulesOperatorConfig } from "@/features/rules";
import { systemClock } from "@/shared/clock";
import {
  OperatorId,
  type CaseStatus,
  type Clock,
  type OperatorPublicConfig,
  type ReplyCategory,
  type TemplateKind,
} from "@/shared/contracts";
import type { Json } from "@/shared/supabase";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { DEFAULT_NOTICE_FROM } from "./create-case";
import { InvalidTransitionError, transition, type CaseTransitionEvent } from "./state-machine";
import { MAX_SENDS_PER_CASE, stageWindow } from "./timers";

/**
 * send_count goes up when an operator mail is queued, and the last slot is reserved for the d45
 * escalation (C7). A reply's operator mail (the insistence, a forwarded document) is allowed only
 * below this; at it, the case goes to the team queue (`send_cap`). User notices don't count.
 */
export function replyMailFits(sendCount: number): boolean {
  return sendCount < MAX_SENDS_PER_CASE - 1;
}

/** The day (since sent_at) of the d45 escalation (ARCHITECTURE §6), which the tick (C7) sends. */
export const ESCALATION_DAY =
  stageWindow("escalation_d45", new Date(0)).start.getTime() / 86_400_000; // 45

/** Private bucket of the documents users send for their case (deleted once forwarded). */
export const USER_DOCUMENTS_BUCKET = "claims-user-documents";

/** Sender of the operator mails until the real mailbox exists (C3 rewrites it). */
export const OPERATOR_MAIL_FROM = "reclamaciones@retren.invalid";

/** Why a reply landed in the team queue (C9 lists them). Codes only, no personal data. */
export type TeamQueueReason =
  "refers_to_form" | "other" | "invalid_transition" | "send_cap" | "operator_not_emailable";

export type ReplyActionKind =
  "wait" | "request_document" | "resolve" | "insist" | "close" | "await_escalation" | "team_queue";

export interface ReplyStep {
  event: CaseTransitionEvent;
  from: CaseStatus;
  to: CaseStatus;
}

export interface ReplyPlan {
  action: ReplyActionKind;
  steps: ReplyStep[];
  /** The case status once the plan is applied. */
  status: CaseStatus;
  /** A notice to the case user (ARCHITECTURE §7). */
  notice?: "user_request_document" | "user_final_result";
  /** The one operator mail a reply can trigger. */
  operatorMail?: "insistence_after_denial";
  teamQueue?: TeamQueueReason;
}

/** What the table needs to know about the case when the reply is applied. */
export interface ReplyActionContext {
  status: CaseStatus;
  category: ReplyCategory;
  /** Insistences already recorded in case_events. */
  insistences: number;
  sendCount: number;
  sentAt: string | null;
  /** The tick already applied the d45 escalation. */
  escalationFired: boolean;
  /** The operator has an active, verified email channel. */
  operatorReachable: boolean;
  now: Date;
}

/** Plans the steps from `status`; null when transition() refuses one (the team queue). */
function chain(status: CaseStatus, events: CaseTransitionEvent[]): ReplyStep[] | null {
  const steps: ReplyStep[] = [];
  let from = status;
  for (const event of events) {
    try {
      const to = transition(from, event);
      steps.push({ event, from, to });
      from = to;
    } catch (e) {
      if (e instanceof InvalidTransitionError) return null;
      throw e;
    }
  }
  return steps;
}

const teamQueue = (status: CaseStatus, reason: TeamQueueReason): ReplyPlan => ({
  action: "team_queue",
  status,
  steps: [],
  teamQueue: reason,
});

function planned(
  ctx: ReplyActionContext,
  action: ReplyActionKind,
  events: CaseTransitionEvent[],
  extra: Pick<ReplyPlan, "notice" | "operatorMail"> = {},
): ReplyPlan {
  const steps = chain(ctx.status, events);
  if (!steps) return teamQueue(ctx.status, "invalid_transition");
  return { action, status: steps[steps.length - 1].to, steps, ...extra };
}

/** The d45 escalation is due and still to come (the tick sends it, C7). */
function escalationDue(ctx: ReplyActionContext): boolean {
  // The escalation may use the last slot (C7: sent while send_count < MAX_SENDS_PER_CASE).
  if (!ctx.sentAt || ctx.escalationFired || ctx.sendCount >= MAX_SENDS_PER_CASE) return false;
  const { start, end } = stageWindow("escalation_d45", ctx.sentAt);
  return ctx.now >= start && ctx.now < end;
}

/**
 * The category → action table. Pure, and it never throws for a reply: whatever transition()
 * refuses (a terminal state, `denied` before the insistence, an escalated case denying…) goes to
 * the team queue as `invalid_transition`.
 *
 * - acknowledgement → wait (the state transition() gives);
 * - asks_for_data → waiting_user, and our document request to the user;
 * - approved → resolved, and the final result asking the user to confirm receipt;
 * - denied → the first time, one insistence to the operator (back to `sent`); after it, closed
 *   with the final result to the user, unless the d45 escalation is due: then the case is left
 *   `denied` for the tick to escalate;
 * - refers_to_form, other → the team queue.
 */
export function planReplyAction(ctx: ReplyActionContext): ReplyPlan {
  switch (ctx.category) {
    case "acknowledgement":
      return planned(ctx, "wait", ["acknowledged"]);
    case "asks_for_data":
      return planned(ctx, "request_document", ["data_requested"], {
        notice: "user_request_document",
      });
    case "approved":
      return planned(ctx, "resolve", ["approved"], { notice: "user_final_result" });
    case "denied": {
      if (!chain(ctx.status, ["rejected"])) return teamQueue(ctx.status, "invalid_transition");
      if (ctx.insistences === 0) {
        if (!ctx.operatorReachable) return teamQueue(ctx.status, "operator_not_emailable");
        if (!replyMailFits(ctx.sendCount)) return teamQueue(ctx.status, "send_cap");
        return planned(ctx, "insist", ["rejected", "insistence_sent"], {
          operatorMail: "insistence_after_denial",
        });
      }
      if (escalationDue(ctx)) return planned(ctx, "await_escalation", ["rejected"]);
      return planned(ctx, "close", ["rejected", "close"], { notice: "user_final_result" });
    }
    case "refers_to_form":
      return teamQueue(ctx.status, "refers_to_form");
    case "other":
      return teamQueue(ctx.status, "other");
  }
}

/** Mail to anyone but the operator's verified address. */
export class RecipientRefusedError extends Error {
  constructor(reason: string) {
    super(`Recipient refused: ${reason}`);
    this.name = "RecipientRefusedError";
  }
}

/**
 * The operator's verified address (README §4, recipient allowlist): an active operator with an
 * email channel. A `to` that isn't exactly that address is refused.
 */
export function operatorRecipient(config: OperatorPublicConfig, to?: string): string {
  if (!config.active) throw new RecipientRefusedError(`operator ${config.id} is not active`);
  if (config.channel.type !== "email") {
    throw new RecipientRefusedError(`operator ${config.id} has no email channel`);
  }
  const address = config.channel.address;
  if (to !== undefined && to !== address) {
    throw new RecipientRefusedError("not the operator's verified address");
  }
  return address;
}

export interface ActionDeps {
  /** Service-role client; created from env when left out. */
  db?: ServiceClient;
  clock?: Clock;
  /** B's operator configs; injectable for tests. */
  getOperatorConfig?: (id: OperatorId) => OperatorPublicConfig;
  /** From address of user notices; defaults to MAIL_FROM, then DEFAULT_NOTICE_FROM. */
  noticeFrom?: string;
}

export interface ApplyReplyResult {
  action: ReplyActionKind;
  status: CaseStatus;
  teamQueue?: TeamQueueReason;
  /** The outbox rows queued by this action. */
  messageIds: string[];
}

type CaseRow = {
  id: string;
  public_ref: string;
  operator: string;
  status: CaseStatus;
  submission: Json;
  user_email: string;
  sent_at: string | null;
  send_count: number;
};

const CASE_COLUMNS =
  "id, public_ref, operator, status, submission, user_email, sent_at, send_count";

/** The case changed between reading and writing (40001), or a concurrent insistence won (23505). */
const RETRYABLE = new Set(["40001", "23505"]);
const MAX_ATTEMPTS = 4;

class ActionDbError extends Error {
  constructor(
    readonly step: string,
    readonly code: string | undefined,
    message: string,
  ) {
    super(`claims actions: ${step} failed: ${message}`);
    this.name = "ActionDbError";
  }
}

const dbError = (step: string, e: { code?: string; message: string }) =>
  new ActionDbError(step, e.code, e.message);

async function readCase(db: ServiceClient, caseId: string): Promise<CaseRow> {
  const { data, error } = await db.from("cases").select(CASE_COLUMNS).eq("id", caseId).single();
  if (error) throw dbError("read case", error);
  return data as CaseRow;
}

/** "Nombre Apellido" from the stored submission, for the template signature and greeting. */
function passengerName(submission: Json): string | undefined {
  const t = (submission as { ticket?: { firstName?: unknown; lastName?: unknown } } | null)?.ticket;
  const parts = [t?.firstName, t?.lastName].filter((p): p is string => typeof p === "string");
  return parts.length ? parts.join(" ") : undefined;
}

/**
 * Our template, filled only with case data we hold. Nothing from the operator's mail goes in
 * (no text, link or phone number: social-engineering guard, tracker #26).
 */
function render(kind: TemplateKind, row: CaseRow, vars: Record<string, string> = {}) {
  const name = passengerName(row.submission);
  return renderTemplate(kind, OperatorId.parse(row.operator), {
    ref: row.public_ref,
    ...(name && { passengerName: name }),
    ...vars,
  });
}

const NOTICE_VARS: Record<NonNullable<ReplyPlan["notice"]>, (a: ReplyActionKind) => object> = {
  user_request_document: () => ({}),
  user_final_result: (a) =>
    a === "resolve" ? { result: "approved", confirmReceipt: "yes" } : { result: "denied" },
};

/**
 * Applies an operator reply's category to its case. `messageId` is the inbound message C4
 * recorded (it gets the category). Never fails because of the reply: anything the table can't
 * act on goes to the team queue. Retries when the case changed under it (another reply or a tick).
 */
export async function applyReplyCategory(
  input: { caseId: string; messageId: string; category: ReplyCategory },
  deps: ActionDeps = {},
): Promise<ApplyReplyResult> {
  const db = deps.db ?? createServiceClient();
  const now = (deps.clock ?? systemClock).now();
  const configOf = deps.getOperatorConfig ?? rulesOperatorConfig;
  const noticeFrom = deps.noticeFrom ?? process.env.MAIL_FROM ?? DEFAULT_NOTICE_FROM;

  const inbound = await db
    .from("messages")
    .select("message_id")
    .eq("id", input.messageId)
    .eq("case_id", input.caseId)
    .single();
  if (inbound.error) throw dbError("read reply", inbound.error);

  for (let attempt = 1; ; attempt++) {
    const row = await readCase(db, input.caseId);
    const { data: events, error } = await db
      .from("case_events")
      .select("kind, data")
      .eq("case_id", row.id)
      .in("kind", ["reply_action", "timer_action"]);
    if (error) throw dbError("read events", error);
    const has = (kind: string, key: string, value: string) =>
      events.filter(
        (e) => e.kind === kind && (e.data as Record<string, unknown> | null)?.[key] === value,
      ).length;

    const config = configOf(OperatorId.parse(row.operator));
    let operatorAddress: string | null = null;
    try {
      operatorAddress = operatorRecipient(config);
    } catch (e) {
      if (!(e instanceof RecipientRefusedError)) throw e;
    }

    const plan = planReplyAction({
      status: row.status,
      category: input.category,
      insistences: has("reply_action", "event", "insistence_sent"),
      sendCount: row.send_count,
      sentAt: row.sent_at,
      escalationFired: has("timer_action", "action", "escalation_d45") > 0,
      operatorReachable: operatorAddress !== null,
      now,
    });

    const outbox: Record<string, unknown>[] = [];
    if (plan.notice) {
      const r = render(plan.notice, row, NOTICE_VARS[plan.notice](plan.action) as never);
      outbox.push({
        audience: "user",
        template: plan.notice,
        from: noticeFrom,
        to: row.user_email,
        subject: r.subject,
        body_text: r.text,
      });
    }
    if (plan.operatorMail) {
      const r = render(plan.operatorMail, row);
      outbox.push({
        audience: "operator",
        template: plan.operatorMail,
        from: OPERATOR_MAIL_FROM,
        to: operatorRecipient(config, operatorAddress ?? undefined),
        subject: r.subject,
        body_text: r.text,
        ...(inbound.data.message_id && { in_reply_to: inbound.data.message_id }),
      });
    }

    const payload: Record<string, unknown> = { steps: plan.steps, outbox };
    if (plan.teamQueue) payload.team_queue_reason = plan.teamQueue;
    // The tick (C7) recomputes the schedule of a case back in `sent` or left for the escalation;
    // a finished case has nothing more to do.
    if (plan.action === "insist" || plan.action === "await_escalation") {
      payload.next_action_at = now.toISOString();
    } else if (plan.status === "resolved" || plan.status === "closed") {
      payload.next_action_at = null;
    }

    const applied = await db.rpc("claims_apply_reply_action", {
      p_case_id: row.id,
      p_message_id: input.messageId,
      p_category: input.category,
      p_expected_status: row.status,
      p_expected_send_count: row.send_count,
      p_plan: payload as Json,
    });
    if (applied.error) {
      if (RETRYABLE.has(applied.error.code ?? "") && attempt < MAX_ATTEMPTS) continue;
      throw dbError("claims_apply_reply_action", applied.error);
    }
    const out = applied.data as { status: CaseStatus; message_ids: string[] };
    return {
      action: plan.action,
      status: out.status,
      ...(plan.teamQueue && { teamQueue: plan.teamQueue }),
      messageIds: out.message_ids,
    };
  }
}

export type ForwardResult =
  | {
      status: CaseStatus;
      /** The queued outbox row carrying the document. */
      messageId: string;
    }
  /** No slot left below the one reserved for d45: the team decides, the document is kept. */
  | { status: CaseStatus; teamQueue: "send_cap" };

/**
 * Forwards the document the user sent (ARCHITECTURE §7.1) to the operator's verified address
 * only, moving the case waiting_user → sent, then deletes the file from storage and marks the
 * attachment deleted. Throws RecipientRefusedError (nothing written) when the operator has no
 * verified email, and InvalidTransitionError when the case isn't waiting on the user. With no
 * operator slot left (replyMailFits), nothing is sent: a `team_queue` event (`send_cap`) is
 * recorded and the document is kept.
 *
 * TODO(C3): the mail is only queued here, so the sender must not need the file afterwards. Until
 * C3 decides how the transport carries it (send synchronously before the delete, or delete after
 * sending), the outbox row links the attachment row, whose file is gone.
 */
export async function forwardUserDocument(
  input: { caseId: string; attachmentId: string },
  deps: ActionDeps = {},
): Promise<ForwardResult> {
  const db = deps.db ?? createServiceClient();
  const now = (deps.clock ?? systemClock).now();
  const configOf = deps.getOperatorConfig ?? rulesOperatorConfig;

  for (let attempt = 1; ; attempt++) {
    const row = await readCase(db, input.caseId);
    const operator = OperatorId.parse(row.operator);
    const config = configOf(operator);
    if (config.id !== operator) {
      throw new RecipientRefusedError("the config is not the case operator's");
    }
    const to = operatorRecipient(config);
    const status = transition(row.status, "user_document_forwarded");

    if (!replyMailFits(row.send_count)) {
      const { error } = await db.from("case_events").insert({
        case_id: row.id,
        kind: "team_queue",
        data: { reason: "send_cap", attachment_id: input.attachmentId },
      });
      if (error) throw dbError("record team queue", error);
      return { status: row.status, teamQueue: "send_cap" };
    }

    const att = await db
      .from("attachments")
      .select("storage_path")
      .eq("id", input.attachmentId)
      .eq("case_id", row.id)
      .single();
    if (att.error) throw dbError("read attachment", att.error);

    const { data: lastReply } = await db
      .from("messages")
      .select("message_id")
      .eq("case_id", row.id)
      .eq("direction", "inbound")
      .not("message_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const r = render("reply_asks_for_data", row);
    const queued = await db.rpc("claims_forward_user_document", {
      p_case_id: row.id,
      p_attachment_id: input.attachmentId,
      p_expected_send_count: row.send_count,
      p_mail: {
        from: OPERATOR_MAIL_FROM,
        to,
        subject: r.subject,
        body_text: r.text,
        ...(lastReply?.message_id && { in_reply_to: lastReply.message_id }),
      },
      p_next_action_at: now.toISOString(),
    });
    if (queued.error) {
      if (queued.error.code === "40001" && attempt < MAX_ATTEMPTS) continue;
      throw dbError("claims_forward_user_document", queued.error);
    }

    const removed = await db.storage.from(USER_DOCUMENTS_BUCKET).remove([att.data.storage_path]);
    if (removed.error) throw dbError("delete user document", removed.error);
    const marked = await db.rpc("claims_mark_user_document_deleted", {
      p_attachment_id: input.attachmentId,
    });
    if (marked.error) throw dbError("claims_mark_user_document_deleted", marked.error);

    return { status, messageId: queued.data };
  }
}
