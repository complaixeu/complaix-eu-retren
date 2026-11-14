import { stepStatuses, type StepStatus } from "@/shared/ui/stepper-state";

/**
 * The intake flow, in order. The single source of truth for the step routes, the stepper labels
 * and the page headings: later tasks reuse it instead of repeating the list.
 */
export const INTAKE_STEPS = [
  { id: "foto", label: "Billete", title: "Sube la foto de tu billete" },
  { id: "revision", label: "Revisión", title: "Revisa los datos del billete" },
  { id: "preguntas", label: "Preguntas", title: "Unas preguntas sobre el viaje" },
  { id: "mandato", label: "Autorización", title: "Autoriza a ReTren a reclamar por ti" },
  { id: "enviado", label: "Envío", title: "Resultado de tu reclamación" },
] as const;

export type IntakeStep = (typeof INTAKE_STEPS)[number];
export type IntakeStepId = IntakeStep["id"];

export interface IntakeStepperItem {
  id: IntakeStepId;
  label: string;
  status: StepStatus;
  /** Set only for steps the user may go back to. */
  href: string | undefined;
}

const indexOf = (id: IntakeStepId): number => INTAKE_STEPS.findIndex((s) => s.id === id);

export function intakeStep(id: IntakeStepId): IntakeStep {
  return INTAKE_STEPS[indexOf(id)];
}

export function intakeStepHref(id: IntakeStepId): `/reclamar/${IntakeStepId}` {
  return `/reclamar/${id}`;
}

/** The step a pathname points at (`/reclamar/<step>`), or null if it is not a step. */
export function intakeStepFromPathname(pathname: string): IntakeStepId | null {
  const match = /^\/reclamar\/([^/]+)\/?$/.exec(pathname);
  const step = match && INTAKE_STEPS.find((s) => s.id === match[1]);
  return step ? step.id : null;
}

export function intakeStepNeighbours(id: IntakeStepId): {
  previous: IntakeStepId | null;
  next: IntakeStepId | null;
} {
  const i = indexOf(id);
  return {
    previous: INTAKE_STEPS[i - 1]?.id ?? null,
    next: INTAKE_STEPS[i + 1]?.id ?? null,
  };
}

/**
 * What the stepper shows on `current`. Completed steps link back so the user can correct them;
 * later steps never link, and once the claim is sent (the last step) nothing links.
 */
export function intakeStepperItems(current: IntakeStepId): IntakeStepperItem[] {
  const statuses = stepStatuses(INTAKE_STEPS.length, indexOf(current));
  const sent = indexOf(current) === INTAKE_STEPS.length - 1;
  return INTAKE_STEPS.map((step, i) => ({
    id: step.id,
    label: step.label,
    status: statuses[i],
    href: statuses[i] === "complete" && !sent ? intakeStepHref(step.id) : undefined,
  }));
}
