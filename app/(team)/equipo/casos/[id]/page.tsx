import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { createServiceClient } from "@/shared/supabase/server";
import {
  DEMO_CLOCK_COOKIE,
  demoCapabilities,
  demoNow,
  getCaseView,
  listFixtures,
  type CaseView,
  type TimelineMessage,
} from "../../../../../features/claims/team";
import { injectReply } from "../../actions";
import { requireTeam } from "../../_lib/session";
import { ClockPanel } from "../../_components/clock-panel";
import { InboxCheck } from "../../_components/inbox-check";
import {
  dateTime,
  operatorName,
  reasonLabel,
  shortDate,
  statusLabel,
} from "../../_components/labels";
import { Notice } from "../../_components/notice";
import { ActionSubmit } from "../../_components/action-submit";
import { ResolveForm } from "../../_components/resolve-form";
import styles from "../../team.module.css";

export const metadata: Metadata = { title: "Caso" };

const KIND_LABELS: Record<string, string> = {
  initial_claim: "Initial claim",
  reminder_d12: "Friendly reminder (day 12)",
  reminder_d30: "Legal reminder (day 30)",
  last_notice_d40: "Final notice (day 40)",
  escalation_d45: "Escalation (day 45)",
  insistence_after_denial: "Insistence after denial",
  user_request_document: "Request to passenger",
  user_final_result: "Final result to passenger",
  reply_acknowledgement: "Reply to operator",
  reply_asks_for_data: "Passenger document forwarded to operator",
  reply_approved: "Reply to operator (approved)",
  reply_denied: "Reply to operator (denied)",
  reply_refers_to_form: "Reply to operator (web form)",
  acknowledgement: "Acknowledgement",
  asks_for_data: "Asks for data",
  approved: "Approved",
  denied: "Denied",
  refers_to_form: "Refers to web form",
  other: "Unclear / suspicious",
};
const ATTACHMENT_LABELS: Record<string, string> = {
  eu_form: "EU claim form (PDF)",
  mandate: "Mandate (PDF)",
  ticket: "Ticket",
  user_document: "Passenger document",
};
const CLASSIFICATIONS: Record<string, string> = {
  acknowledgement: "Acknowledgement",
  asks_for_data: "Asks for data",
  approved: "Approved",
  denied: "Denied",
  refers_to_form: "Refers to web form",
  other: "Unclear / suspicious",
};
const dayFrom = (at: string, sent: string | null) =>
  sent ? Math.max(0, Math.floor((Date.parse(at) - Date.parse(sent)) / 86_400_000)) : 0;

const SUBJECTS: Record<string, string> = {
  initial_claim: "Delay compensation claim",
  reminder_d12: "Friendly reminder: delay compensation claim",
  reminder_d30: "Formal reminder: delay compensation claim",
  last_notice_d40: "Final notice: delay compensation claim",
  escalation_d45: "Claim escalation",
  insistence_after_denial: "Re: Delay compensation claim",
  user_request_document: "A document is needed for your claim",
  user_final_result: "Your delay compensation claim result",
  acknowledgement: "We received your claim",
  asks_for_data: "Information requested for your claim",
  approved: "Your claim has been approved",
  denied: "Decision on your delay compensation claim",
  refers_to_form: "Please use the claim form",
  other: "Re: Delay compensation claim",
};
const ATTACHMENT_FILES: Record<string, string> = {
  eu_form: "EU claim form.pdf",
  mandate: "Mandate.pdf",
  ticket: "Ticket",
  user_document: "Passenger document",
};

function emailSubject(kind: string | null, ref: string) {
  const subject = SUBJECTS[kind ?? ""] ?? "Delay compensation claim";
  return `${kind?.startsWith("reply_") || kind === "insistence_after_denial" ? "Re: " : ""}[${ref}] ${subject.replace(/^Re: /, "")}`;
}

/** The subject the team reads: without the leading "[RTN-…]" tag, since the case ref is the heading. */
const displaySubject = (subject: string) => subject.replace(/^(Re: )?\[[^\]]+\]\s*/, "");

