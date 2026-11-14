// Inbound mail (docs/plans/C-claims.md C4, docs/plans/README.md §4.1). Internal to domain C.
//
// ingestMessage(raw) is the one entry point for incoming mail: pollInbox (./poll-inbox.ts) calls
// it for each mail it reads, and the team's simulated mailbox (C9) calls the same function.
//
// Only claim mail is kept. A mail that neither threads onto our own sent mail nor carries an
// [RTN-…] reference is skipped: nothing stored, nothing logged. Our own mail and redirected
// copies are skipped too. Everything else is recorded with its raw MIME in private storage, and:
// - an operator reply (threaded onto our mail, from the operator's domain, no foreign reference)
//   gets `operator_replied`, is classified (C5) and acted on (C6's applyReplyCategory);
// - the case user's reply with a document while the case waits on them is stored and forwarded
//   (C6's forwardUserDocument), to the operator's verified address only;
// - anything else that is ours (a wrong sender, an unknown or spoofed reference, a reply the state
//   machine refuses, any other mail from the user) goes to the team queue, never classified.
// No address found inside a mail is ever used as a recipient: mail goes out only through C6/C3,
// to the addresses they derive from the case and the operator config.
import { createHash, randomUUID } from "node:crypto";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
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
import {
  OPERATOR_MAIL_FROM,
  USER_DOCUMENTS_BUCKET,
  applyReplyCategory as c6ApplyReplyCategory,
  forwardUserDocument as c6ForwardUserDocument,
} from "./actions";
import { createClassifier, type ReplyClassifier } from "./classifier";
import { DEFAULT_NOTICE_FROM } from "./create-case";
import { operatorInboxes, type OperatorInboxes } from "./operator-inboxes";
import { InvalidTransitionError, transition } from "./state-machine";

type Env = Record<string, string | undefined>;

/** Private bucket of the raw MIME of every inbound mail we keep (migration *_claims_inbound.sql). */
export const RAW_MAIL_BUCKET = "claims-inbound-mail";
/** The bucket's size limit; a bigger mail is recorded without its raw copy. */
const RAW_MAIL_LIMIT = 50 * 1024 * 1024;
/** The user documents C6 accepts (its bucket's limits). */
const USER_DOCUMENT_TYPES = ["application/pdf", "image/jpeg", "image/png"];
const USER_DOCUMENT_LIMIT = 10 * 1024 * 1024;
/** Most of a body kept in messages.body_text. */
const BODY_LIMIT = 200_000;
const MAX_ATTEMPTS = 3;

/** Why a mail went to the team queue. Codes only, no personal data. */
export type InboundQueueReason =
  | "unknown_reference"
  | "spoofed_reference"
  | "wrong_sender"
  | "invalid_transition"
  | "user_reply"
  | "user_document_not_allowed"
  | "forward_failed"
  | "action_failed";

/** What happened to one mail. Ids and codes only: safe to return from the tick. */
export type IngestResult =
  | { outcome: "skipped"; reason: "unparseable" | "own_mail" | "redirected_copy" | "unrelated" }
  | { outcome: "duplicate"; messageId: string }
  | {
      outcome: "applied";
      caseId: string;
      messageId: string;
      category: ReplyCategory;
      status: CaseStatus;
    }
  | { outcome: "forwarded"; caseId: string; messageId: string }
  | {
      outcome: "team_queue";
      caseId: string | null;
      messageId: string;
      reason: InboundQueueReason | "send_cap";
    }
  /** Something on our side failed (database, storage): retry later, the mail is not lost. */
  | { outcome: "error"; reason: "database" | "storage" };

export interface IngestDeps {
  /** Service-role client; created from env when left out. */
  db?: ServiceClient;
  /** For SMTP_USER, IMAP_USER, MAIL_FROM, MAIL_REDIRECT_ALL_TO; process.env when left out. */
  env?: Env;
  clock?: Clock;
  /** C5's classifier, built once; the default one (from env) when left out. */
  classifier?: ReplyClassifier;
  getOperatorConfig?: (id: OperatorId) => OperatorPublicConfig;
  applyReplyCategory?: typeof c6ApplyReplyCategory;
  forwardUserDocument?: typeof c6ForwardUserDocument;
}

