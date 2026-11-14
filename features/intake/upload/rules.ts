/**
 * What the ticket upload accepts (docs/plans/A-intake.md A1): a JPG, PNG or HEIC photo or a PDF,
 * up to 10 MB. The server decides the type from the file's first bytes ("magic bytes"), never
 * from its name or the MIME type the browser sends. Pure: no I/O, safe to unit test.
 *
 * HEIC is accepted because iPhones save photos as HEIC by default. Google Cloud Vision cannot
 * read HEIC, so A3 must convert it (or ask for a JPG) before OCR; see the A2 review.
 */

export const TICKET_MAX_BYTES = 10 * 1024 * 1024;

export const TICKET_TYPES = {
  jpeg: { contentType: "image/jpeg", extension: "jpg", label: "JPG", previewable: true },
  png: { contentType: "image/png", extension: "png", label: "PNG", previewable: true },
  heic: { contentType: "image/heic", extension: "heic", label: "HEIC", previewable: false },
  pdf: { contentType: "application/pdf", extension: "pdf", label: "PDF", previewable: false },
} as const;

export type TicketType = keyof typeof TICKET_TYPES;
export type TicketContentType = (typeof TICKET_TYPES)[TicketType]["contentType"];

/** How many leading bytes `detectTicketType` needs at most (an `ftyp` box with a few brands). */
export const TICKET_SNIFF_BYTES = 64;

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

// HEIC brands (ISO/IEC 23008-12). `mif1`/`msf1` are generic HEIF, also used by AVIF, so they
// count only when a HEVC brand is listed as compatible.
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
const HEIF_GENERIC = new Set(["mif1", "msf1"]);

function isHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return false;
  const major = ascii(bytes, 8, 12);
  if (HEIC_BRANDS.has(major)) return true;
  if (!HEIF_GENERIC.has(major)) return false;
  const boxSize = Math.min(
    (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3],
    bytes.length,
  );
  // Compatible brands start after the major brand (4) and the minor version (4).
  for (let at = 16; at + 4 <= boxSize; at += 4) {
    if (HEIC_BRANDS.has(ascii(bytes, at, at + 4))) return true;
  }
  return false;
}

/** The ticket type of a file from its first bytes, or null if it is not one we accept. */
export function detectTicketType(head: Uint8Array): TicketType | null {
  if (startsWith(head, JPEG)) return "jpeg";
  if (startsWith(head, PNG)) return "png";
  if (startsWith(head, PDF)) return "pdf";
  if (isHeic(head)) return "heic";
  return null;
}

export type TicketUploadError = "missing" | "empty" | "too_large" | "wrong_type" | "failed";

export type TicketValidation =
  { ok: true; type: TicketType } | { ok: false; error: Exclude<TicketUploadError, "failed"> };

/** Checks size first (cheap), then the type from the leading bytes. */
export function validateTicket(file: { size: number; head: Uint8Array } | null): TicketValidation {
  if (!file) return { ok: false, error: "missing" };
  if (file.size <= 0) return { ok: false, error: "empty" };
  if (file.size > TICKET_MAX_BYTES) return { ok: false, error: "too_large" };
  const type = detectTicketType(file.head);
  return type ? { ok: true, type } : { ok: false, error: "wrong_type" };
}

/** What each error tells the user: what happened, then what to do. */
export const TICKET_UPLOAD_ERRORS: Record<TicketUploadError, string> = {
  missing: "Elige la foto o el PDF de tu billete.",
  empty: "El archivo está vacío. Elige otra foto o el PDF del billete.",
  too_large:
    "El archivo pesa más de 10 MB. Haz la foto con menos resolución o sube el PDF del billete.",
  wrong_type:
    "Este archivo no es una foto ni un PDF. Sube una foto en JPG, PNG o HEIC, o el PDF del billete.",
  failed: "No hemos podido guardar el billete. Vuelve a intentarlo en unos minutos.",
};

/**
 * The same rules as plain data, for the upload form's instant check in the browser (client
 * components can't import this domain). The server check above is the one that counts.
 */
export const ticketUploadRules = {
  maxBytes: TICKET_MAX_BYTES,
  extensions: ["jpg", "jpeg", "png", "heic", "heif", "pdf"],
  mimeTypes: ["image/jpeg", "image/png", "image/heic", "image/heif", "application/pdf"],
  accept:
    ".jpg,.jpeg,.png,.heic,.heif,.pdf,image/jpeg,image/png,image/heic,image/heif,application/pdf",
  messages: TICKET_UPLOAD_ERRORS,
};
