// Plain-Spanish labels for the codes the team view shows. The code itself is always shown too.
const REASONS: Record<string, string> = {
  other: "Respuesta que no se ha podido clasificar",
  wrong_sender: "Remitente que no es el operador",
  unknown_reference: "Referencia desconocida",
  spoofed_reference: "Referencia sospechosa",
  invalid_transition: "Respuesta que no encaja con el estado del caso",
  user_reply: "Respuesta del usuario",
  user_document_not_allowed: "Documento del usuario no permitido",
  forward_failed: "Fallo al reenviar un documento",
  action_failed: "Fallo al aplicar la acción",
  send_cap: "Límite de envíos alcanzado",
  delivery_unknown: "Envío con resultado incierto",
  internal_error: "Error interno al enviar",
  escalation_filing_required: "Hay que presentar la reclamación ante el organismo",
  escalation_signature_needed: "Hace falta la firma del usuario para escalar",
};

export const reasonLabel = (code: string) => REASONS[code] ?? "Aviso sin descripción";

const STATUSES: Record<string, string> = {
  draft: "Borrador",
  waiting_period: "En periodo de espera",
  sent: "Enviada",
  reply_received: "Respuesta recibida",
  waiting_user: "Esperando al usuario",
  escalated: "Escalada",
  resolved: "Resuelta",
  denied: "Denegada",
  closed: "Cerrada",
};

export const statusLabel = (code: string) => STATUSES[code] ?? code;

export const dateTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("es-ES", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Europe/Madrid",
      })
    : "—";
