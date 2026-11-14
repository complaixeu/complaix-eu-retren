// The team view's logic (docs/plans/C-claims.md C9): the queue, a case's timeline and the three
// actions (inject a scripted operator reply, move the demo clock, resolve a queue item). Internal
// to domain C: the pages in app/(team)/ import it by relative path, like the tick route does.
//
// Nothing here checks who is calling: the pages and server actions do that first
// (./team-access.ts) and only then use the service-role client. Nothing here is ever sent to a
// browser as raw rows: the callers get the small shapes below, with ids, codes and subjects only.
import { randomUUID } from "node:crypto";
import type { Clock, CaseStatus } from "@/shared/contracts";
import { systemClock } from "@/shared/clock";
import type { ServiceClient } from "@/shared/supabase/server";
import { DEMO_FIXTURES } from "./demo-fixtures";
import { runOutbound } from "./outbound-tick";
import { runTick } from "./tick";

type Env = Record<string, string | undefined>;

/** case_events kinds the team has to look at. */
export const TEAM_QUEUE_KINDS = [
  "team_queue",
  "escalation_filing_required",
  "escalation_signature_needed",
] as const;
/** Appended when the team marks a queue item as handled: `{ resolves: <event id> }`, no PII. */
export const TEAM_RESOLVED_EVENT = "team_queue_resolved";

const DAY_MS = 86_400_000;
/** Most rows one view reads. */
const LIMIT = 200;
const UUID_RE = /^[0-9a-f-]{36}$/i;

export class TeamActionError extends Error {
  constructor(
    readonly code:
      | "demo_only"
      | "not_found"
      | "bad_fixture"
      | "no_initial_claim"
      | "no_fixtures"
      | "ingest_failed"
      | "already_resolved"
      | "bad_input",
  ) {
    super(code);
    this.name = "TeamActionError";
  }
}

/** The simulated mailbox and the demo clock exist only with DEMO_MODE=1 and fake mail. */
export function assertDemoMode(env: Env = process.env): void {
  if (env.DEMO_MODE !== "1") throw new TeamActionError("demo_only");
  // Even in the demo: a real mail provider could send what these tools queue.
  if ((env.MAIL_PROVIDER ?? "fake") !== "fake") throw new TeamActionError("demo_only");
}

// ---------------------------------------------------------------------------------------------
// Reading

export type QueueItem = {
  /** case_events id, or messages id for inbound mail with no case. */
  id: string;
  source: "event" | "message";
  caseId: string | null;
  publicRef: string | null;
  /** A reason code: wrong_sender, delivery_unknown, escalation_filing_required, ... */
  reason: string;
  createdAt: string;
};

export type CaseSummary = {
  id: string;
  publicRef: string;
  operator: string;
  status: CaseStatus;
  sentAt: string | null;
  nextActionAt: string | null;
  sendCount: number;
};

export type TimelineEvent = {
  id: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  createdAt: string;
  /** The reason or action code of the event, if it has one. */
  detail: string | null;
};

export type TimelineMessage = {
  id: string;
  direction: "inbound" | "outbound";
  /** The template (outbound) or the classifier's category (inbound). */
  kind: string | null;
  status: string;
  subject: string;
  createdAt: string;
  /** Operator mail only (inbound). Always rendered as plain text. */
  body: string | null;
};

export type CaseView = {
  case: CaseSummary;
  events: TimelineEvent[];
  messages: TimelineMessage[];
  /** Queue items of this case that are not resolved yet. */
  open: QueueItem[];
};

const toCode = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const dataOf = (d: unknown): Record<string, unknown> =>
  d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {};

/** Ids of the queue events a `team_queue_resolved` event points at. */
function resolvedIds(events: { kind: string; data: unknown }[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind !== TEAM_RESOLVED_EVENT) continue;
    const id = toCode(dataOf(e.data).resolves);
    if (id) out.add(id);
  }
  return out;
}

function eventItem(
  e: { id: string; case_id: string; kind: string; data: unknown; created_at: string },
  ref: string | null,
): QueueItem {
  return {
    id: e.id,
    source: "event",
    caseId: e.case_id,
    publicRef: ref,
    reason: e.kind === "team_queue" ? (toCode(dataOf(e.data).reason) ?? "team_queue") : e.kind,
    createdAt: e.created_at,
  };
}

