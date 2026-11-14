import type { Extractor, OcrProvider, TicketExtraction } from "@/shared/contracts";
import type { Json } from "@/shared/supabase";
import { createServiceClient } from "@/shared/supabase/server";
import {
  finishTicketUpload,
  getCurrentDraft,
  type DraftSessionDeps,
  type FinishTicketUploadResult,
} from "../draft/session";
import {
  TICKET_BUCKET,
  mergeDraftData,
  type DraftDeps,
  type IntakeDraft,
  type IntakeDraftData,
} from "../draft/store";
import { createOcr } from "../ocr";
import { createExtractor } from "./index";
import {
  decideAfterReading,
  manualExtraction,
  priorAttemptsOf,
  photoReading,
  type ReadingNext,
} from "./decision";
import { DEMO_MODEL_OUTPUTS, DEMO_OCR_TEXTS } from "./demo-fixtures";
import { neverInvent, extractionOf } from "./never-invent";

/**
 * The server step after a successful upload ([A3]): read the stored ticket, OCR it, extract its
 * fields, drop what the text doesn't show, and save the result in the draft (see ./decision.ts
 * for the keys). Server actions and server components only.
 */

export interface ReadTicketDeps extends DraftDeps {
  ocr?: OcrProvider;
  extractor?: Extractor;
}

// Built once, outside the request path: the factories throw on a configuration error. While the
// providers are `fake`, the demo tickets' fixtures make the placeholder files readable.
let defaultOcr: OcrProvider | undefined;
let defaultExtractor: Extractor | undefined;
const ocrOf = (deps: ReadTicketDeps) =>
  deps.ocr ?? (defaultOcr ??= createOcr(process.env, { fixtures: DEMO_OCR_TEXTS }));
const extractorOf = (deps: ReadTicketDeps) =>
  deps.extractor ??
  (defaultExtractor ??= createExtractor(process.env, { fixtures: DEMO_MODEL_OUTPUTS }));

/** A plain JSON copy (no `undefined` keys), as the draft stores it. */
const asJson = (extraction: TicketExtraction): Json => JSON.parse(JSON.stringify(extraction));

async function storedBytes(draft: IntakeDraft, deps: DraftDeps): Promise<Uint8Array> {
  const path = draft.ticket?.path;
  if (!path) throw new Error("draft has no ticket");
  const { data, error } = await (deps.db ?? createServiceClient()).storage
    .from(TICKET_BUCKET)
    .download(path);
  if (error || !data) throw new Error(`ticket download failed: ${error?.message ?? "no data"}`);
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Reads `draft`'s ticket and saves the outcome. `priorAttempts` is how many photos before this one
 * could not be read. Throws if a provider or the storage fails; the draft is then left unread.
 */
export async function readUploadedTicket(
  draft: IntakeDraft,
  deps: ReadTicketDeps & { priorAttempts?: number } = {},
): Promise<{ next: ReadingNext }> {
  const bytes = await storedBytes(draft, deps);
  const contentType = draft.ticket!.contentType;
  const ocr = await ocrOf(deps).readText({ bytes, contentType });

  let extraction = null;
  if (ocr.quality === "ok") {
    // The port promises the post-check; it runs again here so no adapter can skip it.
    const extracted = await extractorOf(deps).extract(ocr.text);
    extraction = extractionOf(neverInvent(extracted.data, ocr.text).data);
  }
  const readable = extraction?.quality === "ok";
  const decision = decideAfterReading({ readable, unreadableSoFar: deps.priorAttempts ?? 0 });

  const patch: IntakeDraftData =
    decision.next === "review" && extraction
      ? { extraction: asJson(extraction), ocrAttempts: 0 }
      : decision.next === "manual"
        ? { extraction: asJson(manualExtraction()), ocrAttempts: decision.ocrAttempts }
        : { ocrAttempts: decision.ocrAttempts };
  const saved = await mergeDraftData(draft.id, patch, deps);
  if (!saved) throw new Error("draft vanished while reading its ticket");
  return { next: decision.next };
}

export type FinishAndReadResult =
  | { ok: true; draft: IntakeDraft; next: ReadingNext | "failed" }
  | Extract<FinishTicketUploadResult, { ok: false }>;

/**
 * The upload step's second server call: finishes the direct upload, then reads the new ticket.
 * Each upload makes a new draft and deletes the previous one, so the unreadable count is taken
 * from the previous draft first and written into the new one (`ocrCarried`) before reading. A
 * reading failure keeps the upload and that count (`next: "failed"`): the page then offers to
 * read it again (`readCurrentTicket`).
 */
export async function finishUploadAndRead(
  deps: DraftSessionDeps & ReadTicketDeps = {},
): Promise<FinishAndReadResult> {
  const previous = await getCurrentDraft(deps);
  const priorAttempts = priorAttemptsOf(previous?.data);
  const done = await finishTicketUpload(deps);
  if (!done.ok) return done;
  try {
    if (priorAttempts > 0) {
      const carried = await mergeDraftData(done.draft.id, { ocrCarried: priorAttempts }, deps);
      if (!carried) throw new Error("draft vanished before reading its ticket");
    }
    const { next } = await readUploadedTicket(done.draft, { ...deps, priorAttempts });
    return { ok: true, draft: done.draft, next };
  } catch (error) {
    console.error(
      "[intake] ticket reading failed:",
      error instanceof Error ? error.message : error,
    );
    return { ok: true, draft: done.draft, next: "failed" };
  }
}

/**
 * Reads the current draft's ticket if it is still unread (`pending`); a ticket already read is
 * left as it is. It counts on from the draft's carried count. Throws if reading fails again.
 */
export async function readCurrentTicket(
  deps: DraftSessionDeps & ReadTicketDeps = {},
): Promise<{ ok: true; next: ReadingNext } | { ok: false; error: "no_draft" }> {
  const draft = await getCurrentDraft(deps);
  if (!draft?.ticket) return { ok: false, error: "no_draft" };
  const reading = photoReading(draft.data, draft.ticket.contentType);
  if (reading.state !== "pending") {
    const next = reading.state === "read" ? "review" : reading.state;
    return { ok: true, next };
  }
  const priorAttempts = priorAttemptsOf(draft.data);
  return { ok: true, ...(await readUploadedTicket(draft, { ...deps, priorAttempts })) };
}