// ---------------------------------------------------------------------------------------------
// Parsing (pure)

export interface ParsedInbound {
  from: string;
  to: string[];
  subject: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  text: string;
  attachments: { filename: string; contentType: string; content: Buffer; size: number }[];
  /** Every Authentication-Results header, topmost first, unfolded. */
  authResults: string[];
}

const lower = (s: string) => s.trim().toLowerCase();

function addresses(field: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(field) ? field : field ? [field] : [];
  return list.flatMap((a) => a.value).flatMap((v) => (v.address ? [lower(v.address)] : []));
}

/** Every `<…>` Message-ID in a header value (In-Reply-To, References), in order. */
function messageIds(value: string | string[] | undefined): string[] {
  const text = Array.isArray(value) ? value.join(" ") : (value ?? "");
  return [...text.matchAll(/<[^<>\s]+>/g)].map((m) => m[0]);
}

/** Every occurrence of a header, in the order it appears (topmost first), unfolded. */
function headerLines(mail: ParsedMail, name: string): string[] {
  const key = name.toLowerCase();
  return (mail.headerLines ?? [])
    .filter((h) => h.key.toLowerCase() === key)
    .map((h) =>
      h.line
        .slice(h.line.indexOf(":") + 1)
        .replace(/\r?\n[ \t]+/g, " ")
        .trim(),
    );
}

function headerText(mail: ParsedMail, name: string): string[] {
  const v = mail.headers.get(name);
  if (v === undefined) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
}

/**
 * Parses the MIME (mailparser). Null when the mail can't be used at all: no sender. Never throws.
 * A mail without a Message-ID gets one derived from its bytes, so the same mail is stored once.
 */
export async function parseInbound(
  raw: Buffer | Uint8Array | string,
): Promise<ParsedInbound | null> {
  try {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (bytes.length === 0) return null;
    const mail = await simpleParser(bytes, { skipHtmlToText: false });
    const from = addresses(mail.from)[0];
    if (!from) return null;
    const own = messageIds(mail.messageId)[0];
    const messageId =
      own ?? `<${createHash("sha256").update(bytes).digest("hex")}@inbound.invalid>`;
    // Delivered-To / X-Original-To tell where the copy really went (a redirected copy).
    const delivered = [...headerText(mail, "delivered-to"), ...headerText(mail, "x-original-to")]
      .flatMap((h) => h.match(/[^\s<>,"]+@[^\s<>,"]+/g) ?? [])
      .map(lower);
    return {
      from,
      to: [...new Set([...addresses(mail.to), ...addresses(mail.cc), ...delivered])],
      subject: mail.subject ?? "",
      messageId,
      inReplyTo: messageIds(mail.inReplyTo)[0] ?? null,
      references: messageIds(mail.references),
      authResults: headerLines(mail, "authentication-results"),
      text: (mail.text ?? "").slice(0, BODY_LIMIT),
      attachments: (mail.attachments ?? [])
        // Inline parts of an HTML body (logos, signatures) are not documents.
        .filter((a) => !a.related)
        .map((a) => ({
          filename: a.filename ?? "documento",
          contentType: lower(a.contentType ?? "application/octet-stream"),
          content: a.content,
          size: a.size ?? a.content.length,
        })),
    };
  } catch {
    return null;
  }
}

/** Every [RTN-…] reference in a subject, upper-cased, once each. */
export function refsInSubject(subject: string): string[] {
  const refs = [...subject.matchAll(/\[(RTN-[A-Z0-9]+)\]/gi)].map((m) => m[1].toUpperCase());
  return [...new Set(refs)];
}

/** Our own mailbox and sender addresses. */
function ownAddresses(env: Env): Set<string> {
  return new Set(
    [env.SMTP_USER, env.IMAP_USER, env.MAIL_FROM, OPERATOR_MAIL_FROM, DEFAULT_NOTICE_FROM]
      .filter((a): a is string => !!a?.trim())
      .map(lower),
  );
}

