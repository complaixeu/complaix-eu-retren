import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createServiceClient } from "@/shared/supabase/server";
import { Button } from "@/shared/ui";
import { getCaseView, listFixtures } from "../../../../../features/claims/team";
import { injectReply } from "../../actions";
import { isDemo, requireTeam } from "../../_lib/session";
import { dateTime, reasonLabel, statusLabel } from "../../_components/labels";
import { Notice } from "../../_components/notice";
import { ResolveForm } from "../../_components/resolve-form";
import styles from "../../team.module.css";

export const metadata: Metadata = { title: "Caso" };
export const dynamic = "force-dynamic";

export default async function TeamCasePage({
  params,
  searchParams,
}: PageProps<"/equipo/casos/[id]">) {
  await requireTeam();
  const { id } = await params;
  const query = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

  const view = await getCaseView(createServiceClient(), id);
  if (!view) notFound();
  const { case: c } = view;
  const back = `/equipo/casos/${c.id}`;
  const fixtures = isDemo() ? listFixtures(c.operator) : [];

  return (
    <>
      <p>
        <Link href="/equipo">Volver a la cola</Link>
      </p>
      <h1 className={styles.title}>Caso {c.publicRef}</h1>
      <Notice aviso={one(query.aviso)} error={one(query.error)} />

      <section aria-labelledby="resumen" className={styles.card}>
        <h2 id="resumen" className={styles.subtitle}>
          Resumen
        </h2>
        <dl>
          <dt className={styles.muted}>Estado</dt>
          <dd>
            {statusLabel(c.status)} <code className={styles.code}>{c.status}</code>
          </dd>
          <dt className={styles.muted}>Operador</dt>
          <dd>{c.operator}</dd>
          <dt className={styles.muted}>Enviada</dt>
          <dd>{dateTime(c.sentAt)}</dd>
          <dt className={styles.muted}>Envíos al operador</dt>
          <dd>{c.sendCount}</dd>
        </dl>
      </section>

      {view.open.length > 0 && (
        <section aria-labelledby="pendiente" className={styles.card}>
          <h2 id="pendiente" className={styles.subtitle}>
            Pendiente de revisar
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

      {isDemo() && (
        <section aria-labelledby="inyectar" className={styles.card}>
          <h2 id="inyectar" className={styles.subtitle}>
            Simular una respuesta del operador
          </h2>
          {fixtures.length === 0 ? (
            <p>No hay respuestas guionizadas para este operador.</p>
          ) : (
            <form action={injectReply} className={styles.inline}>
              <input type="hidden" name="caseId" value={c.id} />
              <label className={styles.label}>
                Respuesta guionizada
                <select name="fixture" className={styles.select} required>
                  {fixtures.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit">Inyectar respuesta</Button>
            </form>
          )}
          <p className={styles.muted}>
            La respuesta entra por el mismo camino que el correo real: se guarda, se clasifica y se
            actúa sobre el caso.
          </p>
        </section>
      )}

      <section aria-labelledby="mensajes" className={styles.card}>
        <h2 id="mensajes" className={styles.subtitle}>
          Mensajes
        </h2>
        {view.messages.length === 0 ? (
          <p>Este caso aún no tiene mensajes.</p>
        ) : (
          <ol className={styles.list}>
            {view.messages.map((m) => (
              <li key={m.id}>
                <p>
                  <strong>{m.direction === "inbound" ? "Recibido" : "Saliente"}</strong>
                  {" · "}
                  {m.kind ? <code className={styles.code}>{m.kind}</code> : "sin tipo"}
                  {" · "}
                  <code className={styles.code}>{m.status}</code>
                  {" · "}
                  {dateTime(m.createdAt)}
                </p>
                <p>{m.subject}</p>
                {m.body && (
                  // Operator mail is untrusted: React escapes it, and it is shown as plain text.
                  <pre className={styles.mailBody}>{m.body}</pre>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="historial" className={styles.card}>
        <h2 id="historial" className={styles.subtitle}>
          Historial
        </h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Fecha</th>
                <th scope="col">Evento</th>
                <th scope="col">Cambio de estado</th>
                <th scope="col">Detalle</th>
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
