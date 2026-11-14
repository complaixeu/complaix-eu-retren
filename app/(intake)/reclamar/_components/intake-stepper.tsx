"use client";

import { usePathname } from "next/navigation";
import { intakeStepFromPathname, intakeStepperItems } from "@/features/intake";
import { Stepper } from "@/shared/ui";

/** The stepper for the step in the URL. Lives in the layout, so it follows client navigation. */
export function IntakeStepper() {
  const step = intakeStepFromPathname(usePathname());
  if (!step) return null;
  return <Stepper label="Progreso de la reclamación" items={intakeStepperItems(step)} />;
}
