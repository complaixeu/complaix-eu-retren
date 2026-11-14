// The sender (docs/plans/README.md §4.2, C3): the one place a queued outbound row in `messages`
// is actually sent, whoever queued it (the initial claim, C6 actions, C7 timers, C8 notices).
// Every safety rule of ./outbound.ts runs here, on every row. Internal to domain C.
import { getOperatorConfig } from "@/features/rules";
import { systemClock } from "@/shared/clock";
import { OperatorId, type CaseStatus, type Clock } from "@/shared/contracts";
import type { Json } from "@/shared/supabase";
import { provider } from "@/shared/providers";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { purgeForwardedDocuments, USER_DOCUMENTS_BUCKET } from "./actions";
import { DOCUMENTS_BUCKET, TICKET_BUCKET } from "./buckets";
import { DEFAULT_SENDING_DOMAIN } from "./classifier";
import { effectiveOperator, operatorInboxes } from "./operator-inboxes";
import {
  buildMailMessage,
  checkAttachments,
  checkMockText,
  checkRecipient,
  isStale,
  newMessageId,
  redirectRecipients,
  REMINDER_TEMPLATES,
  type AttachmentRow,
  type OutboundRefusal,
} from "./outbound";
import {
  createMailTransport,
  transportFailure,
  type ClaimsTransport,
  type OutboundAttachment,
} from "./transport";

type Env = Record<string, string | undefined>;

export interface OutboundDeps {
  /** Service-role client; created from env when left out. */
  db?: ServiceClient;
  clock?: Clock;
  /** The transport; the one MAIL_PROVIDER selects when left out. */
  transport?: ClaimsTransport;
  /** The provider name the mock-text and redirect rules check; MAIL_PROVIDER when left out. */
  providerName?: string;
  /** Env for MAIL_REDIRECT_ALL_TO, RETREN_ENV, MAIL_SENDING_DOMAIN; process.env when left out. */
  env?: Env;
  /**
   * Runs after a row is marked `sent`, never after a failed send: deletes the forwarded user
   * documents linked to it (C6's purgeForwardedDocuments, idempotent).
   */
  purgeForwardedDocuments?: (messageId: string) => Promise<unknown>;
}

export type SendQueuedResult =
  | { status: "sent"; providerId: string }
  | { status: "failed"; reason: OutboundRefusal }
  | { status: "skipped"; reason: "not_found" | "not_queued" };

export const MESSAGE_SENT_EVENT = "message_sent";
export const MESSAGE_FAILED_EVENT = "message_failed";
/** A case_events kind the team view (C9) lists: something a person must look at. */
export const TEAM_QUEUE_EVENT = "team_queue";
/** A claimed row still `queued` after this long is swept to failed / delivery_unknown. */
export const CLAIM_TTL_MS = 15 * 60_000;

const UNIQUE_VIOLATION = "23505";

/** Our sending domain: MAIL_SENDING_DOMAIN, else the domain of the Retren mailbox (SMTP_USER). */
export function sendingDomain(env: Env = process.env): string {
  const smtpDomain = env.SMTP_USER?.trim().split("@")[1]?.toLowerCase();
  return env.MAIL_SENDING_DOMAIN?.trim() || smtpDomain || DEFAULT_SENDING_DOMAIN;
}

/**
 * Throws on a configuration that must never send: a malformed MAIL_REDIRECT_ALL_TO, or a real
 * provider outside production without one. Checked before any row is touched.
 */
export function assertSendConfig(providerName: string, env: Env): void {
  redirectRecipients([], env, providerName);
  // A malformed MAIL_OPERATOR_INBOXES throws here too, before any row is touched.
  operatorInboxes(env);
}

/** Who writes to the team queue: ids and reason codes only, never an address or a body. */
export async function queueForTeam(
  db: ServiceClient,
  caseId: string,
  data: { reason: string; message_id?: string; template?: string | null; action?: string },
): Promise<void> {
  const { error } = await db
    .from("case_events")
    .insert({ case_id: caseId, kind: TEAM_QUEUE_EVENT, data: { source: "outbound", ...data } });
  // Once per case, reason, message and action (unique index): a second writer is a no-op.
  if (error && error.code !== UNIQUE_VIOLATION) throw error;
}

type Row = {
  id: string;
  case_id: string | null;
  template: string | null;
  created_at: string;
};

/**
 * Sends one queued outbound row, or refuses it and marks it `failed` with the reason. Never
 * increments `send_count`: mail counts towards the cap when it is queued (C7).
 *
 * Exactly one caller gets to send a row: it is claimed first (send_claimed_at), so a second or
 * concurrent call answers `skipped: not_queued`. After the claim nothing throws: a failure before
 * the transport got the mail is `internal_error`; a failure after it may have accepted the mail
 * is `delivery_unknown`, never resent automatically. Both, and every refusal but `stale`, go to
 * the team queue. A row whose outcome couldn't even be written is swept by sendPending once its
 * claim expires (CLAIM_TTL_MS).
 */
