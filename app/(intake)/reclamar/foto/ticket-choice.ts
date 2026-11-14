/**
 * The upload form's instant check in the browser, so a wrong or oversize file is flagged before
 * it is sent. The rules come from the server as props (client code can't import the intake
 * domain); the server checks the file again by its bytes, and that check is the one that counts.
 */

export type TicketChoiceError = "missing" | "empty" | "too_large" | "wrong_type";
export type TicketUploadErrorCode = TicketChoiceError | "failed";

/** Mirrors `ticketUploadRules` in features/intake/upload/rules.ts. */
export interface TicketUploadRules {
  maxBytes: number;
  extensions: readonly string[];
  mimeTypes: readonly string[];
  /** For the file input's `accept`. */
  accept: string;
  messages: Readonly<Record<TicketUploadErrorCode, string>>;
}

/** What the upload action returns to the form. */
export type TicketUploadState =
  | { status: "idle" }
  /** `key` is an opaque ticket version (a hash), to tell when the preview shows the new ticket. */
  | { status: "ok"; key: string }
  | { status: "error"; error: TicketUploadErrorCode };

/** Mirrors `TicketPreview` in features/intake/draft/store.ts: what the preview shows. */
export interface TicketPreviewData {
  key: string;
  filename: string;
  typeLabel: string;
  sizeBytes: number;
  imageUrl: string | null;
}

/** What the browser tells us about the chosen file. */
export interface TicketChoice {
  name: string;
  size: number;
  type: string;
}

export function ticketChoiceError(
  file: TicketChoice | null | undefined,
  rules: TicketUploadRules,
): TicketChoiceError | null {
  if (!file) return "missing";
  if (file.size <= 0) return "empty";
  if (file.size > rules.maxBytes) return "too_large";
  const ext = /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase();
  const known = (ext && rules.extensions.includes(ext)) || rules.mimeTypes.includes(file.type);
  return known ? null : "wrong_type";
}

const kb = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });
const mb = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });

/** "250 KB", "1,3 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${kb.format(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${mb.format(bytes / (1024 * 1024))} MB`;
}
