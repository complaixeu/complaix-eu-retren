import { Alert } from "@/shared/ui";

// What the actions answer in `?aviso=` and `?error=`: codes only, mapped to plain Spanish here.
const AVISOS: Record<string, string> = {
  resuelto: "Elemento marcado como resuelto.",
  reloj_movido: "Reloj adelantado y envíos procesados.",
  reloj_reiniciado: "Reloj de demostración reiniciado.",
};

const INYECTADO: Record<string, string> = {
  applied: "La respuesta se ha procesado y el caso ha cambiado de estado.",
  forwarded: "La respuesta se ha procesado.",
  team_queue: "La respuesta se ha procesado y ha pasado a la cola del equipo.",
  duplicate: "Esa respuesta ya estaba registrada.",
  skipped: "La respuesta se ha descartado: no pertenece a ningún caso.",
  error: "No se ha podido guardar la respuesta; inténtalo de nuevo.",
};

const ERRORES: Record<string, string> = {
  demo_only: "Esta acción solo existe en modo demostración.",
  not_found: "No se ha encontrado ese caso o elemento.",
  bad_fixture: "Esa respuesta guionizada no existe para este operador.",
  bad_input: "Datos no válidos.",
  no_initial_claim: "El caso aún no tiene una reclamación enviada: no hay a qué responder.",
  no_fixtures: "No hay respuestas guionizadas para este operador.",
  ingest_failed: "No se ha podido procesar la respuesta.",
  already_resolved: "Ese elemento ya estaba resuelto.",
  failed: "No se ha podido completar la acción.",
};

export function Notice({ aviso, error }: { aviso?: string; error?: string }) {
  if (error) return <Alert tone="error">{ERRORES[error] ?? ERRORES.failed}</Alert>;
  if (!aviso) return null;
  const injected = aviso.startsWith("inyectado_") ? aviso.slice("inyectado_".length) : null;
  const text = injected ? INYECTADO[injected] : AVISOS[aviso];
  return text ? <Alert tone="success">{text}</Alert> : null;
}