export async function sendQueued(
  messageId: string,
  deps: OutboundDeps = {},
): Promise<SendQueuedResult> {
  const db = deps.db ?? createServiceClient();
  const env = deps.env ?? process.env;
  const providerName = deps.providerName ?? provider("MAIL_PROVIDER", env);
  // Configuration errors (SMTP vars, the redirect) throw here, before any row is touched.
  const transport = deps.transport ?? createMailTransport(env).transport;
  assertSendConfig(providerName, env);

  // The claim uses real time (not the business clock), so the expiry sweep is meaningful.
  const claimed = await db
    .from("messages")
    .update({ send_claimed_at: new Date().toISOString() })
    .eq("id", messageId)
    .eq("direction", "outbound")
    .eq("status", "queued")
    .is("send_claimed_at", null)
    .select("id, case_id, template, created_at");
  if (claimed.error) throw claimed.error;
  const row = claimed.data[0] as Row | undefined;
  if (!row) {
    const exists = await db.from("messages").select("id").eq("id", messageId).maybeSingle();
    if (exists.error) throw exists.error;
    return { status: "skipped", reason: exists.data ? "not_queued" : "not_found" };
  }

  const progress = { handedToTransport: false, kind: row.template };
  try {
    return await deliver(db, row, { ...deps, env, providerName, transport }, progress);
  } catch {
    const reason = progress.handedToTransport ? "delivery_unknown" : "internal_error";
    try {
      return await fail(db, row, progress.kind, reason);
    } catch {
      // Even the failure couldn't be written: the row stays claimed and the sweep takes it.
      return { status: "failed", reason };
    }
  }
}

