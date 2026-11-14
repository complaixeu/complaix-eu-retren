// Actions per reply category (docs/plans/C-claims.md C6, ARCHITECTURE §5–§7).
// Internal to domain C:
// - C4 (inbound) calls applyReplyCategory after recording the operator's message and applying
//   `operator_replied`;
// - the user's document reply calls forwardUserDocument;
// - C3's sender calls purgeForwardedDocuments after it sends a forwarded document.
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
} from "@/shared/contracts";
import type { Json } from "@/shared/supabase";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { DEFAULT_NOTICE_FROM } from "./create-case";
import { InvalidTransitionError, transition, type CaseTransitionEvent } from "./state-machine";
import { MAX_SENDS_PER_CASE, madridDate, stageWindow } from "./timers";

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

/** Private bucket of the documents users send for their case (deleted once their mail is sent). */
export const USER_DOCUMENTS_BUCKET = "claims-user-documents";

/** Sender of the operator mails until the real mailbox exists (C3 rewrites it). */
export const OPERATOR_MAIL_FROM = "reclamaciones@retren.invalid";

/** Why a reply landed in the team queue (C9 lists them). Codes only, no personal data. */
export type TeamQueueReason =
  | "refers_to_form"
  | "other"
  | "invalid_transition"
  | "send_cap"
  | "operator_not_emailable"
  | "render_failed"
  | "retry_exhausted";

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
  /** When the tick (C7) next looks at the case: an ISO instant, null for never; absent: kept. */
  nextActionAt?: string | null;
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
  extra: Pick<ReplyPlan, "notice" | "operatorMail" | "teamQueue" | "nextActionAt"> = {},
): ReplyPlan {
  const steps = chain(ctx.status, events);
  if (!steps) return teamQueue(ctx.status, "invalid_transition");
  return { action, status: steps[steps.length - 1].to, steps, ...extra };
}

/**
 * When the d45 escalation (sent by the tick, C7) can still happen for a denied case: the start
 * of its window, or now if the window is already open. Null when it can't: no send date, it
 * already fired, no slot left (it may use the last one), or the 3 months are over.
 */
export function escalationLookAt(ctx: ReplyActionContext): string | null {
  if (!ctx.sentAt || ctx.escalationFired || ctx.sendCount >= MAX_SENDS_PER_CASE) return null;
  const { start, end } = stageWindow("escalation_d45", ctx.sentAt);
  if (ctx.now >= end) return null;
  return (ctx.now > start ? ctx.now : start).toISOString();
}

/**
 * The category → action table. Pure, and it never throws for a reply: whatever transition()
 * refuses (a terminal state, `denied` before the insistence, an escalated case denying…) goes to
 * the team queue as `invalid_transition`.
 *
 * - acknowledgement → wait (the state transition() gives);
 * - asks_for_data → waiting_user, and our document request to the user;
 * - approved → resolved, and the final result asking the user to confirm receipt;
 * - denied, the first time → one insistence to the operator (back to `sent`). When it can't be
 *   sent (no slot below the one kept for d45, or no verified operator address) the case still
 *   moves to `denied`, so the d45 escalation still comes, and the reply goes to the team queue;
 * - denied after the insistence → left `denied` until the d45 window opens (C7 escalates; C10
 *   path 2). Closed, with the final result to the user, only when the escalation can't happen;
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
      return planned(ctx, "resolve", ["approved"], {
        notice: "user_final_result",
        nextActionAt: null,
      });
    case "denied": {
      if (!chain(ctx.status, ["rejected"])) return teamQueue(ctx.status, "invalid_transition");
      const lookAt = escalationLookAt(ctx);
      const deniedFor = (reason: TeamQueueReason) =>
        planned(ctx, "team_queue", ["rejected"], {
          teamQueue: reason,
          ...(lookAt && { nextActionAt: lookAt }),
        });
      if (ctx.insistences === 0) {
        if (!ctx.operatorReachable) return deniedFor("operator_not_emailable");
        if (!replyMailFits(ctx.sendCount)) return deniedFor("send_cap");
        return planned(ctx, "insist", ["rejected", "insistence_sent"], {
          operatorMail: "insistence_after_denial",
          nextActionAt: ctx.now.toISOString(),
        });
      }
      if (lookAt) return planned(ctx, "await_escalation", ["rejected"], { nextActionAt: lookAt });
      return planned(ctx, "close", ["rejected", "close"], {
        notice: "user_final_result",
        nextActionAt: null,
      });
    }
    case "refers_to_form":
      return teamQueue(ctx.status, "refers_to_form");
    case "other":
      return teamQueue(ctx.status, "other");
  }
}

/**
 * The plan when a reply can't be acted on as the table says (a template fails to render): the
 * team queue. A denial still moves the case to `denied`, so the d45 escalation still comes; any
 * other reply leaves the case as it is.
 */
