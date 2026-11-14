// The sender (docs/plans/README.md §4.2, C3): the one place a queued outbound row in `messages`
// is actually sent, whoever queued it (the initial claim, C6 actions, C7 timers, C8 notices).
// Every safety rule of ./outbound.ts runs here, on every row. Internal to domain C.
import { getOperatorConfig } from "@/features/rules";
import { systemClock } from "@/shared/clock";
import { OperatorId, type CaseStatus, type Clock, type MailTransport } from "@/shared/contracts";
import { provider } from "@/shared/providers";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { DEFAULT_SENDING_DOMAIN } from "./classifier";
import {
  buildMailMessage,
  checkAttachments,
  checkMockText,
  checkRecipient,
  isStale,
  newMessageId,
  type AttachmentRow,
  type OutboundRefusal,
} from "./outbound";
import { createMailTransport } from "./transport";

type Env = Record<string, string | undefined>;

export interface OutboundDeps {
  /** Service-role client; created from env when left out. */
  db?: ServiceClient;
  clock?: Clock;
  /** The transport; the one MAIL_PROVIDER selects when left out. */
  transport?: MailTransport;
  /** The provider name the mock-text rule checks; MAIL_PROVIDER when left out. */
  providerName?: string;
  /** Env for MAIL_REDIRECT_ALL_TO, RETREN_ENV, MAIL_SENDING_DOMAIN; process.env when left out. */
  env?: Env;
}

export type SendQueuedResult =
  | { status: "sent"; providerId: string }
  | { status: "failed"; reason: OutboundRefusal }
  | { status: "skipped"; reason: "not_found" | "not_queued" };

export const MESSAGE_SENT_EVENT = "message_sent";
export const MESSAGE_FAILED_EVENT = "message_failed";

/** Our sending domain (placeholder until the real one is chosen, needs Nestor). */
export function sendingDomain(env: Env = process.env): string {
  return env.MAIL_SENDING_DOMAIN || DEFAULT_SENDING_DOMAIN;
}

/**
 * Sends one queued outbound row, or refuses it and marks it `failed` with the reason. Never
 * increments `send_count`: mail counts towards the cap when it is queued (C7).
 *
 * Exactly one caller gets to send a row: it is claimed first (send_claimed_at), so a second or
 * concurrent call answers `skipped: not_queued`.
 */