async function deliver(
  db: ServiceClient,
  row: Row,
  deps: OutboundDeps & { env: Env; providerName: string; transport: ClaimsTransport },
  progress: { handedToTransport: boolean; kind: string | null },
): Promise<SendQueuedResult> {
  const { env, providerName, transport } = deps;
  const now = (deps.clock ?? systemClock).now();
  if (!row.case_id) return fail(db, row, row.template, "recipient_not_allowed");
  const caseId = row.case_id;

  const [full, kase, attachments, thread] = await Promise.all([
    db.from("messages").select("*").eq("id", row.id).single(),
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
  for (const r of [full, kase, attachments, thread]) if (r.error) throw r.error;
  const m = full.data!;
  const c = kase.data!;
  progress.kind = row.template ?? (await messageKind(db, caseId, row));

  const operator = effectiveOperator(getOperatorConfig(OperatorId.parse(c.operator)), env);
  const text = m.body_text ?? "";
  const recipient = checkRecipient({
    to: m.to_address,
    userEmail: c.user_email,
    operator,
    template: progress.kind,
  });
  const refusal = firstRefusal([
    checkMockText({ subject: m.subject, text }, providerName),
    recipient,
    checkAttachments(attachments.data!, caseId),
  ]);
  if (refusal) return fail(db, row, progress.kind, refusal);
  const toUser = recipient.ok && recipient.audience === "user";

  // The case thread. Operator mail: only what we sent the operator and what came from its
  // verified address (a spoofed [RTN-ref] mail from anyone else never counts). User mail: only
  // the user's own thread. They never mix.
  const norm = (a: string) => a.trim().toLowerCase();
  const user = norm(c.user_email);
  const operatorAddress = operator.channel.type === "email" ? norm(operator.channel.address) : null;
  // The operator's test inbox (DEV) counts as the operator here too: its replies are in the thread.
  const testInbox = operatorInboxes(env).get(OperatorId.parse(c.operator));
  const fromOperator = (x: { direction: string; from_address: string }) =>
    x.direction === "inbound" &&
    ((operatorAddress !== null && norm(x.from_address) === operatorAddress) ||
      (testInbox !== undefined && norm(x.from_address) === testInbox));
  const sentTo = (
    x: { direction: string; status: string; to_address: string },
    to: string | null,
  ) =>
    x.direction === "outbound" && x.status === "sent" && to !== null && norm(x.to_address) === to;
  const sameThread = thread.data!.filter((x) =>
    toUser
      ? sentTo(x, user) || (x.direction === "inbound" && norm(x.from_address) === user)
      : sentTo(x, operatorAddress) || fromOperator(x),
  );

  // The status re-check applies to timer reminders only (#26): C6's forwards and insistences
  // are reactions to a reply and never go stale because of one. Fail-closed: operator mail whose
  // kind can't be derived is checked like a reminder, and the team is told.
  if (!toUser && progress.kind === null) {
    await queueForTeam(db, caseId, { reason: "unknown_kind", message_id: row.id });
  }
  if (!toUser && (progress.kind === null || REMINDER_TEMPLATES.includes(progress.kind))) {
    const replies = thread.data!.filter(fromOperator).map((x) => x.created_at);
    replies.sort((a, b) => Date.parse(a) - Date.parse(b));
    const stale = isStale({
      caseStatus: c.status as CaseStatus,
      queuedAt: m.created_at,
      lastInboundAt: replies.at(-1) ?? null,
    });
    if (stale) return fail(db, row, progress.kind, "stale");
  }

  const mail = buildMailMessage(
    {
      from: m.from_address,
      to: m.to_address,
      subject: m.subject,
      text: text || m.subject,
      publicRef: c.public_ref,
      messageId: m.message_id ?? newMessageId(c.public_ref, sendingDomain(env)),
      thread: sameThread,
      inReplyTo: m.in_reply_to,
      attachments: attachments.data as AttachmentRow[],
      providerName,
      // Only operator mail may take the operator's test inbox; user notices always the redirect.
      operator: toUser ? undefined : OperatorId.parse(c.operator),
    },
    env,
  );

  // The attachments' bytes, read from private storage here: the transport never gets a path.
  const withContent: OutboundAttachment[] = [];
  for (const a of mail.attachments) {
    const bytes = await readAttachment(db, a.kind, a.storagePath);
    if (!bytes) return fail(db, row, progress.kind, "attachment_missing");
    withContent.push({ ...a, content: bytes });
  }

  let providerId: string;
  try {
    progress.handedToTransport = true;
    ({ providerId } = await transport.send({ ...mail, attachments: withContent }));
  } catch (error) {
    // transport_error only when nothing can have gone out (EAUTH, ECONNECTION, EENVELOPE, or
    // before connecting); otherwise the mail may have been delivered: delivery_unknown.
    const reason = transportFailure(error);
    if (reason === "transport_error") progress.handedToTransport = false;
    return fail(db, row, progress.kind, reason);
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
      template: progress.kind,
    })
    .eq("id", row.id)
    .eq("status", "queued")
    .select("id");
  if (done.error) throw done.error; // delivery_unknown
  if (done.data.length === 0) {
    // The sweep failed the row meanwhile (its claim looked stuck): it stays failed /
    // delivery_unknown. No message_sent, no purge: the team decides (C9).
    await queueForTeam(db, caseId, {
      reason: "delivery_unknown",
      message_id: row.id,
      template: progress.kind,
    });
    return { status: "failed", reason: "delivery_unknown" };
  }

  // The row is `sent`: from here on nothing may turn it into a failure.
  try {
    await event(db, caseId, MESSAGE_SENT_EVENT, { message_id: row.id, template: progress.kind });
  } catch {
    // The event is history only; the row already says `sent`.
  }
  // Only now that the mail is out (and marked sent): C6 deletes the forwarded user documents
  // linked to it (ARCHITECTURE §7.1). A failed send returned above, so the files stay for a retry.
  const purge =
    deps.purgeForwardedDocuments ?? ((id: string) => purgeForwardedDocuments(id, { db }));
  try {
    await purge(row.id);
  } catch {
    await queueForTeam(db, caseId, { reason: "purge_failed", message_id: row.id }).catch(() => {});
  }
  return { status: "sent", providerId };
}

/**
 * The kind (TemplateKind) of a row queued without one: from the case event that links it (C2's
 * and C6's `{template, message_id}`), else from C7's `timer_action` event written in the same
 * transaction (same created_at). Null when unknown.
 */
async function messageKind(db: ServiceClient, caseId: string, row: Row): Promise<string | null> {
  const linked = await db
    .from("case_events")
    .select("data")
    .eq("case_id", caseId)
    .eq("data->>message_id", row.id)
    .limit(10);
  if (linked.error) throw linked.error;
  for (const e of linked.data) {
    const t = (e.data as { template?: unknown }).template;
    if (typeof t === "string") return t;
  }
  const timer = await db
    .from("case_events")
    .select("data")
    .eq("case_id", caseId)
    .eq("kind", "timer_action")
    .eq("created_at", row.created_at)
    .limit(1);
  if (timer.error) throw timer.error;
  const action = (timer.data[0]?.data as { action?: unknown } | undefined)?.action;
  if (typeof action !== "string") return null;
  return action === "close_3m" ? "user_final_result" : action;
}

/**
 * Sends every queued, unclaimed outbound row, oldest first (at most `limit` per run), after
 * sweeping expired claims. What the tick calls after queueing; each row goes through sendQueued.
 * `caseIds` limits it to some cases (tests, the team view).
 */
export async function sendPending(
  deps: OutboundDeps = {},
  opts: { limit?: number; caseIds?: string[] } = {},
): Promise<{ messageId: string; result: SendQueuedResult }[]> {
  const db = deps.db ?? createServiceClient();
  const env = deps.env ?? process.env;
  const providerName = deps.providerName ?? provider("MAIL_PROVIDER", env);
  assertSendConfig(providerName, env);
  const transport = deps.transport ?? createMailTransport(env).transport;
  const out: { messageId: string; result: SendQueuedResult }[] = [];

  for (const id of await expireClaims(db, opts.caseIds)) {
    out.push({ messageId: id, result: { status: "failed", reason: "delivery_unknown" } });
  }

  let q = db
    .from("messages")
    .select("id")
    .eq("direction", "outbound")
    .eq("status", "queued")
    .is("send_claimed_at", null)
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 100);
  if (opts.caseIds) q = q.in("case_id", opts.caseIds);
  const pending = await q;
  if (pending.error) throw pending.error;

  for (const { id } of pending.data) {
    try {
      out.push({
        messageId: id,
        result: await sendQueued(id, { ...deps, db, env, providerName, transport }),
      });
    } catch {
      // One row never stops the batch; sendQueued already recorded what it could.
      out.push({ messageId: id, result: { status: "failed", reason: "internal_error" } });
    }
  }
  return out;
}

