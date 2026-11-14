/**
 * The upload form's instant check in the browser, so a wrong or oversize file is flagged before
 * it is sent. The rules come from the server as props (client code can't import the intake
 * domain); the server checks the file again by its bytes, and that check is the one that counts.
 */

export type TicketChoiceError = "missing" | "empty" | "too_large" | "wrong_type";
export type TicketUploadErrorCode = TicketChoiceError | "not_received" | "failed";

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

/**
 * Mirrors `PhotoReading` in features/intake/extraction/decision.ts: whether the stored ticket
 * was read (`read`), will be typed by hand (`manual`), needs another photo (`retry`; `heic` when
 * its format is the reason) or is still unread after a failure on our side (`pending`).
 */
export interface TicketReadingData {
  state: "read" | "manual" | "retry" | "pending";
  heic: boolean;
}

/** What the "Leer el billete" action returns; on success the step re-renders with the result. */
export type ReadTicketState = { status: "idle" } | { status: "ok" } | { status: "error" };
export type ReadTicket = () => Promise<ReadTicketState>;

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

/** What the browser declares before uploading (the server re-checks the stored file). */
export interface DeclaredTicketInput {
  name: string;
  type: string;
  size: number;
}

export type BeginUploadState =
  | { status: "ready"; uploadUrl: string; contentType: string }
  | { status: "error"; error: TicketUploadErrorCode };

export type BeginUpload = (declared: DeclaredTicketInput) => Promise<BeginUploadState>;
export type FinishUpload = () => Promise<TicketUploadState>;

export type TicketUploadStage = "preparing" | "uploading" | "checking";
export interface TicketTransferProgress {
  percent: number;
  secondsRemaining: number | null;
}
export interface TicketUploadFeedback {
  onStage?: (stage: TicketUploadStage) => void;
  onProgress?: (progress: TicketTransferProgress) => void;
}

async function storageRefusedSize(res: Response): Promise<boolean> {
  if (res.status === 413) return true;
  try {
    const body = (await res.json()) as { statusCode?: string | number };
    return String(body.statusCode) === "413";
  } catch {
    return false;
  }
}

/**
 * The direct upload, from the browser: ask our server for a signed upload URL, PUT the file
 * straight to Storage, then ask our server to check it and make the draft. Our server never
 * receives the file, so no hosting body-size limit applies. The actions return their expected
 * failures; if one throws (the platform refused the request, or a bug), the error propagates to
 * the step's error page.
 */
export async function sendTicket(
  file: File,
  steps: { begin: BeginUpload; finish: FinishUpload; put?: typeof fetch },
  feedback: TicketUploadFeedback = {},
): Promise<TicketUploadState> {
  const put = steps.put ?? fetch;
  feedback.onStage?.("preparing");
  const begun = await steps.begin({ name: file.name, type: file.type, size: file.size });
  if (begun.status === "error") return begun;

  let res: Response;
  feedback.onStage?.("uploading");
  try {
    res = steps.put
      ? await put(begun.uploadUrl, {
          method: "PUT",
          headers: { "content-type": begun.contentType, "x-upsert": "false" },
          body: file,
        })
      : await putWithProgress(begun.uploadUrl, file, begun.contentType, feedback.onProgress);
  } catch {
    return { status: "error", error: "not_received" };
  }
  if (!res.ok) {
    const tooLarge = await storageRefusedSize(res);
    return { status: "error", error: tooLarge ? "too_large" : "not_received" };
  }
  feedback.onStage?.("checking");
  return steps.finish();
}

/** XHR exposes the browser's real upload byte count; fetch only resolves after the PUT completes. */
function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress?: TicketUploadFeedback["onProgress"],
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const startedAt = performance.now();
    request.open("PUT", url);
    request.setRequestHeader("content-type", contentType);
    request.setRequestHeader("x-upsert", "false");
    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      const elapsed = (performance.now() - startedAt) / 1000;
      const rate = elapsed > 0 ? event.loaded / elapsed : 0;
      const secondsRemaining =
        event.loaded >= event.total
          ? 0
          : elapsed >= 1 && event.loaded >= 1024 && rate > 0
            ? Math.ceil((event.total - event.loaded) / rate)
            : null;
      onProgress?.({
        percent: Math.min(100, Math.floor((event.loaded / event.total) * 100)),
        secondsRemaining,
      });
    });
    request.addEventListener("load", () => {
      const body = request.responseText;
      const contentType = request.getResponseHeader("content-type");
      if (request.status >= 200 && request.status <= 599) {
        if (request.status >= 200 && request.status < 300) {
          onProgress?.({ percent: 100, secondsRemaining: 0 });
        }
        resolve(
          new Response(body || null, {
            status: request.status,
            headers: contentType ? { "content-type": contentType } : undefined,
          }),
        );
      } else reject(new TypeError("Ticket upload did not receive a response"));
    });
    request.addEventListener("error", () => reject(new TypeError("Ticket upload failed")));
    request.addEventListener("abort", () => reject(new TypeError("Ticket upload was interrupted")));
    request.send(file);
  });
}
