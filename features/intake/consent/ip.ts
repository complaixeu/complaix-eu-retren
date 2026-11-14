import { isIP } from "node:net";

/** The part of a `Headers` object (Next's `headers()`, or `new Headers()` in tests) used here. */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * The client's IP for the consent evidence: the first hop of `x-forwarded-for` (set by the proxy
 * in front of the app), else `x-real-ip`, else null. A value that is not an address is skipped,
 * so nothing but an IP is ever stored. Personal data: never log it.
 */
export function clientIp(headers: HeaderReader): string | null {
  const firstHop = headers.get("x-forwarded-for")?.split(",")[0];
  return address(firstHop) ?? address(headers.get("x-real-ip"));
}

function address(raw: string | null | undefined): string | null {
  let value = raw?.trim() ?? "";
  // "[2001:db8::1]:443" → "2001:db8::1"
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1];
  // "203.0.113.7:51234" → "203.0.113.7"
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(value);
  if (withPort) value = withPort[1];
  // "fe80::1%eth0" → "fe80::1": Postgres' inet has no zone id, and it identifies nobody.
  value = value.split("%")[0];
  if (isIP(value) === 0) return null;
  return value.toLowerCase();
}
