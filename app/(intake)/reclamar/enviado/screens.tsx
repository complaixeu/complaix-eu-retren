import type { ResultView, SubmissionError } from "@/features/intake";
import { Alert, ButtonLink } from "@/shared/ui";
import intake from "../_components/intake.module.css";
import { SubmitButton } from "./submit-button";
import styles from "./enviado.module.css";

const minutes = (n: number) => (n === 1 ? "1 minuto" : `${n} minutos`);

/** The three outcomes of the rules, in plain Spanish. */
export function ResultScreen({ view }: { view: ResultView }) {
  const facts: [string, string][] = [["Referencia", view.publicRef]];
  if (view.sendDate) facts.push(["Se enviará", `a partir del ${view.sendDate}`]);
  if (view.percent !== null && view.kind !== "not_eligible") {
    facts.push(["Indemnización", `${view.percent} %`]);
  }

  return (
    <>
      <Alert tone="success" title="Hemos recibido tu solicitud">
        Está registrada. Consulta aquí el resultado y los siguientes pasos.
      </Alert>
      {view.kind === "eligible" && (
        <Alert tone="success" title="Tu viaje da derecho a reclamar">
          {view.reason}
        </Alert>
      )}
      {view.kind === "doubtful" && (
        <Alert tone="warning" title="Tu derecho es dudoso, pero reclamamos igualmente">
          {view.reason}
        </Alert>
      )}
      {view.kind === "not_eligible" && (
        <Alert tone="info" title="Este viaje no da derecho a indemnización">
          {view.reason}
        </Alert>
      )}

      <p className={intake.lead}>
        {view.delayMinutes > 0
          ? `Tu tren llegó con ${minutes(view.delayMinutes)} de retraso.`
          : "Tu tren no llegó con retraso."}
      </p>

      <section aria-labelledby="resumen" className={styles.summary}>
        <h2 id="resumen" className={styles.heading}>
          Tu reclamación
        </h2>
        <dl className={styles.facts}>
          {facts.map(([label, value]) => (
            <div key={label} className={styles.pair}>
              <dt className={styles.fact}>{label}</dt>
              <dd className={styles.value}>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className={styles.next}>
        <h2 className={styles.heading}>Qué pasa ahora</h2>
        {view.kind === "not_eligible" ? (
          <p>
            No enviaremos nada a la compañía. Te escribiremos este resultado al email que nos diste.
          </p>
        ) : (
          <p>
            Esperamos hasta esa fecha para enviar la reclamación a la compañía en tu nombre. No
            tienes que hacer nada más.
          </p>
        )}
      </div>
    </>
  );
}

const MISSING: Record<SubmissionError["reason"], { text: string; action: string }> = {
  ticket_missing: { text: "No encontramos la foto de tu billete.", action: "Subir la foto" },
  review_invalid: {
    text: "Faltan datos de tu billete por revisar.",
    action: "Revisar el billete",
  },
  answers_invalid: {
    text: "Faltan respuestas sobre tu viaje.",
    action: "Responder las preguntas",
  },
  consent_missing: { text: "Falta tu autorización para reclamar.", action: "Dar la autorización" },
};

/** The draft can't be sent yet: say what is missing and link to the step that fixes it. */
export function MissingScreen({
  reason,
  href,
}: {
  reason: SubmissionError["reason"];
  href: string;
}) {
  return (
    <>
      <Alert tone="warning" title="Todavía no podemos enviar tu reclamación">
        {MISSING[reason].text} Tus datos siguen guardados.
      </Alert>
      <div>
        <ButtonLink href={href}>{MISSING[reason].action}</ButtonLink>
      </div>
    </>
  );
}

/** The claim was already made (another tab, or a retry) but this browser has no result yet. */
export function ReceivedScreen() {
  return (
    <Alert tone="success" title="Ya hemos recibido tu reclamación">
      Recarga la página en unos segundos para ver el resultado, o revisa tu email.
    </Alert>
  );
}

/** Everything is there but the claim was not created (a failure on our side): try again. */
export function ReadyScreen({
  action,
  notice,
}: {
  action: () => Promise<never>;
  notice: "fallo" | "ocupado" | null;
}) {
  return (
    <form action={action} className={styles.form}>
      {notice === "fallo" && (
        <Alert tone="error" title="No hemos podido crear tu reclamación">
          Ha fallado algo por nuestra parte. Tus datos siguen guardados: vuelve a intentarlo.
        </Alert>
      )}
      {notice === "ocupado" && (
        <Alert tone="warning" title="Tu reclamación se está enviando">
          Otra pestaña la está enviando. Espera unos segundos y pulsa el botón.
        </Alert>
      )}
      <p className={intake.lead}>Tienes todo listo. Falta enviar tu reclamación.</p>
      <div>
        <SubmitButton>Enviar reclamación</SubmitButton>
      </div>
    </form>
  );
}