/** Mail we must never read: sent from our own address, or a copy addressed to the redirect. */
export function isOwnMail(
  mail: { from: string; to: string[] },
  env: Env,
): "own_mail" | "redirected_copy" | null {
  if (ownAddresses(env).has(lower(mail.from))) return "own_mail";
  const redirect = env.MAIL_REDIRECT_ALL_TO?.trim();
  if (redirect && mail.to.map(lower).includes(lower(redirect))) return "redirected_copy";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Routing (pure)

export interface InboundCase {
  id: string;
  public_ref: string;
  operator: OperatorId;
  status: CaseStatus;
  user_email: string;
}

export interface RouteInput {
  from: string;
  /** The [RTN-…] references in the subject. */
  refs: string[];
  /** The case whose own sent mail this threads onto (In-Reply-To / References), if any. */
  threadCase: InboundCase | null;
  /** The cases the references name (only the ones that exist). */
  refCases: InboundCase[];
  hasAttachment: boolean;
  /** The domain of the thread case operator's verified address; null without an email channel. */
  operatorDomain: string | null;
  /** The same for the case the subject's reference names (refCases[0]). */
  refOperatorDomain: string | null;
  /**
   * The operator's test inbox (MAIL_OPERATOR_INBOXES, outside production) for the thread case, and
   * for refCases[0]: a mail from it counts as the operator's only with an aligned DKIM pass for
   * the inbox's own domain (inboxVouched). Never on the From header alone.
   */
  operatorInbox?: string | null;
  refOperatorInbox?: string | null;
  /** The domains with an aligned dkim=pass in the receiving server's own Authentication-Results. */
  dkimPassDomains: string[];
}

export type Route =
  | { kind: "skip" }
  | { kind: "operator"; case: InboundCase }
  | { kind: "user_document"; case: InboundCase }
  | { kind: "queue"; case: InboundCase | null; reason: InboundQueueReason };

/** The receiving server's authserv-id: only its own Authentication-Results header is trusted. */
export const DEFAULT_AUTHSERV_ID = "mx.google.com";

/**
 * The domains a DKIM signature that passed vouches for (`header.d`, or the domain of `header.i`),
 * read from the receiving server's own Authentication-Results header only.
 *
 * Anyone can write an Authentication-Results header into a mail they send. The receiving server
 * (Gmail) adds its own on top of the mail, so only the topmost header is trusted, and only when it
 * names that server (`authservId`). Anything else gives no domain at all.
 *
 * RESIDUAL RISK: "topmost" assumes Gmail really prepends its own header to every mail it receives.
 * Mail that did not arrive over SMTP (imported, or created inside the mailbox) may carry no header
 * of Gmail's, and then the topmost one is whatever its sender wrote: an attacker could forge
 * `mx.google.com; dkim=pass header.d=<operator domain>`. That needs a mail in the mailbox without
 * Gmail's own header, which SMTP delivery doesn't allow; keep it that way (never import or
 * forward mail into this mailbox). Even then the mail only reaches the classifier and C6's
 * template actions: nothing it says is ever used as a recipient.
 */
export function dkimPassDomains(authResults: readonly string[], authservId: string): string[] {
  const top = authResults[0];
  if (!top) return [];
  const [id, ...results] = top.split(";");
  if (lower(id.trim().split(/\s+/)[0] ?? "") !== lower(authservId)) return [];
  const domains = results.flatMap((r) => {
    if (!/^\s*dkim\s*=\s*pass\b/i.test(r)) return [];
    const d = /\bheader\.d\s*=\s*"?([^\s;"]+)/i.exec(r)?.[1];
    const i = /\bheader\.i\s*=\s*"?([^\s;"]+)/i.exec(r)?.[1];
    const domain = d ?? i?.split("@").pop();
    return domain ? [lower(domain)] : [];
  });
  return [...new Set(domains)];
}

/** DKIM relaxed alignment: the signing domain is the domain itself or one of its subdomains. */
function aligned(signing: string, domain: string): boolean {
  return signing === domain || signing.endsWith(`.${domain}`);
}

/**
 * Whether `from` is the operator's test inbox (MAIL_OPERATOR_INBOXES, for that operator only) AND
 * the receiving server vouched for the inbox's own domain: an aligned DKIM pass. The From header
 * alone proves nothing (anyone can write it), so a forged From without that pass is not the inbox.
 */
function inboxVouched(
  from: string,
  inbox: string | null | undefined,
  dkimPassDomains: readonly string[],
): boolean {
  if (!inbox || lower(from) !== lower(inbox)) return false;
  const inboxDomain = lower(inbox.split("@")[1] ?? "");
  return dkimPassDomains.some((d) => aligned(lower(d), inboxDomain));
}

