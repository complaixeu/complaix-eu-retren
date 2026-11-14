// Domain A, intake (owner: person A). Its output reaches other domains only through
// `createCase` (domain C), so it exports nothing to them; keep it that way (A → C → B).
//
// This is the server and cross-domain entry point: it re-exports server-only code, so never
// import it from a "use client" component. Client components get what they need as props from a
// server component (see app/(intake)/reclamar/layout.tsx), because ESLint forbids
// `@/features/intake/*` deep imports everywhere.

// Server-side only, for A1/A3 server code:
export { createOcr } from "./ocr";

// The step list, for intake's own pages in app/(intake)/ (server components):
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