function emailPreview(kind: string | null, operator: string, ref: string, inbound: boolean) {
  if (inbound) {
    const copy: Record<string, string> = {
      acknowledgement: `Dear passenger,\n\nWe have received your claim ${ref}. Our team is reviewing the journey details and will reply as soon as possible.\n\n${operator} Customer Service`,
      asks_for_data: `Dear passenger,\n\nWe are reviewing claim ${ref}. Please send the additional information requested so we can continue processing it.\n\n${operator} Customer Service`,
      approved: `Dear passenger,\n\nWe have reviewed claim ${ref} and approved your compensation. The payment will be processed according to our usual schedule.\n\n${operator} Customer Service`,
      denied: `Dear passenger,\n\nWe have reviewed claim ${ref} and cannot approve it at this time. Please see our decision and the available next steps.\n\n${operator} Customer Service`,
      refers_to_form: `Dear passenger,\n\nPlease complete the claim form for reference ${ref} so we can continue our review.\n\n${operator} Customer Service`,
    };
    return (
      copy[kind ?? ""] ??
      `Dear passenger,\n\nWe have received your message about claim ${ref}. Our team will review it and get back to you.\n\n${operator} Customer Service`
    );
  }

  const greetings = kind?.startsWith("user_")
    ? "Dear passenger,"
    : `Dear ${operator} Customer Service,`;
  const body: Record<string, string> = {
    initial_claim: `On behalf of the passenger, we claim compensation for the delay under EU Regulation 2021/782. Please find attached the EU claim form, the signed mandate and the ticket.`,
    reminder_d12: `We are following up on claim ${ref}. Please let us know when we can expect your decision.`,
    reminder_d30: `We are following up again on claim ${ref}. Please provide your decision as soon as possible.`,
    last_notice_d40: `This is our final notice regarding claim ${ref}. Please resolve the matter promptly.`,
    escalation_d45: `We are escalating claim ${ref} for further review under the applicable passenger rights.`,
    user_request_document: `The operator needs additional information to continue reviewing your claim. Please provide the requested document.`,
    user_final_result: `Your claim ${ref} has been reviewed. Please see the decision and next steps in this message.`,
    reply_asks_for_data: `We are forwarding the requested passenger document for claim ${ref}. Please continue your review.`,
    insistence_after_denial: `We ask you to reconsider your decision on claim ${ref} in light of the passenger rights that apply.`,
  };
  const signoff = kind?.startsWith("user_")
    ? "ReTren Claims"
    : "ReTren, on behalf of the passenger";
  return `${greetings}\n\n${body[kind ?? ""] ?? `We are writing about delay compensation claim ${ref}. Please review the case and reply at your earliest convenience.`}\n\nKind regards,\n${signoff}`;
}

function statusHeadline(status: string, operator: string) {
  if (status === "resolved" || status === "closed")
    return { title: "Resolved", text: "The claim has reached a decision." };
  if (status === "escalated")
    return { title: "Escalated", text: "The claim needs further review." };
  if (status === "denied")
    return { title: "Not eligible", text: "The operator declined the claim." };
  if (status === "waiting_user")
    return { title: "Waiting for passenger", text: "A document or detail is needed to continue." };
  if (status === "sent" || status === "reply_received")
    return {
      title: `Claim sent to ${operator}`,
      text: "The operator has received the compensation request.",
    };
  return { title: "Claim in progress", text: "Your case is being prepared for the operator." };
}

/** One email as the inbox shows it: who, what, when, and what the team needs to know. */
type InboxItem = {
  id: string;
  /** The full subject, with the case tag (shown in Technical details). */
  subject: string;
  /** The subject as the team reads it: no case tag. */
  title: string;
  body: string;
  mockBody: boolean;
  kindLabel: string;
  kind: string | null;
  incoming: boolean;
  passenger: boolean;
  sender: string;
  recipient: string;
  initial: string;
  createdAt: string;
  status: string;
  blocked: boolean;
  classification: string | null;
  outcome: string | null;
  attachments: string[];
  from: string | null;
  to: string | null;
  deliveredTo: string[];
  storedSubject: string;
  rawBody: string | null;
};