export async function sendQueued(
  messageId: string,
  deps: OutboundDeps = {},
): Promise<SendQueuedResult> {
  const db = deps.db ?? createServiceClient();
  const env = deps.env ?? process.env;
  const now = (deps.clock ?? systemClock).now();
  const providerName = deps.providerName ?? provider("MAIL_PROVIDER", env);

  const claimed = await db
    .from("messages")
    .update({ send_claimed_at: now.toISOString() })
    .eq("id", messageId)
    .eq("direction", "outbound")
    .eq("status", "queued")
    .is("send_claimed_at", null)
    .select("*");
  if (claimed.error) throw claimed.error;
  const row = claimed.data[0];
  if (!row) {
    const exists = await db.from("messages").select("id").eq("id", messageId).maybeSingle();
    if (exists.error) throw exists.error;
    return { status: "skipped", reason: exists.data ? "not_queued" : "not_found" };
  }
  if (!row.case_id) return fail(db, row.id, null, row.template, "recipient_not_allowed");
  const caseId = row.case_id;

  const [kase, attachments, thread] = await Promise.all([
    db
      .from("cases")
      .select("id, public_ref, operator, status, user_email")
      .eq("id", caseId)
      .single(),
    db
      .from("attachments")
      .select("kind, case_id, deleted_at, filename, content_type, storage_path")
      .eq("message_id", row.id),
    db
      .from("messages")
      .select("id, direction, status, from_address, to_address, message_id, created_at")
      .eq("case_id", caseId)
      .neq("id", row.id),
  ]);
  if (kase.error) throw kase.error;
  if (attachments.error) throw attachments.error;
  if (thread.error) throw thread.error;
  const c = kase.data;

  const text = row.body_text ?? "";
  const refusal = firstRefusal([
    checkMockText({ subject: row.subject, text }, providerName),
    checkRecipient({
      to: row.to_address,
      userEmail: c.user_email,
      operator: getOperatorConfig(OperatorId.parse(c.operator)),
      template: row.template,
    }),
    checkAttachments(attachments.data, caseId),
  ]);
  if (refusal) return fail(db, row.id, caseId, row.template, refusal);

  // The case thread: the operator's, or the user's (they never mix).
  const user = c.user_email.trim().toLowerCase();
  const isUser = (m: { from_address: string; to_address: string }) =>
    m.from_address.trim().toLowerCase() === user || m.to_address.trim().toLowerCase() === user;
  const toUser = row.to_address.trim().toLowerCase() === user;
  const sameThread = thread.data.filter(
    (m) =>
      isUser(m) === toUser &&
      (m.direction === "inbound" || (m.direction === "outbound" && m.status === "sent")),
  );

  if (!toUser) {
    const inbound = thread.data
      .filter((m) => m.direction === "inbound" && !isUser(m))
      .map((m) => m.created_at)
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    const stale = isStale({
      caseStatus: c.status as CaseStatus,
      queuedAt: row.created_at,
      lastInboundAt: inbound.at(-1) ?? null,
    });
    if (stale) return fail(db, row.id, caseId, row.template, "stale");
  }

  const mail = buildMailMessage(
    {
      from: row.from_address,
      to: row.to_address,
      subject: row.subject,
      text: text || row.subject,
      publicRef: c.public_ref,
      messageId: row.message_id ?? newMessageId(c.public_ref, sendingDomain(env)),
      thread: sameThread,
      attachments: attachments.data as AttachmentRow[],
    },
    env,
  );

  let providerId: string;
  try {
    ({ providerId } = await (deps.transport ?? createMailTransport(env).transport).send(mail));
  } catch {
    return fail(db, row.id, caseId, row.template, "transport_error");
  }

  const done = await db
    .from("messages")
    .update({
      status: "sent",
      provider_id: providerId,
      sent_at: now.toISOString(),
      subject: mail.subject,
      message_id: mail.messageId,
      in_reply_to: mail.inReplyTo ?? null,
      thread_references: mail.references ?? null,
      delivered_to: mail.to,
    })
    .eq("id", row.id);
  if (done.error) throw done.error;
  await event(db, caseId, MESSAGE_SENT_EVENT, { message_id: row.id, template: row.template });
  return { status: "sent", providerId };
}

/**
 * Sends every queued, unclaimed outbound row, oldest first (at most `limit` per run). What the
 * tick (C7) or a worker calls after queueing; each row goes through sendQueued and its rules.
 */
export async function sendPending(
  deps: OutboundDeps = {},
  limit = 100,
): Promise<{ messageId: string; result: SendQueuedResult }[]> {
  const db = deps.db ?? createServiceClient();
  const pending = await db
    .from("messages")
    .select("id")
    .eq("direction", "outbound")
    .eq("status", "queued")
    .is("send_claimed_at", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (pending.error) throw pending.error;
  const out: { messageId: string; result: SendQueuedResult }[] = [];
  for (const { id } of pending.data) {
    out.push({ messageId: id, result: await sendQueued(id, { ...deps, db }) });
  }
  return out;
}

function firstRefusal(checks: { ok: boolean; reason?: OutboundRefusal }[]) {
  return checks.find((c) => !c.ok)?.reason ?? null;
}

async function fail(
  db: ServiceClient,
  id: string,
  caseId: string | null,
  template: string | null,
  reason: OutboundRefusal,
): Promise<SendQueuedResult> {
  const upd = await db
    .from("messages")
    .update({ status: "failed", failure_reason: reason })
    .eq("id", id);
  if (upd.error) throw upd.error;
  if (caseId) await event(db, caseId, MESSAGE_FAILED_EVENT, { message_id: id, template, reason });
  return { status: "failed", reason };
}

/** Case events hold ids and reasons only, never an address or a body. */
async function event(
  db: ServiceClient,
  caseId: string,
  kind: string,
  data: Record<string, string | null>,
): Promise<void> {
  const { error } = await db.from("case_events").insert({ case_id: caseId, kind, data });
  if (error) throw error;
}