/** Claimed rows still `queued` after CLAIM_TTL_MS: failed / delivery_unknown, never resent. */
async function expireClaims(db: ServiceClient, caseIds?: string[]): Promise<string[]> {
  const cutoff = new Date(Date.now() - CLAIM_TTL_MS).toISOString();
  let q = db
    .from("messages")
    .update({ status: "failed", failure_reason: "delivery_unknown" })
    .eq("direction", "outbound")
    .eq("status", "queued")
    .lt("send_claimed_at", cutoff);
  if (caseIds) q = q.in("case_id", caseIds);
  const expired = await q.select("id, case_id, template");
  if (expired.error) throw expired.error;
  for (const r of expired.data) {
    if (!r.case_id) continue;
    await event(db, r.case_id, MESSAGE_FAILED_EVENT, {
      message_id: r.id,
      template: r.template,
      reason: "delivery_unknown",
    });
    await queueForTeam(db, r.case_id, {
      reason: "delivery_unknown",
      message_id: r.id,
      template: r.template,
    });
  }
  return expired.data.map((r) => r.id);
}

/** The private buckets attachments live in; storage_path is `<bucket>/<key>`. */
const BUCKETS = [TICKET_BUCKET, DOCUMENTS_BUCKET, USER_DOCUMENTS_BUCKET] as const;

/**
 * Where an attachment's file is: `<bucket>/<key>` for the case's documents and its ticket. C6
 * stores a user document as a bare key in its own bucket.
 */
export function attachmentLocation(
  kind: string,
  storagePath: string,
): { bucket: string; key: string } | null {
  for (const bucket of BUCKETS) {
    if (storagePath.startsWith(`${bucket}/`)) {
      return { bucket, key: storagePath.slice(bucket.length + 1) };
    }
  }
  return kind === "user_document" ? { bucket: USER_DOCUMENTS_BUCKET, key: storagePath } : null;
}

async function readAttachment(
  db: ServiceClient,
  kind: string,
  storagePath: string,
): Promise<Uint8Array | null> {
  const where = attachmentLocation(kind, storagePath);
  if (!where) return null;
  const file = await db.storage.from(where.bucket).download(where.key);
  if (file.error || !file.data) return null;
  return new Uint8Array(await file.data.arrayBuffer());
}

function firstRefusal(checks: { ok: boolean; reason?: OutboundRefusal }[]) {
  return checks.find((c) => !c.ok)?.reason ?? null;
}

/**
 * Marks a claimed row failed with its reason, and tells the team about anything but a stale
 * reminder (an expected outcome): a failed initial claim or operator mail is never retried
 * automatically; C9 offers a manual resend.
 */
async function fail(
  db: ServiceClient,
  row: Row,
  kind: string | null,
  reason: OutboundRefusal,
): Promise<SendQueuedResult> {
  const upd = await db
    .from("messages")
    .update({ status: "failed", failure_reason: reason, template: kind })
    .eq("id", row.id)
    .eq("status", "queued");
  if (upd.error) throw upd.error;
  if (row.case_id) {
    await event(db, row.case_id, MESSAGE_FAILED_EVENT, {
      message_id: row.id,
      template: kind,
      reason,
    });
    if (reason !== "stale") {
      await queueForTeam(db, row.case_id, { reason, message_id: row.id, template: kind });
    }
  }
  return { status: "failed", reason };
}

/** Case events hold ids and reasons only, never an address or a body. */
async function event(
  db: ServiceClient,
  caseId: string,
  kind: string,
  data: Record<string, string | null>,
): Promise<void> {
  const { error } = await db
    .from("case_events")
    .insert({ case_id: caseId, kind, data: data as NonNullable<Json> });
  if (error) throw error;
}
