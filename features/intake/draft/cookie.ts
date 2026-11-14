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
