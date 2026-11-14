import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "@/shared/supabase/server";
import {
  UPLOAD_PREFIX,
  declaredTicketError,
  uploadContentType,
  type DeclaredTicket,
} from "../upload/direct";
import { cleanFilename, type TicketUpload } from "../upload/read";
import type { TicketContentType, TicketUploadError } from "../upload/rules";
import { intakeStepHref } from "../steps";
import {
  DRAFT_COOKIE,
  UPLOAD_COOKIE,
  clearedCookieOptions,
  draftCookieOptions,
  encodeUploadCookie,
  parseDraftId,
  parseUploadCookie,
  uploadCookieOptions,
  type DraftCookieJar,
} from "./cookie";
import {
  TICKET_BUCKET,
  createDraftFromUpload,
  createDraft,
  deleteDraft,
  getDraft,
  mergeDraftData,
  type DraftDeps,
  type IntakeDraft,
  type IntakeDraftData,
  type IntakeDraftStatus,
} from "./store";

/**
 * The current draft of this browser, found through the httpOnly draft cookie. Server components,
 * server actions and route handlers only. Tests pass a `jar` instead of Next's `cookies()`; with
 * a `jar`, `host` defaults to null (an unknown host gets a Secure cookie).
 */
export interface DraftSessionDeps extends DraftDeps {
  jar?: DraftCookieJar;
  host?: string | null;
}

async function jarOf(deps: DraftSessionDeps): Promise<DraftCookieJar> {
  if (deps.jar) return deps.jar;
  // The draft's expiry is checked against the clock, so this only ever runs at request time,
  // never while Next prerenders (or runtime-prefetches) the page.
  await connection();
  return cookies();
}

async function hostOf(deps: DraftSessionDeps): Promise<string | null> {
  if (deps.host !== undefined) return deps.host;
  if (deps.jar) return null;
  return (await headers()).get("host");
}

/** The current, unexpired draft, or null. */
export async function getCurrentDraft(deps: DraftSessionDeps = {}): Promise<IntakeDraft | null> {
  const id = parseDraftId((await jarOf(deps)).get(DRAFT_COOKIE)?.value);
  return id ? getDraft(id, deps) : null;
}

/**
 * For every step after the upload: the current draft, or a redirect to `/reclamar/foto` when
 * there is none (no cookie, unknown id, or expired).
 */
export async function requireDraft(deps: DraftSessionDeps = {}): Promise<IntakeDraft> {
  const draft = await getCurrentDraft(deps);
  if (!draft) redirect(intakeStepHref("foto"));
  return draft;
}

/**
 * Server actions only (it sets a cookie): stores the ticket as a new draft and makes it the
 * current one. A previous draft of this browser is deleted with its ticket, so an abandoned
 * photo is not kept.
 */
export async function startDraft(
  ticket: TicketUpload,
  deps: DraftSessionDeps = {},
): Promise<IntakeDraft> {
  const draft = await createDraft(ticket, deps);
  await makeCurrent(draft, deps);
  return draft;
}

/** Points the draft cookie at `draft` and deletes this browser's previous draft, if any. */
async function makeCurrent(draft: IntakeDraft, deps: DraftSessionDeps): Promise<void> {
  const jar = await jarOf(deps);
  const previous = parseDraftId(jar.get(DRAFT_COOKIE)?.value);
  jar.set(DRAFT_COOKIE, draft.id, draftCookieOptions(await hostOf(deps)));
  if (previous && previous !== draft.id) {
    // Best effort: the new draft is already current, and the purge removes any leftover.
    await deleteDraft(previous, deps).catch(() => undefined);
  }
}

export type BeginTicketUploadResult =
  | { ok: true; uploadUrl: string; contentType: TicketContentType }
  | { ok: false; error: Exclude<TicketUploadError, "missing" | "not_received" | "failed"> };

/**
 * Server actions only. Step 1 of the direct upload: refuses what the browser declares if it
 * could never pass, then returns a signed URL the browser PUTs the file to, with the content type
 * to send (the bucket only takes ours). The staged object is remembered in an httpOnly cookie.
 */
export async function beginTicketUpload(
  declared: DeclaredTicket,
  deps: DraftSessionDeps = {},
): Promise<BeginTicketUploadResult> {
  const refused = declaredTicketError(declared);
  const contentType = uploadContentType(declared);
  if (refused || !contentType) return { ok: false, error: refused ?? "wrong_type" };

  const id = randomUUID();
  const { data, error } = await (deps.db ?? createServiceClient()).storage
    .from(TICKET_BUCKET)
    .createSignedUploadUrl(`${UPLOAD_PREFIX}${id}`);
  if (error || !data) throw new Error(`signed upload URL failed: ${error?.message ?? "no data"}`);

  const jar = await jarOf(deps);
  jar.set(
    UPLOAD_COOKIE,
    encodeUploadCookie(id, cleanFilename(String(declared.name))),
    uploadCookieOptions(await hostOf(deps)),
  );
  return { ok: true, uploadUrl: data.signedUrl, contentType };
}

export type FinishTicketUploadResult =
  | { ok: true; draft: IntakeDraft }
  | { ok: false; error: "empty" | "too_large" | "wrong_type" | "not_received" };

/**
 * Server actions only. Step 2: checks the object this browser staged (from the upload cookie,
 * never from the request), and on success makes it the current draft.
 */
export async function finishTicketUpload(
  deps: DraftSessionDeps = {},
): Promise<FinishTicketUploadResult> {
  const jar = await jarOf(deps);
  const upload = parseUploadCookie(jar.get(UPLOAD_COOKIE)?.value);
  if (!upload) return { ok: false, error: "not_received" };

  const result = await createDraftFromUpload(upload, deps);
  if (result.ok || result.error !== "not_received") {
    // Done with this staged object either way (it is moved, or it was deleted).
    jar.set(UPLOAD_COOKIE, "", clearedCookieOptions(await hostOf(deps)));
  }
  if (!result.ok) return result;
  await makeCurrent(result.draft, deps);
  return { ok: true, draft: result.draft };
}

/**
 * Server actions: merges `patch` into the current draft's data (see `mergeDraftData`), or
 * redirects to `/reclamar/foto` when there is no current draft.
 */
export async function updateCurrentDraft(
  patch: IntakeDraftData,
  options: DraftSessionDeps & { status?: IntakeDraftStatus } = {},
): Promise<IntakeDraft> {
  const draft = await requireDraft(options);
  const updated = await mergeDraftData(draft.id, patch, options);
  if (!updated) redirect(intakeStepHref("foto"));
  return updated;
}
