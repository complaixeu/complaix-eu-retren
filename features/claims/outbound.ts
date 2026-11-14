// The outbound safety rules (docs/plans/README.md §4.3, docs/plans/C-claims.md C3). Pure: no DB,
// no clock, no network. The sender (./send-queued.ts) applies them to every queued row, whoever
// queued it (initial claim, C6 actions, C7 timers, C8 notices). Internal to domain C.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CaseStatus, MailMessage, OperatorPublicConfig } from "@/shared/contracts";
import { provider } from "@/shared/providers";
import { MAX_SENDS_PER_CASE } from "./timers";

type Env = Record<string, string | undefined>;

export type OutboundRefusal =
  | "recipient_not_allowed"
  | "operator_inactive"
  | "attachment_not_allowed"
  | "stale"
  | "mock_text"
  | "attachment_missing"
  | "transport_error"
  // Something failed after the row was claimed, before the transport got the mail.
  | "internal_error"
  // The transport may have accepted the mail but the outcome wasn't recorded (a write failed, or
  // a claim expired). Never resent automatically: the team decides (C9).
  | "delivery_unknown";

/** The mails the status re-check applies to (#26): the timer reminders, nothing else. */
export const REMINDER_TEMPLATES: readonly string[] = Object.freeze([
  "reminder_d12",
  "reminder_d30",
  "last_notice_d40",
]);

export type Check = { ok: true } | { ok: false; reason: OutboundRefusal };

const normalise = (address: string) => address.trim().toLowerCase();

// ---------------------------------------------------------------------------------------------
// Recipient allowlist

export type Audience = "operator" | "user";

/**
 * Extension point for C8 (user notices): the kinds of mail the user may receive (ARCHITECTURE
 * §7: a document request, the final result, the escalation exception). Until C8 lands every
 * kind is allowed, but only to the case's own user (checkRecipient).
 */
export function userMailAllowed(template: string | null | undefined): boolean {
  void template; // TODO(C8): enforce the kinds allowlist here.
  return true;
}

/**
 * Who a row may go to. The case's own user (only that exact address), or the operator's
 * verified address from its config (email channel only, and only while the operator is active).
 * Any other address is refused: nothing in an operator reply can add a recipient.
 */
export function checkRecipient(input: {
  to: string;
  userEmail: string;
  operator: OperatorPublicConfig;
  template?: string | null;
}): { ok: true; audience: Audience } | { ok: false; reason: OutboundRefusal } {
  const to = normalise(input.to);
  if (!to) return { ok: false, reason: "recipient_not_allowed" };
  if (to === normalise(input.userEmail)) {
    return userMailAllowed(input.template)
      ? { ok: true, audience: "user" }
      : { ok: false, reason: "recipient_not_allowed" };
  }
  const { channel } = input.operator;
  if (channel.type !== "email" || to !== normalise(channel.address)) {
    return { ok: false, reason: "recipient_not_allowed" };
  }
  if (!input.operator.active) return { ok: false, reason: "operator_inactive" };
  return { ok: true, audience: "operator" };
}

// ---------------------------------------------------------------------------------------------
// Attachment allowlist

/** EU form, mandate, ticket and the documents the user sent for that case (README §4.3). */
export const ATTACHMENT_ALLOWLIST = Object.freeze([
  "eu_form",
  "mandate",
  "ticket",
  "user_document",
] as const);