/** Every open queue item, newest first: case events and inbound mail with no case. */
export async function listQueue(db: ServiceClient): Promise<QueueItem[]> {
  const events = await db
    .from("case_events")
    .select("id, case_id, kind, data, created_at")
    .in("kind", [...TEAM_QUEUE_KINDS])
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (events.error) throw events.error;

  const caseIds = [...new Set(events.data.map((e) => e.case_id))];
  const refs = new Map<string, string>();
  let resolved = new Set<string>();
  if (caseIds.length > 0) {
    const [cases, resolutions] = await Promise.all([
      db.from("cases").select("id, public_ref").in("id", caseIds),
      db
        .from("case_events")
        .select("kind, data")
        .eq("kind", TEAM_RESOLVED_EVENT)
        .in("case_id", caseIds),
    ]);
    if (cases.error) throw cases.error;
    if (resolutions.error) throw resolutions.error;
    for (const c of cases.data) refs.set(c.id, c.public_ref);
    resolved = resolvedIds(resolutions.data);
  }
  const items = events.data
    .filter((e) => !resolved.has(e.id))
    .map((e) => eventItem(e, refs.get(e.case_id) ?? null));

  return [...items, ...(await caselessInbound(db))].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

async function caselessInbound(db: ServiceClient): Promise<QueueItem[]> {
  const { data, error } = await db
    .from("messages")
    .select("id, inbound_queue_reason, created_at")
    .eq("direction", "inbound")
    .is("case_id", null)
    .not("inbound_queue_reason", "is", null)
    .is("team_resolved_at", null)
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (error) throw error;
  return data.map((m) => ({
    id: m.id,
    source: "message" as const,
    caseId: null,
    publicRef: null,
    reason: m.inbound_queue_reason ?? "unknown",
    createdAt: m.created_at,
  }));
}

export async function listCases(db: ServiceClient): Promise<CaseSummary[]> {
  const { data, error } = await db
    .from("cases")
    .select("id, public_ref, operator, status, sent_at, next_action_at, send_count")
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (error) throw error;
  return data.map(summary);
}

const summary = (c: {
  id: string;
  public_ref: string;
  operator: string;
  status: CaseStatus;
  sent_at: string | null;
  next_action_at: string | null;
  send_count: number;
}): CaseSummary => ({
  id: c.id,
  publicRef: c.public_ref,
  operator: c.operator,
  status: c.status,
  sentAt: c.sent_at,
  nextActionAt: c.next_action_at,
  sendCount: c.send_count,
});

/** One case with its events and messages, oldest first. Null when there is no such case. */
export async function getCaseView(db: ServiceClient, caseId: string): Promise<CaseView | null> {
  if (!UUID_RE.test(caseId)) return null;
  const [c, events, messages] = await Promise.all([
    db
      .from("cases")
      .select("id, public_ref, operator, status, sent_at, next_action_at, send_count")
      .eq("id", caseId)
      .maybeSingle(),
    db
      .from("case_events")
      .select("id, case_id, kind, from_status, to_status, data, created_at")
      .eq("case_id", caseId)
      .order("created_at", { ascending: true })
      .limit(LIMIT),
    db
      .from("messages")
      .select("id, direction, template, category, status, subject, body_text, created_at")
      .eq("case_id", caseId)
      .order("created_at", { ascending: true })
      .limit(LIMIT),
  ]);
  if (c.error) throw c.error;
  if (events.error) throw events.error;
  if (messages.error) throw messages.error;
  const found = c.data;
  if (!found) return null;

  const resolved = resolvedIds(events.data);
  return {
    case: summary(found),
    events: events.data.map((e) => {
      const d = dataOf(e.data);
      return {
        id: e.id,
        kind: e.kind,
        fromStatus: e.from_status,
        toStatus: e.to_status,
        createdAt: e.created_at,
        detail: toCode(d.reason) ?? toCode(d.action) ?? toCode(d.event) ?? toCode(d.template),
      };
    }),
    messages: messages.data.map((m) => ({
      id: m.id,
      direction: m.direction,
      kind: m.direction === "inbound" ? m.category : m.template,
      status: m.status,
      subject: m.subject,
      createdAt: m.created_at,
      body: m.direction === "inbound" ? m.body_text : null,
    })),
    open: events.data
      .filter(
        (e) => (TEAM_QUEUE_KINDS as readonly string[]).includes(e.kind) && !resolved.has(e.id),
      )
      .map((e) => eventItem(e, found.public_ref)),
  };
}

// ---------------------------------------------------------------------------------------------
// Resolve a queue item

/**
 * Marks a queue item as handled. Append-only: a `team_queue_resolved` event (ids only, no
 * personal data), or `team_resolved_at` for inbound mail with no case. Nothing is deleted.
 * Resolving twice is refused, so the history shows one resolution per item.
 */
export async function resolveQueueItem(
  db: ServiceClient,
  item: { source: "event" | "message"; id: string },
): Promise<void> {
  if (!UUID_RE.test(item.id)) throw new TeamActionError("bad_input");

  if (item.source === "message") {
    const { data, error } = await db
      .from("messages")
      .update({ team_resolved_at: new Date().toISOString() })
      .eq("id", item.id)
      .eq("direction", "inbound")
      .is("case_id", null)
      .not("inbound_queue_reason", "is", null)
      .is("team_resolved_at", null)
      .select("id");
    if (error) throw error;
    if (data.length === 0) throw new TeamActionError("not_found");
    return;
  }

  const event = await db
    .from("case_events")
    .select("id, case_id, kind")
    .eq("id", item.id)
    .maybeSingle();
  if (event.error) throw event.error;
  if (!event.data || !(TEAM_QUEUE_KINDS as readonly string[]).includes(event.data.kind)) {
    throw new TeamActionError("not_found");
  }
  const prior = await db
    .from("case_events")
    .select("kind, data")
    .eq("case_id", event.data.case_id)
    .eq("kind", TEAM_RESOLVED_EVENT);
  if (prior.error) throw prior.error;
  if (resolvedIds(prior.data).has(item.id)) throw new TeamActionError("already_resolved");

  const { error } = await db.from("case_events").insert({
    case_id: event.data.case_id,
    kind: TEAM_RESOLVED_EVENT,
    data: { resolves: item.id, resolved_kind: event.data.kind },
  });
  // The unique index is the real guard against two people resolving at once.
  if (error?.code === "23505") throw new TeamActionError("already_resolved");
  if (error) throw error;
}

// ---------------------------------------------------------------------------------------------
// The demo clock

/** Cookie holding the demo clock (an ISO instant) of one team session. See nextDemoNow. */
export const DEMO_CLOCK_COOKIE = "retren_demo_now";

/**
 * The instant "now" is for the tick in this session: the stored demo instant when it is ahead of
 * the real clock, otherwise the real clock. A bad or past value is ignored.
 */
export function demoNow(stored: string | undefined, clock: Clock = systemClock): Date {
  const real = clock.now();
  const t = stored ? Date.parse(stored) : NaN;
  return Number.isFinite(t) && t > real.getTime() ? new Date(t) : real;
}

/** Moves the demo clock forward by whole days (1 to 400). It never goes back. */
export function nextDemoNow(
  stored: string | undefined,
  days: number,
  clock: Clock = systemClock,
): Date {
  if (!Number.isInteger(days) || days < 1 || days > 400) throw new TeamActionError("bad_input");
  return new Date(demoNow(stored, clock).getTime() + days * DAY_MS);
}

/** What one "move the clock" did: counts only. */
export type ClockResult = {
  now: string;
  timerActions: number;
  initialClaims: number;
  sent: number;
};

/** The most timer rounds per click: each round applies one stage per case, a case has 4. */
const MAX_ROUNDS = 6;

/**
 * Runs the tick at `now` for ONE case (the one being viewed; other cases are never touched):
 * timer actions, then its initial claim and queued mail, like POST /api/claims/tick. A case moves one stage per round, so it repeats until nothing is due:
 * moving the clock to d30 queues the d12 and the d30 reminder, as hourly ticks would have.
 */
export async function runDemoTick(
  db: ServiceClient,
  now: Date,
  caseId: string,
  env: Env = process.env,
): Promise<ClockResult> {
  assertDemoMode(env);
  if (!UUID_RE.test(caseId)) throw new TeamActionError("bad_input");
  const out: ClockResult = { now: now.toISOString(), timerActions: 0, initialClaims: 0, sent: 0 };
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const tick = await runTick(db, now, { caseId });
    const outbound = await runOutbound(db, now, { env }, undefined, { caseId });
    out.timerActions += tick.actions.length;
    out.initialClaims += outbound.initialClaims.filter((c) => c.ok).length;
    out.sent += outbound.sent.filter((s) => s.status === "sent").length;
    if (tick.actions.length === 0) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The simulated mailbox

export const FIXTURE_NAME = /^[a-z][a-z_-]*-\d{2}$/;

export type MailFixture = { name: string; label: string };

const FIXTURE_LABELS: Record<string, string> = {
  acknowledgement: "Acuse de recibo",
  approved: "Aprobada",
  asks_for_data: "Pide datos (IBAN)",
  denied: "Denegada",
  refers_to_form: "Remite a su formulario",
  other: "Otra respuesta",
  injection: "Intento de inyección",
  "wrong-sender": "Remitente equivocado",
  "spoofed-ref": "Referencia falsificada",
};

type FixtureSet = Record<string, Record<string, string>>;

/** The scripted replies available for an operator (the bundled copy of tests/fixtures/mail). */
export function listFixtures(
  operator: string,
  fixtures: FixtureSet = DEMO_FIXTURES,
): MailFixture[] {
  if (!/^[a-z]+$/.test(operator)) return [];
  return Object.keys(fixtures[operator] ?? {})
    .filter((name) => FIXTURE_NAME.test(name))
    .sort()
    .map((name) => {
      const kind = name.replace(/-\d{2}$/, "");
      return { name, label: `${FIXTURE_LABELS[kind] ?? kind} (${name.slice(-2)})` };
    });
}

/** Fixtures that keep their own threading and reference: the test is that we reject them. */
const KEEPS_OWN_THREADING = /^spoofed-ref-/;

const HEADERS_REWRITTEN = ["message-id", "in-reply-to", "references"];

/**
 * Turns a fixture into a reply to one case: a fresh Message-ID (it is unique, a mail stored once
 * is never stored twice), In-Reply-To and References pointing at the case's initial claim, and
 * the case's reference instead of the fixture's. A spoofed-reference fixture keeps its own
 * threading and reference. Pure.
 */
export function scriptedReply(
  raw: string,
  o: { fixture: string; publicRef: string; initialMessageId: string; messageId: string },
): string {
  const text = raw.replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  const head = split === -1 ? text : text.slice(0, split);
  let body = split === -1 ? "" : text.slice(split + 2);
  const keep = KEEPS_OWN_THREADING.test(o.fixture);

  // Unfold: a line that starts with whitespace continues the previous header.
  const headers: string[] = [];
  for (const line of head.split("\n")) {
    if (/^[ \t]/.test(line) && headers.length > 0) headers[headers.length - 1] += ` ${line.trim()}`;
    else headers.push(line);
  }
  const kept = headers.filter((h) => {
    const name = h.split(":", 1)[0]?.trim().toLowerCase() ?? "";
    return name !== "message-id" && !(!keep && HEADERS_REWRITTEN.includes(name));
  });
  const added = [`Message-ID: ${o.messageId}`];
  if (!keep) {
    added.push(`In-Reply-To: ${o.initialMessageId}`, `References: ${o.initialMessageId}`);
  }
  const rewriteRef = (s: string) => (keep ? s : s.replace(/RTN-[A-Z0-9]+/g, o.publicRef));
  body = rewriteRef(body);
  return `${[...kept.map(rewriteRef), ...added].join("\r\n")}\r\n\r\n${body.replace(/\n/g, "\r\n")}`;
}

/** What `ingestMessage` (C4) answers; only the fields the view shows. */
export type IngestOutcome = { outcome: string; reason?: string; status?: string };

export interface InjectDeps {
  /** C4's ingestMessage; injected so this file does not depend on it being merged. */
  ingest: (raw: string) => Promise<IngestOutcome>;
  env?: Env;
  newMessageId?: () => string;
  /** Test override of the bundled fixtures. */
  fixtures?: FixtureSet;
}

/**
 * Plays an operator reply into the case through the real path: C4 stores and matches it, C5
 * classifies it, C6 acts on it. Demo only.
 */
export async function injectOperatorReply(
  db: ServiceClient,
  input: { caseId: string; fixture: string },
  deps: InjectDeps,
): Promise<IngestOutcome> {
  const env = deps.env ?? process.env;
  assertDemoMode(env);
  if (!FIXTURE_NAME.test(input.fixture) || !UUID_RE.test(input.caseId)) {
    throw new TeamActionError("bad_input");
  }

  const c = await db
    .from("cases")
    .select("id, public_ref, operator, user_email")
    .eq("id", input.caseId)
    .maybeSingle();
  if (c.error) throw c.error;
  const row = c.data;
  if (!row) throw new TeamActionError("not_found");

  const available = listFixtures(row.operator, deps.fixtures);
  if (available.length === 0) throw new TeamActionError("no_fixtures");
  if (!available.some((f) => f.name === input.fixture)) throw new TeamActionError("bad_fixture");

  const sent = await db
    .from("messages")
    .select("message_id, template, to_address")
    .eq("case_id", row.id)
    .eq("direction", "outbound")
    .eq("status", "sent")
    .not("message_id", "is", null)
    .order("created_at", { ascending: true });
  if (sent.error) throw sent.error;
  const claim =
    sent.data.find((m) => m.template === "initial_claim") ??
    sent.data.find((m) => m.to_address.toLowerCase() !== row.user_email.toLowerCase());
  if (!claim?.message_id) throw new TeamActionError("no_initial_claim");

  const raw = (deps.fixtures ?? DEMO_FIXTURES)[row.operator]?.[input.fixture] ?? "";
  const mail = scriptedReply(raw, {
    fixture: input.fixture,
    publicRef: row.public_ref,
    initialMessageId: claim.message_id,
    messageId: (deps.newMessageId ?? freshMessageId)(),
  });
  try {
    return await deps.ingest(mail);
  } catch {
    throw new TeamActionError("ingest_failed");
  }
}

const freshMessageId = () => `<scripted-${randomUUID()}@mail.example>`;
