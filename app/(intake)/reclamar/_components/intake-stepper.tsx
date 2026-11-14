"use client";

import { usePathname } from "next/navigation";
import { Stepper, type StepperItem } from "@/shared/ui";

/**
 * The stepper for the step in the URL. Lives in the layout, so it follows client navigation.
 * It gets its items as plain data from the server layout and imports nothing from
 * `@/features/intake`, whose entry point also carries server-only code.
 */
export function IntakeStepper({
  itemsByPath,
}: {
  itemsByPath: Readonly<Record<string, readonly StepperItem[]>>;
}) {
  const pathname = usePathname().replace(/\/$/, "");
  const items = itemsByPath[pathname];
  if (!items) return null;
  return <Stepper label="Progreso de la reclamación" items={items} />;
}
