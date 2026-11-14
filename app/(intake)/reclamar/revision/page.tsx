import type { Metadata } from "next";
import { Suspense } from "react";
import {
  REVIEW_WARNING_MESSAGES,
  REVIEW_FIELDS,
  REVIEW_SECTIONS,
  intakeStepHref,
  intakeStepNeighbours,
  readReview,
  requireDraft,
  type ReviewStart,
} from "@/features/intake";
import { StepPage, stepTitle } from "../_components/step-page";
import styles from "../_components/intake.module.css";
import { saveReview } from "./actions";
import { ReviewForm } from "./review-form";
import type { ReviewSectionView } from "./review-state";

export const metadata: Metadata = stepTitle("revision");

export default function RevisionPage() {
  // The draft comes from the request's cookie, so the whole step renders at request time.
  return (
    <Suspense>
      <ReviewStep />
    </Suspense>
  );
}

async function ReviewStep() {
  const draft = await requireDraft();
  const start = readReview(draft.data);
  const { previous } = intakeStepNeighbours("revision");
  return (
    <>
      <StepPage step="revision">
        <p className={styles.lead}>{lead(start)}</p>
      </StepPage>
      <ReviewForm
        action={saveReview}
        sections={sectionsFor(start)}
        values={valuesFor(start)}
        missingCount={start.source === "extraction" ? start.missing.length : 0}
        warningMessages={REVIEW_WARNING_MESSAGES}
        backHref={intakeStepHref(previous!)}
      />
    </>
  );
}

function lead(start: ReviewStart): string {
  return start.source === "manual"
    ? "Escribe los datos tal como aparecen en el billete. Fíjate bien en el localizador: la compañía lo usa para encontrar tu viaje."
    : "Comprueba lo que hemos leído en el billete y corrige lo que haga falta. El localizador tiene que estar bien: la compañía lo usa para encontrar tu viaje.";
}

/** The fields by section. Missing ones are marked only over a real read: by hand, all are. */
function sectionsFor(start: ReviewStart): ReviewSectionView[] {
  const marked = new Set(start.source === "extraction" ? start.missing : []);
  return REVIEW_SECTIONS.map((section) => ({
    id: section.id,
    title: section.title,
    fields: REVIEW_FIELDS.filter((f) => f.section === section.id).map((field) => ({
      name: field.name,
      label: field.label,
      kind: field.kind,
      required: field.required,
      help: "help" in field ? field.help : undefined,
      options: "options" in field ? field.options : undefined,
      autoComplete: "autoComplete" in field ? field.autoComplete : undefined,
      inputMode: "inputMode" in field ? field.inputMode : undefined,
      missing: marked.has(field.name),
    })),
  }));
}

function valuesFor(start: ReviewStart): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(start.ticket)) {
    if (typeof value === "string") values[name] = value;
  }
  // Never pre-confirmed, not even over a saved review: the localizador is checked on every
  // submit, and a page without JavaScript can't skip it by editing it.
  return values;
}
