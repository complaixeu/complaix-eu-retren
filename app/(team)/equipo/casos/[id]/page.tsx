import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { createServiceClient } from "@/shared/supabase/server";
import { Button } from "@/shared/ui";
import {
  DEMO_CLOCK_COOKIE,
  demoNow,
  getCaseView,
  listFixtures,
} from "../../../../../features/claims/team";
import { injectReply } from "../../actions";
import { isDemo, requireTeam } from "../../_lib/session";
import { ClockPanel } from "../../_components/clock-panel";
import { dateTime, reasonLabel, statusLabel } from "../../_components/labels";
import { Notice } from "../../_components/notice";
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
  const demo = isDemo();
  const fixtures = demo ? listFixtures(c.operator) : [];
  const now = demoNow((await cookies()).get(DEMO_CLOCK_COOKIE)?.value);
  const headline = statusHeadline(c.status, c.operator);
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

  return (
    <main className={styles.casePage}>
      <Link className={styles.backLink} href="/equipo">
        Back to team queue
      </Link>
      <Notice aviso={one(query.aviso)} error={one(query.error)} />
      <header className={styles.hero}>
        <div className={styles.heroEyebrow}>CASE {c.publicRef}</div>
        <div className={styles.operatorLine}>
          <span className={styles.operatorBadge}>{c.operator.slice(0, 1)}</span>
          <span>{c.operator}</span>
        </div>
        <span className={styles.statusPill}>{headline.title}</span>
        <h1 className={styles.title}>Case {c.publicRef}</h1>
        <p className={styles.heroDescription}>{headline.text}</p>
      </header>

      <section aria-labelledby="process" className={styles.card}>
        <h2 id="process" className={styles.subtitle}>
          Claim process
        </h2>
        <ol className={styles.steps}>
          {[
            "Case created",
            "Waiting period",
            "Claim sent",
            "Operator replied",
            c.status === "waiting_user"
              ? "Waiting for user"
              : c.status === "resolved"
                ? "Resolved"
                : c.status === "escalated"
                  ? "Escalated"
                  : c.status === "closed"
                    ? "Closed"
                    : "Resolved / Escalated / Closed",
          ].map((step, index) => (
            <li
              key={`${step}-${index}`}
              aria-current={
                (c.status === "draft" && index === 0) ||
                (c.status === "waiting_period" && index === 1) ||
                (c.status === "sent" && index === 2) ||
                (c.status === "reply_received" && index === 3) ||
                (c.status === "waiting_user" && index === 4) ||
                (["resolved", "escalated", "closed"].includes(c.status) && index === 4) ||
                (c.status === "denied" && index === 3)
                  ? "step"
                  : undefined
              }
              className={`${styles.step} ${index < currentStep ? styles.stepDone : ""} ${index === currentStep ? styles.stepCurrent : ""}`}
            >
              <span className={styles.stepCircle} aria-hidden="true">
                {index < currentStep ? (
                  <svg
                    aria-hidden="true"
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
              <span className={styles.stepName}>{step}</span>
            </li>
          ))}
        </ol>
        <p className={styles.muted}>
          Day {dayFrom(now.toISOString(), c.sentAt)} <span>of this claim</span>
        </p>
      </section>

      <section aria-labelledby="resumen" className={styles.card}>
        <h2 id="resumen" className={styles.subtitle}>
          Case summary
        </h2>
        <dl>
          <dt className={styles.muted}>Status</dt>
          <dd>
            {statusLabel(c.status)} <code className={styles.code}>{c.status}</code>
          </dd>
          <dt className={styles.muted}>Operator</dt>
          <dd>{c.operator}</dd>
          <dt className={styles.muted}>Claim sent</dt>
          <dd>{dateTime(c.sentAt)}</dd>
          <dt className={styles.muted}>Emails sent to operator</dt>
          <dd>{c.sendCount}</dd>
        </dl>
      </section>

      {view.open.length > 0 && (
        <section aria-labelledby="pendiente" className={styles.card}>
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
        {isDemo() && (
          <section aria-labelledby="inyectar" className={styles.card}>
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
                <Button type="submit">Simulate reply</Button>
              </form>
            )}
            <p className={styles.muted}>
              The reply follows the real inbound path: it is stored, classified, and acted on.
            </p>
          </section>
        )}

        {demo && <ClockPanel now={now.toISOString()} back={back} caseId={c.id} />}
      </div>

      <section aria-labelledby="mensajes" className={`${styles.card} ${styles.thread}`}>
        <h2 id="mensajes" className={styles.subtitle}>
          Email thread
        </h2>
        {view.messages.length === 0 ? (
          <p>This case has no email yet.</p>
        ) : (
          <ol className={styles.list}>
            {view.messages.map((m) => {
              const passenger = Boolean(m.kind?.startsWith("user_"));
              const incoming = m.direction === "inbound";
              const mockBody = Boolean(m.body?.toLowerCase().startsWith("mock "));
              const sender = incoming
                ? `${c.operator} Customer Service`
                : passenger
                  ? "Passenger"
                  : "ReTren Claims";
              const recipient = incoming
                ? "ReTren Claims"
                : passenger
                  ? "Passenger"
                  : `${c.operator} Customer Service`;
              // Only the events between this email and the next inbound email are its
              // outcome, so a later reply never relabels an earlier one.
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
                      (["wrong_sender", "spoofed_reference", "unknown_reference"].includes(
                        e.detail ?? "",
                      ) ||
                        e.kind === "team_queue"),
                  ));
              const outcome = view.events.some(
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
              return (
                <li
                  key={m.id}
                  className={`${styles.mailCard} ${incoming ? styles.incoming : styles.outgoing} ${blocked ? styles.blocked : ""}`}
                >
                  {blocked && (
                    <p className={styles.warningBanner}>
                      Suspicious email: instructions ignored, sent to the ReTren team
                      <span className={styles.blockedStatus}>
                        Blocked — sent to the team for review
                      </span>
                    </p>
                  )}
                  <div className={styles.emailHeader}>
                    <span
                      className={`${styles.avatar} ${incoming ? styles.operatorAvatar : passenger ? styles.passengerAvatar : ""}`}
                      aria-hidden="true"
                    >
                      {incoming ? c.operator.slice(0, 1) : passenger ? "P" : "R"}
                    </span>
                    <div className={styles.senderBlock}>
                      <strong>{sender}</strong>
                      <span className={styles.meta}>to {recipient}</span>
                    </div>
                    <span className={styles.emailDate}>
                      {dateTime(m.createdAt)}
                      <small>Day {dayFrom(m.createdAt, c.sentAt)}</small>
                    </span>
                  </div>
                  <h3 className={styles.emailSubject}>{emailSubject(m.kind, c.publicRef)}</h3>
                  <div className={styles.messageTags}>
                    <span className={styles.kindTag}>{KIND_LABELS[m.kind ?? ""] ?? "Email"}</span>
                    <span className={styles.pill}>
                      {m.status === "queued"
                        ? "Queued"
                        : m.status === "sent"
                          ? "Sent"
                          : m.status === "failed"
                            ? "Failed"
                            : m.status === "blocked"
                              ? "Blocked"
                              : m.status}
                    </span>
                    {mockBody && <span className={styles.previewTag}>Preview</span>}
                  </div>
                  <p className={`${styles.emailBody} ${blocked ? styles.suspiciousBody : ""}`}>
                    {mockBody
                      ? emailPreview(m.kind, c.operator, c.publicRef, incoming)
                      : m.body || emailPreview(m.kind, c.operator, c.publicRef, incoming)}
                  </p>
                  {m.attachments.length > 0 && (
                    <ul className={styles.chips}>
                      {m.attachments.map((a, n) => (
                        <li key={`${a}-${n}`}>
                          <span className={styles.fileIcon} aria-hidden="true">
                            PDF
                          </span>
                          {ATTACHMENT_FILES[a] ?? ATTACHMENT_LABELS[a] ?? a}
                        </li>
                      ))}
                    </ul>
                  )}
                  {m.direction === "inbound" && (
                    <>
                      <p className={styles.aiFooter}>
                        <span className={styles.aiBadge}>AI</span> AI classification:{" "}
                        {CLASSIFICATIONS[m.kind ?? ""] ?? "Unclear / suspicious"} · ReTren replied
                        automatically
                      </p>
                      <p className={styles.meta}>What ReTren did next: {outcome}</p>
                    </>
                  )}
                  <details className={styles.bodyDetails}>
                    <summary>Technical details</summary>
                    <div className={styles.technicalDetails}>
                      <p>
                        <strong>From:</strong> {m.from ?? "—"}
                      </p>
                      <p>
                        <strong>To:</strong> {m.to ?? "—"}
                      </p>
                      {m.deliveredTo.length > 0 && (
                        <p>Redirected to: {m.deliveredTo.join(", ")} (demo)</p>
                      )}
                      <p>
                        <strong>Stored subject:</strong> {m.subject}
                      </p>
                      <p>
                        <strong>Kind:</strong>{" "}
                        <span className={styles.pill}>{KIND_LABELS[m.kind ?? ""] ?? "Email"}</span>{" "}
                        <code className={styles.code}>{m.kind ?? "unknown"}</code>
                      </p>
                      {m.body && <pre className={styles.mailBody}>{m.body}</pre>}
                    </div>
                  </details>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section aria-labelledby="historial" className={`${styles.card} ${styles.historyCard}`}>
        <details className={styles.historyDetails}>
          <summary>Technical history</summary>
          <h2 id="historial" className={styles.subtitle}>
            History
          </h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
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
                    <td>{dateTime(e.createdAt)}</td>
                    <td>
                      <code className={styles.code}>{e.kind}</code>
                    </td>
                    <td>
                      {e.fromStatus || e.toStatus
                        ? `${e.fromStatus ?? "—"} → ${e.toStatus ?? "—"}`
                        : "—"}
                    </td>
                    <td>{e.detail ? <code className={styles.code}>{e.detail}</code> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </main>
  );
}
