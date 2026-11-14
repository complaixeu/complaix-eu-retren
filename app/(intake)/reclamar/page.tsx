import { redirect } from "next/navigation";
import { INTAKE_STEPS, intakeStepHref } from "@/features/intake";

/** `/reclamar` has no screen of its own: the flow starts at its first step. */
export default function ReclamarPage() {
  redirect(intakeStepHref(INTAKE_STEPS[0].id));
}