/**
 * Where a mail goes. The From header alone is never trusted: anyone can write any From. A mail is
 * linked to a case only
 * - by threading onto our own sent mail (In-Reply-To / References onto our Message-IDs), or
 * - by its subject reference alone when it names exactly one existing case, the sender is in that
 *   case operator's domain, and the receiving server saw a DKIM signature pass for that domain
 *   (an operator's ticketing system often starts a new thread, keeping only the reference).
 * Any other combination is `spoofed_reference`; a reference that names no case is
 * `unknown_reference`. Both go to the team queue, never classified.
 */
export function decideRoute(r: RouteInput): Route {
  if (!r.threadCase) {
    if (r.refs.length === 0) return { kind: "skip" };
    if (r.refCases.length === 0) return { kind: "queue", case: null, reason: "unknown_reference" };
    const c = r.refCases[0];
    const opDomain = r.refOperatorDomain ? lower(r.refOperatorDomain) : null;
    const viaDkim =
      opDomain !== null &&
      lower(r.from).split("@")[1] === opDomain &&
      r.dkimPassDomains.some((d) => aligned(lower(d), opDomain));
    const trusted =
      r.refs.length === 1 &&
      r.refCases.length === 1 &&
      (viaDkim || inboxVouched(r.from, r.refOperatorInbox, r.dkimPassDomains));
    if (!trusted) return { kind: "queue", case: c, reason: "spoofed_reference" };
    return { kind: "operator", case: c };
  }
  const c = r.threadCase;
  if (r.refs.some((ref) => ref !== c.public_ref)) {
    return { kind: "queue", case: c, reason: "spoofed_reference" };
  }
  if (lower(r.from) === lower(c.user_email)) {
    if (c.status === "waiting_user" && r.hasAttachment) return { kind: "user_document", case: c };
    return { kind: "queue", case: c, reason: "user_reply" };
  }
  const domain = lower(r.from).split("@")[1];
  const fromDomain = !!r.operatorDomain && domain === lower(r.operatorDomain);
  if (!fromDomain && !inboxVouched(r.from, r.operatorInbox, r.dkimPassDomains)) {
    return { kind: "queue", case: c, reason: "wrong_sender" };
  }
  return { kind: "operator", case: c };
}

// ---------------------------------------------------------------------------------------------
// ingestMessage

class InboundDbError extends Error {
  constructor(
    readonly step: string,
    readonly code: string | undefined,
  ) {
    super(`claims inbound: ${step} failed`);
    this.name = "InboundDbError";
  }
}
class InboundStorageError extends Error {}

const CASE_COLUMNS = "id, public_ref, operator, status, user_email";

let defaultClassifier: ReplyClassifier | undefined;

function operatorDomainOf(config: OperatorPublicConfig): string | null {
  return config.channel.type === "email" ? lower(config.channel.address.split("@")[1]) : null;
}

/** The storage key of a mail's raw copy: no personal data, the same for the same Message-ID. */
export function rawMailKey(messageId: string): string {
  return `${createHash("sha256").update(messageId).digest("hex")}.eml`;
}

/**
 * Ingests one raw inbound mail. Bad mail is skipped, anything ours that can't be acted on goes to
 * the team queue, and a failure on our side answers `error` (nothing is lost: the caller reads the
 * mail again later, and a stored Message-ID is never acted on twice). It throws only on a
 * malformed MAIL_OPERATOR_INBOXES, before anything is stored: a configuration error, like the
 * redirect's.
 */
export async function ingestMessage(
  raw: Buffer | Uint8Array | string,
  deps: IngestDeps = {},
): Promise<IngestResult> {
  const mail = await parseInbound(raw);
  if (!mail) return { outcome: "skipped", reason: "unparseable" };
  const env = deps.env ?? process.env;
  const own = isOwnMail(mail, env);
  if (own) return { outcome: "skipped", reason: own };
  const inboxes = operatorInboxes(env);

  try {
    const db = deps.db ?? createServiceClient();
    return await ingest(db, raw, mail, { ...deps, env, inboxes });
  } catch (e) {
    return { outcome: "error", reason: e instanceof InboundStorageError ? "storage" : "database" };
  }
}