export function fallbackPlan(ctx: ReplyActionContext, reason: TeamQueueReason): ReplyPlan {
  if (ctx.category === "denied" && chain(ctx.status, ["rejected"])) {
    const lookAt = escalationLookAt(ctx);
    return planned(ctx, "team_queue", ["rejected"], {
      teamQueue: reason,
      ...(lookAt && { nextActionAt: lookAt }),
    });
  }
  return teamQueue(ctx.status, reason);
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
 * email channel. A `to` that isn't exactly that address is refused. The database also refuses any
 * address other than the one the case's claim went to (RT403).
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
  /** B's renderTemplate; injectable so tests can see the variables or force a failure. */
  render?: typeof renderTemplate;
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
/** The recipient isn't the address the case's claim went to. */
const RECIPIENT_REFUSED = "RT403";
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

/**
 * The template variables the case itself provides: the reference, the passenger, the document
 * (ARCHITECTURE §5: the body includes the document number), the trip and the operator. Only
 * values we hold; nothing from the operator's mail (no text, link or phone number: the
 * social-engineering guard, tracker #26).
 */
function caseVars(
  row: CaseRow,
  config: OperatorPublicConfig,
): Record<string, string> & {
  ref: string;
} {
  const s = (row.submission ?? {}) as {
    ticket?: Record<string, unknown>;
    answers?: Record<string, unknown>;
  };
  const t = s.ticket ?? {};
  const a = s.answers ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  const name = [str(t.firstName), str(t.lastName)].filter(Boolean).join(" ");
  const vars: Record<string, string | undefined> = {
    passengerName: name || undefined,
    documentType: str(a.documentType),
    documentNumber: str(a.documentNumber),
    travelDate: str(t.travelDate),
    origin: str(t.origin),
    destination: str(t.destination),
    bookingRef: str(t.bookingRef),
    trainNumber: str(t.trainNumber),
    operatorName: config.displayName,
    sentDate: row.sent_at ? madridDate(row.sent_at) : undefined,
  };
  return {
    ref: row.public_ref,
    ...(Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== undefined)) as Record<
      string,
      string
    >),
  };
}

/**
 * What a notice to the user may carry: the reference, the passenger, the operator (and the
 * result, added per notice). Never the document number or the booking reference.
 */
function noticeVars(vars: ReturnType<typeof caseVars>): Record<string, string> & { ref: string } {
  const { ref, passengerName, operatorName } = vars;
  return {
    ref,
    ...(passengerName && { passengerName }),
    ...(operatorName && { operatorName }),
  };
}

const NOTICE_VARS: Record<
  NonNullable<ReplyPlan["notice"]>,
  (a: ReplyActionKind) => Record<string, string>
> = {
  user_request_document: () => ({}),
  user_final_result: (a): Record<string, string> =>
    a === "resolve" ? { result: "approved", confirmReceipt: "yes" } : { result: "denied" },
};

/**
 * Applies an operator reply's category to its case. `messageId` is the inbound message C4
 * recorded (it gets the category). Never fails because of the reply: anything the table can't act
 * on, a template that can't be rendered, or a case that keeps changing under it goes to the team
 * queue. It re-plans when the case changed (another reply or a tick).
 */