export function checkAttachments(
  attachments: readonly { kind: string; case_id: string; deleted_at: string | null }[],
  caseId: string,
): Check {
  const allowed: readonly string[] = ATTACHMENT_ALLOWLIST;
  for (const a of attachments) {
    if (!allowed.includes(a.kind) || a.case_id !== caseId || a.deleted_at !== null) {
      return { ok: false, reason: "attachment_not_allowed" };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// MAIL_REDIRECT_ALL_TO

/**
 * There is no production (CLAUDE.md §1). Only an explicit RETREN_ENV=production turns the
 * redirect off; NODE_ENV and VERCEL_ENV never do (a DEV build is a "production" build).
 */
export function isProduction(env: Env = process.env): boolean {
  return env.RETREN_ENV === "production";
}

/** Outside production every recipient is replaced by MAIL_REDIRECT_ALL_TO when it is set. */
export function redirectRecipients(
  to: readonly string[],
  env: Env = process.env,
  providerName: string = provider("MAIL_PROVIDER", env),
): string[] {
  if (isProduction(env)) return [...to];
  const redirect = env.MAIL_REDIRECT_ALL_TO?.trim();
  if (!redirect) {
    // Fail safe: outside production a real provider never sends without the redirect.
    if (providerName !== "fake") {
      throw new Error(
        `MAIL_PROVIDER=${providerName} outside production needs MAIL_REDIRECT_ALL_TO`,
      );
    }
    return [...to];
  }
  if (!z.email().safeParse(redirect).success) {
    // Never fall back to the real recipient because of a typo in the redirect.
    throw new Error("MAIL_REDIRECT_ALL_TO is not a valid email address");
  }
  return [redirect];
}

// ---------------------------------------------------------------------------------------------
// Threading

/** `[RTN-<ref>]` in the subject, exactly once. */
export function subjectWithRef(subject: string, publicRef: string): string {
  const tag = `[${publicRef}]`;
  return subject.includes(tag) ? subject : `${tag} ${subject}`;
}

/** A new RFC 5322 Message-ID in our sending domain that names the case. */
export function newMessageId(publicRef: string, domain: string): string {
  return `<${publicRef.toLowerCase()}.${randomUUID()}@${domain}>`;
}

export type ThreadMessage = { message_id: string | null; created_at: string };

/**
 * In-Reply-To and References from the case thread (the mails already sent or received in it):
 * In-Reply-To is the latest one, References all of them, oldest first. The first mail of a
 * thread has neither.
 */
export function threadHeaders(thread: readonly ThreadMessage[]): {
  inReplyTo?: string;
  references?: string[];
} {
  const ids = [...thread]
    .filter((m): m is { message_id: string; created_at: string } => !!m.message_id)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .map((m) => m.message_id);
  if (!ids.length) return {};
  return { inReplyTo: ids[ids.length - 1], references: ids };
}

// ---------------------------------------------------------------------------------------------
// Status re-check

/** Statuses after which nothing more goes to the operator. */
const STOPPED: readonly CaseStatus[] = ["resolved", "closed"];

/**
 * Operator mail queued earlier (a reminder, an escalation) is stale when the case stopped since:
 * it was resolved or closed, or a reply arrived after the row was queued.
 */
export function isStale(input: {
  caseStatus: CaseStatus;
  queuedAt: string;
  lastInboundAt: string | null;
}): boolean {
  if (STOPPED.includes(input.caseStatus)) return true;
  return (
    input.lastInboundAt !== null && Date.parse(input.lastInboundAt) > Date.parse(input.queuedAt)
  );
}

// ---------------------------------------------------------------------------------------------
// Mock template text

/**
 * The documents mock (features/documents/mock.ts) has no marker: its text starts with "mock ".
 * TODO(B6): when the real templates land, keep this check (it then simply never matches).
 */
export function looksLikeMockText(text: string): boolean {
  return /^\s*mock /i.test(text);
}

/** Mock template text never goes out through a provider other than the fake. */
export function checkMockText(
  mail: { subject: string; text: string },
  providerName: string,
): Check {
  if (providerName === "fake") return { ok: true };
  return looksLikeMockText(mail.subject) || looksLikeMockText(mail.text)
    ? { ok: false, reason: "mock_text" }
    : { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The initial claim

export type InitialClaimRefusal =
  | "case_not_found"
  | "not_waiting_period"
  | "no_earliest_send_at"
  | "too_early"
  | "send_cap_reached"
  | "operator_inactive"
  | "operator_has_no_email_channel"
  | "ticket_missing"
  | "mock_text";

/**
 * The initial claim may be queued only while `send_count` is below this. The last of the
 * MAX_SENDS_PER_CASE slots is reserved for the d45 escalation (tracker #26, C7 decision), like
 * for reminders, the insistence and forwarded documents.
 */
export const INITIAL_CLAIM_SEND_LIMIT = MAX_SENDS_PER_CASE - 1;

/**
 * Why the initial claim can't go out now, or null. claims_send_initial_claim checks the case
 * part again under a row lock; the operator part (config) is only known here.
 */
export function initialClaimRefusal(
  c: { status: CaseStatus; earliestSendAt: string | null; sendCount: number },
  operator: OperatorPublicConfig,
  now: Date,
): InitialClaimRefusal | null {
  if (c.status !== "waiting_period") return "not_waiting_period";
  if (!operator.active) return "operator_inactive";
  if (operator.channel.type !== "email") return "operator_has_no_email_channel";
  if (c.earliestSendAt === null) return "no_earliest_send_at";
  if (Date.parse(c.earliestSendAt) > now.getTime()) return "too_early";
  if (c.sendCount >= INITIAL_CLAIM_SEND_LIMIT) return "send_cap_reached";
  return null;
}

// ---------------------------------------------------------------------------------------------
// The mail

export type AttachmentRow = {
  kind: MailMessage["attachments"][number]["kind"];
  filename: string;
  content_type: string;
  storage_path: string;
};

/** The mail the transport gets: threaded, tagged with the case, redirected outside production. */
export function buildMailMessage(
  input: {
    from: string;
    to: string;
    subject: string;
    text: string;
    publicRef: string;
    messageId: string;
    thread: readonly ThreadMessage[];
    attachments: readonly AttachmentRow[];
    /** An In-Reply-To the row already has (kept as is; the thread only fills a missing one). */
    inReplyTo?: string | null;
    providerName?: string;
  },
  env: Env = process.env,
): MailMessage {
  const thread = threadHeaders(input.thread);
  const inReplyTo = input.inReplyTo || thread.inReplyTo;
  return {
    from: input.from,
    to: redirectRecipients([input.to], env, input.providerName),
    subject: subjectWithRef(input.subject, input.publicRef),
    text: input.text,
    messageId: input.messageId,
    ...(inReplyTo && { inReplyTo }),
    ...(thread.references && { references: thread.references }),
    attachments: input.attachments.map((a) => ({
      kind: a.kind,
      filename: a.filename,
      contentType: a.content_type,
      storagePath: a.storage_path,
    })),
  };
}