async function ingest(
  db: ServiceClient,
  raw: Buffer | Uint8Array | string,
  mail: ParsedInbound,
  deps: IngestDeps & { env: Env; inboxes: OperatorInboxes },
): Promise<IngestResult> {
  const configOf = deps.getOperatorConfig ?? rulesOperatorConfig;

  // A copy of a mail we sent (same Message-ID) is ours; one we already stored is a duplicate.
  const existing = await db
    .from("messages")
    .select("id, direction, case_id, category, inbound_queue_reason")
    .eq("message_id", mail.messageId)
    .maybeSingle();
  if (existing.error) throw new InboundDbError("read message", existing.error.code);
  if (existing.data?.direction === "outbound") return { outcome: "skipped", reason: "own_mail" };
  if (existing.data) return resumeOrDuplicate(db, mail, existing.data, deps);

  // Threading onto our own sent mail is the only trusted link to a case.
  const threadIds = [
    ...new Set([mail.inReplyTo, ...mail.references].filter((x): x is string => !!x)),
  ];
  let threadCase: InboundCase | null = null;
  if (threadIds.length) {
    const ours = await db
      .from("messages")
      .select("case_id, created_at")
      .eq("direction", "outbound")
      .in("message_id", threadIds)
      .not("case_id", "is", null)
      .order("created_at", { ascending: false });
    if (ours.error) throw new InboundDbError("read thread", ours.error.code);
    const caseIds = [...new Set(ours.data.map((m) => m.case_id as string))];
    if (caseIds.length) {
      // Threads onto more than one case: the latest mail wins, and any other case's reference
      // in the subject makes it spoofed below.
      threadCase = await readCase(db, caseIds[0]);
    }
  }

  const refs = refsInSubject(mail.subject);
  let refCases: InboundCase[] = [];
  if (refs.length) {
    const found = await db.from("cases").select(CASE_COLUMNS).in("public_ref", refs);
    if (found.error) throw new InboundDbError("read cases", found.error.code);
    refCases = found.data as InboundCase[];
  }

  const route = decideRoute({
    from: mail.from,
    refs,
    threadCase,
    refCases,
    hasAttachment: mail.attachments.length > 0,
    operatorDomain: threadCase ? operatorDomainOf(configOf(threadCase.operator)) : null,
    refOperatorDomain: refCases[0] ? operatorDomainOf(configOf(refCases[0].operator)) : null,
    operatorInbox: threadCase ? (deps.inboxes.get(threadCase.operator) ?? null) : null,
    refOperatorInbox: refCases[0] ? (deps.inboxes.get(refCases[0].operator) ?? null) : null,
    dkimPassDomains: dkimPassDomains(
      mail.authResults,
      deps.env.MAIL_AUTHSERV_ID?.trim() || DEFAULT_AUTHSERV_ID,
    ),
  });
  // Unrelated mail: nothing stored, nothing logged.
  if (route.kind === "skip") return { outcome: "skipped", reason: "unrelated" };

  const rawPath = await storeRaw(db, raw, mail.messageId);
  const message = {
    from: mail.from,
    to: mail.to[0] ?? "",
    subject: mail.subject,
    message_id: mail.messageId,
    in_reply_to: mail.inReplyTo,
    references: mail.references,
    body_text: mail.text,
    raw_path: rawPath,
  };

  if (route.kind === "queue") {
    const rec = await record(db, message, route.case?.id ?? null, null, null, route.reason);
    if (rec.duplicate) return { outcome: "duplicate", messageId: rec.id };
    return {
      outcome: "team_queue",
      caseId: route.case?.id ?? null,
      messageId: rec.id,
      reason: route.reason,
    };
  }

  if (route.kind === "user_document") return userDocument(db, mail, message, route.case, deps);

  return operatorReply(db, mail, message, route.case, deps);
}

/**
 * A Message-ID already stored is never acted on twice. The one exception is a run that crashed
 * between recording an operator reply (`operator_replied`) and acting on it: the reply has no
 * category and nothing in the team queue yet, so it is classified and acted on now, once.
 */