export async function applyReplyCategory(
  input: { caseId: string; messageId: string; category: ReplyCategory },
  deps: ActionDeps = {},
): Promise<ApplyReplyResult> {
  const db = deps.db ?? createServiceClient();
  const now = (deps.clock ?? systemClock).now();
  const configOf = deps.getOperatorConfig ?? rulesOperatorConfig;
  const render = deps.render ?? renderTemplate;
  const noticeFrom = deps.noticeFrom ?? process.env.MAIL_FROM ?? DEFAULT_NOTICE_FROM;

  const inbound = await db
    .from("messages")
    .select("message_id")
    .eq("id", input.messageId)
    .eq("case_id", input.caseId)
    .single();
  if (inbound.error) throw dbError("read reply", inbound.error);

  // Set when the database refused the operator address: re-planned as unreachable.
  let recipientRefused = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
      if (config.id === row.operator) operatorAddress = operatorRecipient(config);
    } catch (e) {
      if (!(e instanceof RecipientRefusedError)) throw e;
    }

    const ctx: ReplyActionContext = {
      status: row.status,
      category: input.category,
      insistences: has("reply_action", "event", "insistence_sent"),
      sendCount: row.send_count,
      sentAt: row.sent_at,
      escalationFired: has("timer_action", "action", "escalation_d45") > 0,
      operatorReachable: operatorAddress !== null && !recipientRefused,
      now,
    };
    let plan = planReplyAction(ctx);

    const outbox: Record<string, unknown>[] = [];
    try {
      const vars = caseVars(row, config);
      const operator = OperatorId.parse(row.operator);
      if (plan.notice) {
        const r = render(plan.notice, operator, {
          ...noticeVars(vars),
          ...NOTICE_VARS[plan.notice](plan.action),
        });
        outbox.push({
          audience: "user",
          template: plan.notice,
          from: noticeFrom,
          to: row.user_email,
          subject: r.subject,
          body_text: r.text,
        });
      }
      if (plan.operatorMail && operatorAddress) {
        const r = render(plan.operatorMail, operator, vars);
        outbox.push({
          audience: "operator",
          template: plan.operatorMail,
          from: OPERATOR_MAIL_FROM,
          to: operatorAddress,
          subject: r.subject,
          body_text: r.text,
          ...(inbound.data.message_id && { in_reply_to: inbound.data.message_id }),
        });
      }
    } catch {
      // A template that can't be rendered (B6 throws on a missing variable): the team queue;
      // a denial is still recorded.
      plan = fallbackPlan(ctx, "render_failed");
      outbox.length = 0;
    }

    const payload: Record<string, unknown> = { steps: plan.steps, outbox };
    if (plan.teamQueue) payload.team_queue_reason = plan.teamQueue;
    if (plan.nextActionAt !== undefined) payload.next_action_at = plan.nextActionAt;

    const applied = await db.rpc("claims_apply_reply_action", {
      p_case_id: row.id,
      p_message_id: input.messageId,
      p_category: input.category,
      p_expected_status: row.status,
      p_expected_send_count: row.send_count,
      p_plan: payload as Json,
    });
    if (applied.error) {
      if (applied.error.code === RECIPIENT_REFUSED) {
        recipientRefused = true;
        continue;
      }
      if (RETRYABLE.has(applied.error.code ?? "")) continue;
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

  // The case kept changing under us: the team looks at the reply, the case is left as it is.
  const queued = await db.rpc("claims_queue_for_team", {
    p_case_id: input.caseId,
    p_message_id: input.messageId,
    p_category: input.category,
    p_reason: "retry_exhausted",
  });
  if (queued.error) throw dbError("claims_queue_for_team", queued.error);
  const row = await readCase(db, input.caseId);
  return { action: "team_queue", status: row.status, teamQueue: "retry_exhausted", messageIds: [] };
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
 * only, moving the case waiting_user → sent, threaded under the operator's request for it. The
 * document is kept: the sender (C3) attaches it, then calls purgeForwardedDocuments.
 *
 * Throws RecipientRefusedError (nothing written) when the operator has no verified email, the
 * address isn't the one the claim went to, or no claim went out yet; InvalidTransitionError when
 * the case isn't waiting on the user. With no operator slot left (replyMailFits) nothing is
 * queued: one `team_queue` item (`send_cap`) is recorded, however often this is called.
 */
export async function forwardUserDocument(
  input: { caseId: string; attachmentId: string },
  deps: ActionDeps = {},
): Promise<ForwardResult> {
  const db = deps.db ?? createServiceClient();
  const now = (deps.clock ?? systemClock).now();
  const configOf = deps.getOperatorConfig ?? rulesOperatorConfig;
  const render = deps.render ?? renderTemplate;

  for (let attempt = 1; ; attempt++) {
    const row = await readCase(db, input.caseId);
    const operator = OperatorId.parse(row.operator);
    const config = configOf(operator);
    if (config.id !== operator) {
      throw new RecipientRefusedError("the config is not the case operator's");
    }
    const to = operatorRecipient(config);
    const status = transition(row.status, "user_document_forwarded");

    // Thread under the operator's own request: its latest mail from the verified address. Never
    // under a mail from anyone else, whatever it was classified as.
    const { data: parent, error: parentError } = await db
      .from("messages")
      .select("message_id")
      .eq("case_id", row.id)
      .eq("direction", "inbound")
      .not("message_id", "is", null)
      .eq("from_address", to)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (parentError) throw dbError("read the operator request", parentError);

    const r = render("reply_asks_for_data", operator, caseVars(row, config));
    const queued = await db.rpc("claims_forward_user_document", {
      p_case_id: row.id,
      p_attachment_id: input.attachmentId,
      p_expected_send_count: row.send_count,
      p_mail: {
        from: OPERATOR_MAIL_FROM,
        to,
        subject: r.subject,
        body_text: r.text,
        ...(parent?.message_id && { in_reply_to: parent.message_id }),
      },
      p_next_action_at: now.toISOString(),
    });
    if (queued.error) {
      if (queued.error.code === "40001" && attempt < MAX_ATTEMPTS) continue;
      if (queued.error.code === RECIPIENT_REFUSED) {
        throw new RecipientRefusedError("not the address the claim went to");
      }
      throw dbError("claims_forward_user_document", queued.error);
    }
    const out = queued.data as { message_id?: string; team_queue?: "send_cap" };
    if (out.team_queue) return { status: row.status, teamQueue: out.team_queue };
    return { status, messageId: out.message_id! };
  }
}

/**
 * Deletes from storage the user documents a forwarded mail carried, once that mail is `sent`
 * (C3's sender calls this after a successful send). The database decides first:
 * claims_mark_forwarded_documents_deleted refuses a mail that is queued or failed (then this
 * returns false and the files are kept), and otherwise marks the documents deleted with one
 * `user_document_deleted` event. Only then are the files removed. Idempotent: a re-run marks
 * nothing more and removes any file a crashed run left behind.
 */
export async function purgeForwardedDocuments(
  messageId: string,
  deps: Pick<ActionDeps, "db"> = {},
): Promise<boolean> {
  const db = deps.db ?? createServiceClient();
  const marked = await db.rpc("claims_mark_forwarded_documents_deleted", {
    p_message_id: messageId,
  });
  if (marked.error) {
    if (marked.error.code === "22023") return false;
    throw dbError("claims_mark_forwarded_documents_deleted", marked.error);
  }

  // Every document the mail carried, the ones marked by an earlier run included.
  const docs = await db
    .from("attachments")
    .select("storage_path")
    .eq("message_id", messageId)
    .eq("kind", "user_document");
  if (docs.error) throw dbError("read documents", docs.error);
  if (docs.data.length) {
    const removed = await db.storage
      .from(USER_DOCUMENTS_BUCKET)
      .remove(docs.data.map((d) => d.storage_path));
    if (removed.error) throw dbError("delete user documents", removed.error);
  }
  return true;
}