const STATUS_TEXT: Record<string, string> = {
  queued: "Queued",
  sent: "Sent",
  failed: "Failed",
  blocked: "Blocked",
};

function describeMessages(view: CaseView): InboxItem[] {
  const c = view.case;
  const operator = operatorName(c.operator);
  return view.messages.map((m: TimelineMessage) => {
    const passenger = Boolean(m.kind?.startsWith("user_"));
    const incoming = m.direction === "inbound";
    const mockBody = Boolean(m.body?.toLowerCase().startsWith("mock "));
    const sender = incoming
      ? `${operator} Customer Service`
      : passenger
        ? "Passenger"
        : "ReTren Claims";
    const recipient = incoming
      ? "ReTren Claims"
      : passenger
        ? "Passenger"
        : `${operator} Customer Service`;
    // Only the events between this email and the next inbound email are its outcome, so a later
    // reply never relabels an earlier one.
    const nextInbound = view.messages.find(
      (n) => n.direction === "inbound" && n.createdAt > m.createdAt,
    );
    const inWindow = (e: { createdAt: string }) =>
      e.createdAt >= m.createdAt && (!nextInbound || e.createdAt < nextInbound.createdAt);
    const blocked =
      m.direction === "inbound" &&
      (m.kind === "other" ||
        view.events.some(
          (e) =>
            inWindow(e) &&
            (["wrong_sender", "spoofed_reference", "unknown_reference"].includes(e.detail ?? "") ||
              e.kind === "team_queue"),
        ));
    const outcome = !incoming
      ? null
      : view.events.some(
            (e) => inWindow(e) && (e.kind === "case_resolved" || e.toStatus === "resolved"),
          )
        ? "Case resolved and passenger notified"
        : m.kind === "asks_for_data"
          ? "Asked the passenger for the document"
          : m.kind === "denied"
            ? "Sent one insistence"
            : blocked
              ? "Sent to the team queue — instructions in the email ignored"
              : "Waiting for the operator";
    const subject = emailSubject(m.kind, c.publicRef);
    return {
      id: m.id,
      subject,
      title: displaySubject(subject),
      body: mockBody
        ? emailPreview(m.kind, operator, c.publicRef, incoming)
        : m.body || emailPreview(m.kind, operator, c.publicRef, incoming),
      mockBody,
      kindLabel: KIND_LABELS[m.kind ?? ""] ?? "Email",
      kind: m.kind,
      incoming,
      passenger,
      sender,
      recipient,
      initial: incoming ? operator.slice(0, 1) : passenger ? "P" : "R",
      createdAt: m.createdAt,
      status: STATUS_TEXT[m.status ?? ""] ?? m.status ?? "",
      blocked,
      classification: incoming ? (CLASSIFICATIONS[m.kind ?? ""] ?? "Unclear / suspicious") : null,
      outcome,
      attachments: m.attachments.map((a) => ATTACHMENT_FILES[a] ?? ATTACHMENT_LABELS[a] ?? a),
      from: m.from,
      to: m.to,
      deliveredTo: m.deliveredTo,
      storedSubject: m.subject,
      rawBody: m.body || null,
    };
  });
}

function Paperclip() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13.2 7.6 8 12.8a3.2 3.2 0 0 1-4.5-4.5L9 3.8a2.1 2.1 0 0 1 3 3L6.9 12" />
    </svg>
  );
}

