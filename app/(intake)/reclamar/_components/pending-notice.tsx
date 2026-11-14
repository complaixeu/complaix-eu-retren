import { Alert } from "@/shared/ui";

/** Shown on steps whose screen is not built yet (A0 skeleton). Later tasks remove it. */
export function PendingNotice() {
  return <Alert>Esta pantalla todavía está en preparación: de momento no guarda nada.</Alert>;
}
