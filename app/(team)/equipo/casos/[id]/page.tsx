import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { createServiceClient } from "@/shared/supabase/server";
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

  return (
    <>
      <p>
        <Link href="/equipo">Back to team queue</Link>
      </p>
      <h1 className={styles.title}>Case {c.publicRef}</h1>
      <Notice aviso={one(query.aviso)} error={one(query.error)} />

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
              className={styles.step}
            >
              {step}
            </li>
          ))}
        </ol>
        <p className={styles.muted}>
          Current simulated day: <strong>Day {dayFrom(now.toISOString(), c.sentAt)}</strong>
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
                <ActionSubmit pendingLabel="Processing reply…">Simulate reply</ActionSubmit>
              </form>
            )}
            <p className={styles.muted}>
              The reply follows the real inbound path: it is stored, classified, and acted on.
            </p>
          </section>
        )}

        {demo && <ClockPanel now={now.toISOString()} back={back} caseId={c.id} />}
      </div>

      <section aria-labelledby="mensajes" className={styles.card}>
        <h2 id="mensajes" className={styles.subtitle}>
          Email thread
        </h2>
        {view.messages.length === 0 ? (
          <p>This case has no email yet.</p>
        ) : (
          <ol className={styles.list}>
            {view.messages.map((m) => {
              const passenger = Boolean(m.kind?.startsWith("user_"));
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
                  className={`${styles.mailCard} ${m.direction === "inbound" ? styles.incoming : passenger ? styles.passengerMail : styles.outgoing} ${blocked ? styles.blocked : ""}`}
                >
                  <div className={styles.mailTop}>
                    <strong>
                      {m.direction === "inbound"
                        ? "From operator"
                        : passenger
                          ? "To passenger"
                          : "From ReTren"}
                    </strong>
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
                  </div>
                  {blocked && (
                    <p className={styles.blockedLabel}>Blocked — sent to the team for review</p>
                  )}
                  <p>
                    <strong>From:</strong> {m.from ?? "—"} <strong>→ To:</strong> {m.to ?? "—"}
                    {m.deliveredTo.length && m.to && !m.deliveredTo.includes(m.to)
                      ? ` · redirected to ${m.deliveredTo.join(", ")} (demo)`
                      : ""}
                  </p>
                  <p>
                    <strong>Subject:</strong> {m.subject}
                  </p>
                  <p className={styles.meta}>
                    {dateTime(m.createdAt)} · Day {dayFrom(m.createdAt, c.sentAt)} ·{" "}
                    <span className={styles.pill}>{KIND_LABELS[m.kind ?? ""] ?? "Email"}</span>
                  </p>
                  {m.attachments.length > 0 && (
                    <ul className={styles.chips}>
                      {m.attachments.map((a, n) => (
                        <li key={`${a}-${n}`}>{ATTACHMENT_LABELS[a] ?? a}</li>
                      ))}
                    </ul>
                  )}
                  {m.direction === "inbound" && (
                    <>
                      <p>
                        <strong>AI classification:</strong>{" "}
                        {CLASSIFICATIONS[m.kind ?? ""] ?? "Unclear / suspicious"}
                      </p>
                      <p>
                        <strong>What ReTren did next:</strong> {outcome}
                      </p>
                    </>
                  )}
                  {m.body && (
                    <>
                      <p className={styles.bodyPreview}>
                        {m.body.split(/\r?\n/).slice(0, 3).join("\n")}
                      </p>
                      <details className={styles.bodyDetails}>
                        <summary>Show full email body (plain text)</summary>
                        <pre className={styles.mailBody}>{m.body}</pre>
                      </details>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section aria-labelledby="historial" className={styles.card}>
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
      </section>
    </>
  );
}