async function resumeOrDuplicate(
  db: ServiceClient,
  mail: ParsedInbound,
  row: {
    id: string;
    case_id: string | null;
    category: string | null;
    inbound_queue_reason: string | null;
  },
  deps: IngestDeps & { env: Env },
): Promise<IngestResult> {
  const duplicate: IngestResult = { outcome: "duplicate", messageId: row.id };
  if (!row.case_id || row.category !== null || row.inbound_queue_reason !== null) return duplicate;
  const events = await db
    .from("case_events")
    .select("kind")
    .eq("case_id", row.case_id)
    .eq("data->>message_id", row.id)
    .in("kind", ["operator_replied", "team_queue", "reply_action"]);
  if (events.error) throw new InboundDbError("read events", events.error.code);
  const kinds = events.data.map((e) => e.kind);
  if (!kinds.includes("operator_replied") || kinds.length > 1) return duplicate;
  return classifyAndAct(db, mail, await readCase(db, row.case_id), row.id, deps);
}

async function readCase(db: ServiceClient, id: string): Promise<InboundCase> {
  const { data, error } = await db.from("cases").select(CASE_COLUMNS).eq("id", id).single();
  if (error) throw new InboundDbError("read case", error.code);
  return data as InboundCase;
}

/** Stores the raw MIME privately; the same Message-ID always lands on the same key. */
async function storeRaw(
  db: ServiceClient,
  raw: Buffer | Uint8Array | string,
  messageId: string,
): Promise<string | null> {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (bytes.length > RAW_MAIL_LIMIT) return null;
  const key = rawMailKey(messageId);
  const { error } = await db.storage
    .from(RAW_MAIL_BUCKET)
    .upload(key, bytes, { contentType: "message/rfc822", upsert: true });
  if (error) throw new InboundStorageError("store raw mail");
  return `${RAW_MAIL_BUCKET}/${key}`;
}

type MessageInput = Record<string, unknown> & { message_id: string };

async function record(
  db: ServiceClient,
  message: MessageInput,
  caseId: string | null,
  expected: CaseStatus | null,
  to: CaseStatus | null,
  reason: string | null,
): Promise<{ id: string; duplicate: boolean; code?: string }> {
  // Nullable in SQL; the generated Args type marks every function parameter as non-null.
  const { data, error } = await db.rpc("claims_record_inbound", {
    p_message: message as unknown as Json,
    p_case_id: caseId as string,
    p_expected_status: expected as CaseStatus,
    p_to_status: to as CaseStatus,
    p_queue_reason: reason as string,
  });
  if (error) {
    if (error.code === "40001") return { id: "", duplicate: false, code: "40001" };
    throw new InboundDbError("claims_record_inbound", error.code);
  }
  const out = data as { message_id: string; duplicate: boolean };
  return { id: out.message_id, duplicate: out.duplicate };
}

async function operatorReply(
  db: ServiceClient,
  mail: ParsedInbound,
  message: MessageInput,
  first: InboundCase,
  deps: IngestDeps & { env: Env },
): Promise<IngestResult> {
  let c = first;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let to: CaseStatus;
    try {
      to = transition(c.status, "operator_replied");
    } catch (e) {
      if (!(e instanceof InvalidTransitionError)) throw e;
      // A reply to a terminal or unsent case (C1): recorded for the team, never classified.
      const rec = await record(db, message, c.id, null, null, "invalid_transition");
      if (rec.duplicate) return { outcome: "duplicate", messageId: rec.id };
      return {
        outcome: "team_queue",
        caseId: c.id,
        messageId: rec.id,
        reason: "invalid_transition",
      };
    }
    const rec = await record(db, message, c.id, c.status, to, null);
    if (rec.code === "40001") {
      c = await readCase(db, c.id);
      continue;
    }
    if (rec.duplicate) return { outcome: "duplicate", messageId: rec.id };
    return classifyAndAct(db, mail, c, rec.id, deps);
  }
  // The case kept changing under us: the team looks at it.
  const rec = await record(db, message, c.id, null, null, "action_failed");
  if (rec.duplicate) return { outcome: "duplicate", messageId: rec.id };
  return { outcome: "team_queue", caseId: c.id, messageId: rec.id, reason: "action_failed" };
}

