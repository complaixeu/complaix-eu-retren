// English labels for the codes shown in the team view.
const REASONS: Record<string, string> = {
  other: "Unclassified operator reply",
  wrong_sender: "Sender is not the operator",
  unknown_reference: "Unknown case reference",
  spoofed_reference: "Suspicious case reference",
  invalid_transition: "Reply does not fit the case status",
  user_reply: "Passenger reply",
  user_document_not_allowed: "Passenger document not allowed",
  forward_failed: "Document forwarding failed",
  action_failed: "Action failed",
  send_cap: "Send limit reached",
  delivery_unknown: "Delivery result is unknown",
  internal_error: "Internal sending error",
  escalation_filing_required: "File the claim with the authority",
  escalation_signature_needed: "Passenger signature needed to escalate",
};

export const reasonLabel = (code: string) => REASONS[code] ?? "Unspecified notice";

const STATUSES: Record<string, string> = {
  draft: "Draft",
  waiting_period: "Waiting period",
  sent: "Sent",
  reply_received: "Operator replied",
  waiting_user: "Waiting for passenger",
  escalated: "Escalated",
  resolved: "Resolved",
  denied: "Denied",
  closed: "Closed",
};

export const statusLabel = (code: string) => STATUSES[code] ?? code;

export const dateTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-GB", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Europe/Madrid",
      })
    : "—";

/** A short date for lists: "14 Nov". */
export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Madrid",
  });
