import { Alert } from "@/shared/ui";

// What the actions answer in `?aviso=` and `?error=`: codes only, mapped to English here.
const AVISOS: Record<string, string> = {
  resuelto: "Item marked as resolved.",
  reloj_movido: "Clock moved forward and queued mail processed.",
  reloj_reiniciado: "Simulated clock reset.",
};

const INYECTADO: Record<string, string> = {
  applied: "Reply processed and case status updated.",
  forwarded: "Reply processed.",
  team_queue: "Reply processed and sent to the team queue.",
  duplicate: "That reply was already recorded.",
  skipped: "Reply discarded: it did not match a case.",
  error: "Could not save the reply. Try again.",
};

const ERRORES: Record<string, string> = {
  demo_only: "This action is only available in demo mode.",
  not_found: "Case or item not found.",
  bad_fixture: "That reply fixture is not available for this operator.",
  bad_input: "Invalid input.",
  no_initial_claim: "The claim has not been sent yet, so it cannot receive a reply.",
  no_fixtures: "No reply fixtures are available for this operator.",
  ingest_failed: "Could not process the reply.",
  already_resolved: "This item was already resolved.",
  mail_config: "Mail settings are incomplete.",
  failed: "Could not complete the action.",
};

/** `buzon_<n>`: the inbox was checked and n mails were read. */
const buzon = (aviso: string) => /^buzon_(\d{1,4})$/.exec(aviso)?.[1];

export function Notice({ aviso, error }: { aviso?: string; error?: string }) {
  if (error) return <Alert tone="error">{ERRORES[error] ?? ERRORES.failed}</Alert>;
  if (!aviso) return null;
  const read = buzon(aviso);
  if (read !== undefined) {
    const n = Number(read);
    return (
      <Alert tone="success">{`Inbox checked: ${n} new ${n === 1 ? "email" : "emails"}`}</Alert>
    );
  }
  const injected = aviso.startsWith("inyectado_") ? aviso.slice("inyectado_".length) : null;
  const text = injected ? INYECTADO[injected] : AVISOS[aviso];
  return text ? <Alert tone="success">{text}</Alert> : null;
}