async function classifyAndAct(
  db: ServiceClient,
  mail: ParsedInbound,
  c: InboundCase,
  messageId: string,
  deps: IngestDeps & { env: Env },
): Promise<IngestResult> {
  const classifier = deps.classifier ?? (defaultClassifier ??= createClassifier(deps.env));
  // classify never throws: anything odd is `other`, which C6 sends to the team queue.
  const verdict = await classifier
    .forCase({ operator: c.operator, userEmail: c.user_email })
    .classify({ from: mail.from, subject: mail.subject, text: mail.text });
  const apply = deps.applyReplyCategory ?? c6ApplyReplyCategory;
  try {
    const out = await apply(
      { caseId: c.id, messageId, category: verdict.category },
      { db, clock: deps.clock ?? systemClock, getOperatorConfig: deps.getOperatorConfig },
    );
    return {
      outcome: "applied",
      caseId: c.id,
      messageId,
      category: verdict.category,
      status: out.status,
    };
  } catch {
    const q = await db.rpc("claims_queue_for_team", {
      p_case_id: c.id,
      p_message_id: messageId,
      p_category: verdict.category,
      p_reason: "action_failed",
    });
    if (q.error) throw new InboundDbError("claims_queue_for_team", q.error.code);
    return { outcome: "team_queue", caseId: c.id, messageId, reason: "action_failed" };
  }
}

/**
 * The user's reply with a document (ARCHITECTURE §7.1): exactly one allowed file (PDF, JPEG,
 * PNG, up to 10 MB) is stored in C6's bucket and forwarded to the operator's verified address
 * only. Anything else goes to the team queue, and nothing of it is stored as a user document.
 */
async function userDocument(
  db: ServiceClient,
  mail: ParsedInbound,
  message: MessageInput,
  c: InboundCase,
  deps: IngestDeps & { env: Env },
): Promise<IngestResult> {
  const allowed = mail.attachments.filter(
    (a) => USER_DOCUMENT_TYPES.includes(a.contentType) && a.size <= USER_DOCUMENT_LIMIT,
  );
  if (allowed.length !== 1 || mail.attachments.length !== 1) {
    const rec = await record(db, message, c.id, null, null, "user_document_not_allowed");
    if (rec.duplicate) return { outcome: "duplicate", messageId: rec.id };
    return {
      outcome: "team_queue",
      caseId: c.id,
      messageId: rec.id,
      reason: "user_document_not_allowed",
    };
  }

  const rec = await record(db, message, c.id, null, null, null);
  if (rec.duplicate) return { outcome: "duplicate", messageId: rec.id };

  const doc = allowed[0];
  const key = `${c.id}/${randomUUID()}`;
  const queue = async (reason: InboundQueueReason): Promise<IngestResult> => {
    const q = await db.rpc("claims_queue_for_team", {
      p_case_id: c.id,
      p_message_id: rec.id,
      // The user's mail is never classified; the function needs a category, `other` is neutral.
      p_category: "other",
      p_reason: reason,
    });
    if (q.error) throw new InboundDbError("claims_queue_for_team", q.error.code);
    return { outcome: "team_queue", caseId: c.id, messageId: rec.id, reason };
  };

  const up = await db.storage
    .from(USER_DOCUMENTS_BUCKET)
    .upload(key, doc.content, { contentType: doc.contentType, upsert: false });
  if (up.error) return queue("forward_failed");
  const att = await db
    .from("attachments")
    .insert({
      case_id: c.id,
      kind: "user_document",
      storage_path: key,
      filename: doc.filename,
      content_type: doc.contentType,
      size_bytes: doc.size,
    })
    .select("id")
    .single();
  if (att.error) {
    await db.storage.from(USER_DOCUMENTS_BUCKET).remove([key]);
    return queue("forward_failed");
  }

  const forward = deps.forwardUserDocument ?? c6ForwardUserDocument;
  try {
    const out = await forward(
      { caseId: c.id, attachmentId: att.data.id },
      { db, clock: deps.clock ?? systemClock, getOperatorConfig: deps.getOperatorConfig },
    );
    if ("teamQueue" in out) {
      return { outcome: "team_queue", caseId: c.id, messageId: rec.id, reason: out.teamQueue };
    }
    return { outcome: "forwarded", caseId: c.id, messageId: rec.id };
  } catch {
    return queue("forward_failed");
  }
}
