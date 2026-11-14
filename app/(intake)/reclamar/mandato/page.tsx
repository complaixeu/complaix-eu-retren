import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import {
  CONSENT_CHOICES,
  CONSENT_DRAFT_NOTICE,
  CONSENT_TEXT_VERSION,
  MANDATE_TEXT,
  PRIVACY_NOTICE,
  buildTripSnapshot,
  intakeStepHref,
  intakeStepNeighbours,
  requireDraft,
  tripSummary,
} from "@/features/intake";
import { Alert } from "@/shared/ui";
import { StepPage, stepTitle } from "../_components/step-page";
import intake from "../_components/intake.module.css";
import { acceptMandate } from "./actions";
import { ConsentForm } from "./consent-form";
import styles from "./mandato.module.css";

export const metadata: Metadata = stepTitle("mandato");

export default function MandatoPage() {
  return (
    <>
      <StepPage step="mandato">
        <p className={intake.lead}>
          Para reclamar en tu nombre necesitamos tu autorización y tu permiso para usar tus datos.
          Léelos y marca las dos casillas.
        </p>
        <Alert tone="warning" title={CONSENT_DRAFT_NOTICE.title}>
          {CONSENT_DRAFT_NOTICE.text} Versión{" "}
          <span className={styles.version}>{CONSENT_TEXT_VERSION}</span>.
        </Alert>
        <MandateSection />
        <PrivacySection />
      </StepPage>
      {/* The draft comes from the request's cookie, so this part renders at request time. */}
      <Suspense>
        <ConsentStep />
      </Suspense>
    </>
  );
}

function MandateSection() {
  return (
    <section aria-labelledby="mandato-texto" className={styles.text}>
      <h2 id="mandato-texto" className={styles.heading}>
        {MANDATE_TEXT.title}
      </h2>
      <p>{MANDATE_TEXT.intro}</p>
      {[MANDATE_TEXT.may, MANDATE_TEXT.mayNot].map((group) => (
        <div key={group.title} className={styles.group}>
          <h3 className={styles.subheading}>{group.title}</h3>
          <ul className={styles.list}>
            {group.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
      {MANDATE_TEXT.terms.map((term) => (
        <p key={term}>{term}</p>
      ))}
    </section>
  );
}

function PrivacySection() {
  return (
    <section aria-labelledby="privacidad-texto" className={styles.text}>
      <h2 id="privacidad-texto" className={styles.heading}>
        {PRIVACY_NOTICE.title}
      </h2>
      <dl className={styles.terms}>
        {PRIVACY_NOTICE.items.map((item) => (
          <div key={item.term}>
            <dt className={styles.term}>{item.term}</dt>
            <dd className={styles.definition}>{item.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

async function ConsentStep() {
  const draft = await requireDraft();
  const trip = buildTripSnapshot(draft.data);
  if (!trip.ok) {
    redirect(intakeStepHref(trip.reason === "answers_invalid" ? "preguntas" : "revision"));
  }
  const facts = tripSummary(trip.snapshot.ticket);
  const previous = intakeStepNeighbours("mandato").previous!;
  return (
    <>
      <section aria-labelledby="viaje-autorizado" className={styles.trip}>
        <h2 id="viaje-autorizado" className={styles.heading}>
          El viaje que autorizas
        </h2>
        <dl className={styles.facts}>
          {facts.map((fact) => (
            <div key={fact.label} className={styles.pair}>
              <dt className={styles.fact}>{fact.label}</dt>
              <dd className={styles.value}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <ConsentForm
        action={acceptMandate}
        boxes={CONSENT_CHOICES}
        backHref={intakeStepHref(previous)}
      />
    </>
  );
}
