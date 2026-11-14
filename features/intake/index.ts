// Domain A, intake (owner: person A). Its output reaches other domains only through
// `createCase` (domain C). These exports are for intake's own pages in app/(intake)/; no other
// domain imports intake (A → C → B).
export {
  INTAKE_STEPS,
  intakeStep,
  intakeStepFromPathname,
  intakeStepHref,
  intakeStepNeighbours,
  intakeStepperItems,
  type IntakeStep,
  type IntakeStepId,
  type IntakeStepperItem,
} from "./steps";
