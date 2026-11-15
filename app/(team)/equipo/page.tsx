import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { createServiceClient } from "@/shared/supabase/server";
import { listCases, listQueue } from "../../../features/claims/team";
import { logout } from "./actions";
import { requireTeam } from "./_lib/session";
import { dateTime, operatorName, reasonLabel, statusLabel } from "./_components/labels";
import { Notice } from "./_components/notice";
import { ActionSubmit } from "./_components/action-submit";
import { ResolveForm } from "./_components/resolve-form";
import styles from "./team.module.css";

export const metadata: Metadata = { title: "Team queue" };

export default function TeamPage({ searchParams }: PageProps<"/equipo">) {
  // Everything here depends on the session, so it renders at request time (Cache Components).
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <Queue searchParams={searchParams} />
    </Suspense>
  );
}

async function Queue({ searchParams }: Pick<PageProps<"/equipo">, "searchParams">) {
  const session = await requireTeam();
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

  const db = createServiceClient();
  const [queue, cases] = await Promise.all([listQueue(db), listCases(db)]);

  return (
    <>
      <div className={styles.header}>
        <span className={styles.wordmark}>ReTren · Team</span>
        {session.email && (
          <form action={logout} className={styles.inline}>
            <span className={styles.muted}>{session.email}</span>
            <ActionSubmit pendingLabel="Signing out…" variant="quiet">
              Sign out
            </ActionSubmit>
          </form>
        )}
      </div>

      <h1 className={styles.title}>Team queue</h1>
      <Notice aviso={one(params.aviso)} error={one(params.error)} />

      <section aria-labelledby="cola" className={styles.quietCard}>
        <h2 id="cola" className={styles.subtitle}>
          Needs team review
        </h2>
        {queue.length === 0 ? (
          <p>Nothing needs review.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={`${styles.table} ${styles.stackTable}`}>
              <caption className={styles.muted}>
                Cases and emails that need a person, newest first.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Case</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Date">{dateTime(item.createdAt)}</td>
                    <td data-label="Case">
                      {item.caseId ? (
                        <Link href={`/equipo/casos/${item.caseId}`}>{item.publicRef}</Link>
                      ) : (
                        "No case"
                      )}
                    </td>
                    <td data-label="Reason">
                      {item.source === "message" ||
                      ["wrong_sender", "spoofed_reference", "unknown_reference", "other"].includes(
                        item.reason,
                      ) ? (
                        <strong className={styles.blockedQueue}>
                          Blocked — sent to the team for review
                        </strong>
                      ) : null}
                      {reasonLabel(item.reason)} <code className={styles.code}>{item.reason}</code>
                    </td>
                    <td data-label="Action">
                      <ResolveForm
                        id={item.id}
                        source={item.source}
                        back="/equipo"
                        label={`${item.publicRef ?? "email without a case"}, ${reasonLabel(item.reason)}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="casos" className={styles.quietCard}>
        <h2 id="casos" className={styles.subtitle}>
          Cases
        </h2>
        {cases.length === 0 ? (
          <p>No cases yet.</p>
        ) : (
          <ul className={styles.caseList}>
            {cases.map((c) => (
              <li key={c.id} className={styles.caseRow}>
                <div className={styles.caseTop}>
                  <Link className={styles.caseRef} href={`/equipo/casos/${c.id}`}>
                    {c.publicRef}
                  </Link>
                  <span className={styles.statusPill}>{statusLabel(c.status)}</span>
                </div>
                <p className={styles.caseMeta}>{operatorName(c.operator)}</p>
                <p className={styles.caseMeta}>
                  Sent {dateTime(c.sentAt)} · Next step {dateTime(c.nextActionAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
