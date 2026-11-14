import {
  TICKET_SNIFF_BYTES,
  validateTicket,
  type TicketType,
  type TicketValidation,
} from "./rules";

/** A checked ticket, ready to store. */
export interface TicketUpload {
  bytes: Uint8Array;
  /** Detected from the bytes, not from the name or the browser's MIME type. */
  type: TicketType;
  /** The user's file name, cleaned up, only to show it back to them. */
  filename: string;
}

export type ReadTicketResult =
  | { ok: true; ticket: TicketUpload }
  | { ok: false; error: Extract<TicketValidation, { ok: false }>["error"] };

const MAX_FILENAME = 120;

/** The last path segment, without control characters, trimmed and at most 120 characters. */
function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (clean.length <= MAX_FILENAME) return clean || "billete";
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 6 ? clean.slice(dot) : "";
  return clean.slice(0, MAX_FILENAME - ext.length) + ext;
}

/**
 * The server-side check of the form's `ticket` value: a file, not empty, at most 10 MB, and of
 * an accepted type by its first bytes.
 */
export async function readTicketUpload(
  value: FormDataEntryValue | null,
): Promise<ReadTicketResult> {
  // An empty file input submits a nameless, empty File.
  if (!(value instanceof File) || (value.size === 0 && value.name === "")) {
    return { ok: false, error: "missing" };
  }
  // Only the first bytes are read until the size and type are known to be fine.
  const head = new Uint8Array(await value.slice(0, TICKET_SNIFF_BYTES).arrayBuffer());
  const checked = validateTicket({ size: value.size, head });
  if (!checked.ok) return checked;

  const bytes = new Uint8Array(await value.arrayBuffer());
  return { ok: true, ticket: { bytes, type: checked.type, filename: cleanFilename(value.name) } };
}
