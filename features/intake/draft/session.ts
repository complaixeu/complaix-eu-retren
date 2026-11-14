import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { TicketUpload } from "../upload/read";
import { intakeStepHref } from "../steps";
import { DRAFT_COOKIE, draftCookieOptions, parseDraftId, type DraftCookieJar } from "./cookie";
import {
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
  const jar = await jarOf(deps);
  const previous = parseDraftId(jar.get(DRAFT_COOKIE)?.value);
  const draft = await createDraft(ticket, deps);
  jar.set(DRAFT_COOKIE, draft.id, draftCookieOptions(await hostOf(deps)));
  if (previous && previous !== draft.id) {
    // Best effort: the new draft is already current, and an orphan expires anyway.
    await deleteDraft(previous, deps).catch(() => undefined);
  }
  return draft;
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