export default function TeamCasePage({ params, searchParams }: PageProps<"/equipo/casos/[id]">) {
  return (
    <Suspense fallback={<p>Cargando…</p>}>
      <CaseDetail params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function CaseDetail({
  params,
  searchParams,
}: Pick<PageProps<"/equipo/casos/[id]">, "params" | "searchParams">) {
  await requireTeam();
  const { id } = await params;
  const query = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

  const view = await getCaseView(createServiceClient(), id);
  if (!view) notFound();
  const { case: c } = view;
  const back = `/equipo/casos/${c.id}`;
  // Which demo tools this deployment has (never a hard-coded rule here: see demoCapabilities).
  const caps = demoCapabilities();
  const fixtures = caps.simulateReply ? listFixtures(c.operator) : [];
  const now = demoNow((await cookies()).get(DEMO_CLOCK_COOKIE)?.value);
  const operator = operatorName(c.operator);
  const headline = statusHeadline(c.status, operator);
  const currentStep =
    c.status === "draft"
      ? 0
      : c.status === "waiting_period"
        ? 1
        : c.status === "sent"
          ? 2
          : ["reply_received", "denied"].includes(c.status)
            ? 3
            : ["waiting_user", "resolved", "escalated", "closed"].includes(c.status)
              ? 4
              : 0;

  // Tracking: the day or date a step happened, where the case says so.
  const lastInbound = [...view.messages].reverse().find((m) => m.direction === "inbound");
  const lastStatusChange = view.events.filter((e) => e.toStatus === c.status).at(-1);
  const steps: { label: string; when: string | null }[] = [
    { label: "Case created", when: null },
    { label: "Waiting period", when: null },
    // A step has a date only once it has happened, each from its own event.
    { label: "Claim sent", when: currentStep >= 2 ? c.sentAt : null },
    {
      label: "Operator replied",
      when: currentStep >= 3 ? (lastInbound?.createdAt ?? null) : null,
    },
    {
      label:
        c.status === "waiting_user"
          ? "Waiting for user"
          : c.status === "resolved"
            ? "Resolved"
            : c.status === "escalated"
              ? "Escalated"
              : c.status === "closed"
                ? "Closed"
                : "Resolved / Escalated / Closed",
      when: currentStep >= 4 ? (lastStatusChange?.createdAt ?? null) : null,
    },
  ];

  const items = describeMessages(view);
  const sorted = [...items].reverse(); // newest first, like a mail app
  const selected = items.find((item) => item.id === one(query.m));
  const latestReply = [...items].reverse().find((item) => item.incoming);

  return (
    <div className={styles.casePage}>
      <Link className={styles.backLink} href="/equipo">
        Back to team queue
      </Link>
      <Notice aviso={one(query.aviso)} error={one(query.error)} />

      <header className={styles.caseHeader}>
        <h1 className={styles.title}>Case {c.publicRef}</h1>
        <p className={styles.operatorLine}>
          <span className={styles.muted}>Operator</span> {operator}
        </p>
        <p className={styles.statusLine}>
          <strong>{headline.title}</strong> {headline.text}
        </p>
      </header>

      <section aria-labelledby="process" className={styles.card}>
        <h2 id="process" className={styles.subtitle}>
          Claim process
        </h2>
        <ol className={styles.track}>
          {steps.map((step, index) => {
            const done = index < currentStep;
            const current = index === currentStep;
            return (
              <li
                key={`${step.label}-${index}`}
                aria-current={current ? "step" : undefined}
                className={`${styles.trackStep} ${done ? styles.stepDone : ""} ${current ? styles.stepCurrent : ""}`}
              >
                <span className={styles.trackDot} aria-hidden="true">
                  {done ? (
                    <svg
                      aria-hidden="true"
                      focusable="false"
                      viewBox="0 0 16 16"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 8.5l3.2 3L13 4.5" />
                    </svg>
                  ) : (
                    index + 1
                  )}
                </span>
                <span className={styles.trackText}>
                  <span className={styles.stepName}>{step.label}</span>
                  {!current && (
                    <span className="visually-hidden">{done ? " completed" : " upcoming"}</span>
                  )}
                  {step.when && (
                    <span className={styles.stepWhen}>
                      Day {dayFrom(step.when, c.sentAt)} · {dateTime(step.when)}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <section aria-labelledby="mensajes" className={`${styles.card} ${styles.thread}`}>
        <div className={styles.sectionHead}>
          <h2 id="mensajes" className={styles.subtitle}>
            Email thread
          </h2>
          {items.length > 0 && (
            <span className={styles.muted}>
              {items.length} {items.length === 1 ? "email" : "emails"}
            </span>
          )}
        </div>

        {items.length === 0 ? (
          <p>This case has no email yet.</p>
        ) : selected ? (
          <article className={styles.readMessage}>
            <Link className={styles.backLink} href={back}>
              ← Inbox
            </Link>
            <h3 className={styles.readSubject}>{selected.title}</h3>
            <dl className={styles.readMeta}>
              <div>
                <dt>From</dt>
                <dd>{selected.sender}</dd>
              </div>
              <div>
                <dt>To</dt>
                <dd>{selected.recipient}</dd>
              </div>
              <div>
                <dt>Date</dt>
                <dd>
                  {dateTime(selected.createdAt)} · Day {dayFrom(selected.createdAt, c.sentAt)}
                </dd>
              </div>
            </dl>
            <div className={styles.messageTags}>
              <span className={styles.kindTag}>{selected.kindLabel}</span>
              <span className={styles.pill}>{selected.status}</span>
              {selected.blocked && <span className={styles.blockedTag}>Blocked</span>}
              {selected.mockBody && <span className={styles.previewTag}>Preview</span>}
            </div>
            {selected.blocked && (
              <p className={styles.warningBanner}>
                Suspicious email: instructions ignored, sent to the ReTren team
              </p>
            )}
            <p className={`${styles.readBody} ${selected.blocked ? styles.suspiciousBody : ""}`}>
              {selected.body}
            </p>
            {selected.attachments.length > 0 && (
              <ul className={styles.files} aria-label="Attachments">
                {selected.attachments.map((name, n) => (
                  <li key={`${name}-${n}`}>
                    <Paperclip />
                    {name}
                  </li>
                ))}
              </ul>
            )}
            {selected.incoming && (
              <div className={styles.aiLines}>
                <p className={styles.aiFooter}>
                  <span className={styles.aiBadge}>AI</span> AI classification:{" "}
                  {selected.classification} · ReTren replied automatically
                </p>
                <p className={styles.meta}>What ReTren did next: {selected.outcome}</p>
              </div>
            )}
            <details className={styles.bodyDetails}>
              <summary>Technical details</summary>
              <div className={styles.technicalDetails}>
                <p>
                  <strong>From:</strong> {selected.from ?? "—"}
                </p>
                <p>
                  <strong>To:</strong> {selected.to ?? "—"}
                </p>
                {selected.deliveredTo.length > 0 && (
                  <p>Redirected to: {selected.deliveredTo.join(", ")} (demo)</p>
                )}
                <p>
                  <strong>Subject:</strong> {selected.subject}
                </p>
                <p>
                  <strong>Stored subject:</strong> {selected.storedSubject}
                </p>
                <p>
                  <strong>Kind:</strong> <span className={styles.pill}>{selected.kindLabel}</span>{" "}
                  <code className={styles.code}>{selected.kind ?? "unknown"}</code>
                </p>
                {selected.rawBody && <pre className={styles.mailBody}>{selected.rawBody}</pre>}
              </div>
            </details>
          </article>
        ) : (
          <ol className={styles.inbox}>
            {sorted.map((item) => (
              <li key={item.id} className={styles.inboxItem}>
                <Link className={styles.row} href={`${back}?m=${item.id}`}>
                  <span
                    className={`${styles.avatar} ${item.incoming ? styles.operatorAvatar : ""}`}
                    aria-hidden="true"
                  >
                    {item.initial}
                  </span>
                  <span className={styles.rowBody}>
                    <span className={styles.rowTop}>
                      <span className={item.incoming ? styles.senderIn : styles.sender}>
                        {item.sender}
                      </span>
                      <time className={styles.rowDate} dateTime={item.createdAt}>
                        {shortDate(item.createdAt)}
                      </time>
                    </span>
                    <span className={styles.rowSubject}>{item.title}</span>
                    <span className={styles.rowPreview}>{item.body.replace(/\s+/g, " ")}</span>
                    <span className={styles.rowMeta}>
                      <span className={styles.kindTag}>{item.kindLabel}</span>
                      <span>{item.status}</span>
                      {item.blocked && (
                        <span className={styles.blockedTag}>
                          Blocked — sent to the team for review
                        </span>
                      )}
                      {item.attachments.length > 0 && (
                        <span className={styles.clip}>
                          <Paperclip />
                          {item.attachments.length}{" "}
                          {item.attachments.length === 1 ? "attachment" : "attachments"}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className={styles.chevron} aria-hidden="true">
                    ›
                  </span>
                </Link>
                {item.attachments.length > 0 && (
                  <ul className="visually-hidden" aria-label="Attachments">
                    {item.attachments.map((name, n) => (
                      <li key={`${name}-${n}`}>{name}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="resumen" className={styles.quietCard}>
        <h2 id="resumen" className={styles.subtitle}>
          Case summary
        </h2>
        <dl>
          <dt className={styles.muted}>Status</dt>
          <dd>{statusLabel(c.status)}</dd>
          <dt className={styles.muted}>Operator</dt>
          <dd>{operator}</dd>
          <dt className={styles.muted}>Claim sent</dt>
          <dd>{dateTime(c.sentAt)}</dd>
          <dt className={styles.muted}>Emails sent to operator</dt>
          <dd>{c.sendCount}</dd>
        </dl>
        {latestReply && (
          <div className={styles.aiLines}>
            <p className={styles.aiFooter}>
              <span className={styles.aiBadge}>AI</span> AI classification:{" "}
              {latestReply.classification} · ReTren replied automatically
            </p>
            <p className={styles.meta}>What ReTren did next: {latestReply.outcome}</p>
          </div>
        )}
      </section>

      {view.open.length > 0 && (
        <section aria-labelledby="pendiente" className={styles.quietCard}>
          <h2 id="pendiente" className={styles.subtitle}>
            Needs team review
          </h2>
          <ul className={styles.list}>
            {view.open.map((item) => (
              <li key={item.id} className={styles.inline}>
                <span>
                  {reasonLabel(item.reason)} <code className={styles.code}>{item.reason}</code>
                </span>
                <ResolveForm
                  id={item.id}
                  source={item.source}
                  back={back}
                  label={reasonLabel(item.reason)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className={styles.demoControls}>
        {caps.simulateReply && (
          <section aria-labelledby="inyectar" className={styles.quietCard}>
            <h2 id="inyectar" className={styles.subtitle}>
              Simulate an operator reply
            </h2>
            {fixtures.length === 0 ? (
              <p>No reply fixtures are available for this operator.</p>
            ) : (
              <form action={injectReply} className={styles.inline}>
                <input type="hidden" name="caseId" value={c.id} />
                <label className={styles.label}>
                  Reply fixture
                  <select name="fixture" className={styles.select} required>
                    {fixtures.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>
                <ActionSubmit pendingLabel="Processing reply…">Simulate reply</ActionSubmit>
              </form>
            )}
            <p className={styles.muted}>
              The reply follows the real inbound path: it is stored, classified, and acted on.
            </p>
          </section>
        )}

        {caps.clock && <ClockPanel now={now.toISOString()} back={back} caseId={c.id} />}
        {caps.checkInbox && <InboxCheck caseId={c.id} />}
      </div>

      <section aria-labelledby="historial" className={`${styles.quietCard} ${styles.historyCard}`}>
        <details className={styles.historyDetails}>
          <summary>Technical history</summary>
          <h2 id="historial" className={styles.subtitle}>
            History
          </h2>
          <p className={styles.meta}>
            Status code: <code className={styles.code}>{c.status}</code>
          </p>
          <div className={styles.tableWrap}>
            <table className={`${styles.table} ${styles.stackTable}`}>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Event</th>
                  <th scope="col">Status change</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {view.events.map((e) => (
                  <tr key={e.id}>
                    <td data-label="Date">{dateTime(e.createdAt)}</td>
                    <td data-label="Event">
                      <code className={styles.code}>{e.kind}</code>
                    </td>
                    <td data-label="Status change">
                      {e.fromStatus || e.toStatus
                        ? `${e.fromStatus ?? "—"} → ${e.toStatus ?? "—"}`
                        : "—"}
                    </td>
                    <td data-label="Details">
                      {e.detail ? <code className={styles.code}>{e.detail}</code> : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </div>
  );
}
