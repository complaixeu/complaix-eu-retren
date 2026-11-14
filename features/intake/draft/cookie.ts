import { DRAFT_TTL_MS } from "./ttl";

/** The cookie that holds the current draft's id. Never put the id in a URL. */
export const DRAFT_COOKIE = "retren_draft";

export interface DraftCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/reclamar";
  maxAge: number;
}

/** The part of Next's `cookies()` store the draft session uses (a fake one in tests). */
export interface DraftCookieJar {
  get(name: string): { name: string; value: string } | undefined;
  set(name: string, value: string, options: DraftCookieOptions): void;
}

/** True for the developer's own machine, where the app runs over plain http. */
export function isLocalHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * httpOnly (scripts can't read it), SameSite=Lax (not sent on cross-site posts), Secure except on
 * localhost, scoped to the flow's pages and as long-lived as the draft itself.
 */
export function draftCookieOptions(host: string | null | undefined): DraftCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: !isLocalHost(host),
    path: "/reclamar",
    maxAge: DRAFT_TTL_MS / 1000,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The draft id from a cookie value, or null if it is not a UUID. */
export function parseDraftId(value: string | null | undefined): string | null {
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

/**
 * The cookie that ties a begun direct upload to this browser: the staged object's id and the
 * user's file name. The finishing step reads the object from here, never from the request, so a
 * browser can only finish its own upload.
 */
export const UPLOAD_COOKIE = "retren_upload";

/** How long a begun upload may take before it has to start again. */
export const UPLOAD_WINDOW_SECONDS = 30 * 60;

export function uploadCookieOptions(host: string | null | undefined): DraftCookieOptions {
  return { ...draftCookieOptions(host), maxAge: UPLOAD_WINDOW_SECONDS };
}

/** Options that remove a cookie set with `draftCookieOptions` or `uploadCookieOptions`. */
export function clearedCookieOptions(host: string | null | undefined): DraftCookieOptions {
  return { ...draftCookieOptions(host), maxAge: 0 };
}

export function encodeUploadCookie(id: string, filename: string): string {
  return `${id}:${encodeURIComponent(filename)}`;
}

/** The staged upload's id and file name, or null if the value is not one we wrote. */
export function parseUploadCookie(
  value: string | null | undefined,
): { id: string; filename: string } | null {
  if (!value) return null;
  const at = value.indexOf(":");
  const id = parseDraftId(at < 0 ? value : value.slice(0, at));
  if (!id) return null;
  try {
    return { id, filename: decodeURIComponent(value.slice(at + 1)) };
  } catch {
    return null;
  }
}
