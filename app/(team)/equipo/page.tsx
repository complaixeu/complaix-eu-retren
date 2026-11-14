import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Suspense } from "react";
import Link from "next/link";
import { createServiceClient } from "@/shared/supabase/server";
import { Button } from "@/shared/ui";
import { DEMO_CLOCK_COOKIE, demoNow, listCases, listQueue } from "../../../features/claims/team";
import { logout } from "./actions";
import { isDemo, requireTeam } from "./_lib/session";
import { ClockPanel } from "./_components/clock-panel";
import { dateTime, reasonLabel, statusLabel } from "./_components/labels";
import { Notice } from "./_components/notice";
import { ResolveForm } from "./_components/resolve-form";
import styles from "./team.module.css";

export const metadata: Metadata = { title: "Cola del equipo" };

export default function TeamPage({ searchParams }: PageProps<"/equipo">) {
  // Everything here depends on the session, so it renders at request time (Cache Components).
  return (
    <Suspense fallback={<p>Cargando…</p>}>
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
  const demo = isDemo();
  const now = demoNow((await cookies()).get(DEMO_CLOCK_COOKIE)?.value);

  return (
    <>
      <div className={styles.header}>
        <span className={styles.wordmark}>ReTren · Equipo</span>
        {session.email && (
          <form action={logout} className={styles.inline}>
            <span className={styles.muted}>{session.email}</span>
            <Button type="submit" variant="quiet">
              Cerrar sesión
            </Button>
          </form>
        )}
      </div>

      <h1 className={styles.title}>Cola del equipo</h1>
      <Notice aviso={one(params.aviso)} error={one(params.error)} />

      <section aria-labelledby="cola" className={styles.card}>
        <h2 id="cola" className={styles.subtitle}>
          Pendiente de revisar
        </h2>
        {queue.length === 0 ? (
          <p>No hay nada pendiente.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.muted}>
                Casos y correos que necesitan a una persona, los más recientes primero.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Caso</th>
                  <th scope="col">Motivo</th>
                  <th scope="col">Acción</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((item) => (
                  <tr key={item.id}>
                    <td>{dateTime(item.createdAt)}</td>
                    <td>
                      {item.caseId ? (
                        <Link href={`/equipo/casos/${item.caseId}`}>{item.publicRef}</Link>
                      ) : (
                        "Sin caso"
                      )}
                    </td>
                    <td>
                      {reasonLabel(item.reason)} <code className={styles.code}>{item.reason}</code>
                    </td>
                    <td>
                      <ResolveForm
                        id={item.id}
                        source={item.source}
                        back="/equipo"
                        label={`${item.publicRef ?? "correo sin caso"}, ${reasonLabel(item.reason)}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {demo && <ClockPanel now={now.toISOString()} back="/equipo" />}

      <section aria-labelledby="casos" className={styles.card}>
        <h2 id="casos" className={styles.subtitle}>
          Casos
        </h2>
        {cases.length === 0 ? (
          <p>Todavía no hay casos.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Referencia</th>
                  <th scope="col">Operador</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Enviada</th>
                  <th scope="col">Próxima acción</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/equipo/casos/${c.id}`}>{c.publicRef}</Link>
                    </td>
                    <td>{c.operator}</td>
                    <td>{statusLabel(c.status)}</td>
                    <td>{dateTime(c.sentAt)}</td>
                    <td>{dateTime(c.nextActionAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
