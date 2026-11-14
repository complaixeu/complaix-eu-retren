import { isIP } from "node:net";

/** The part of a `Headers` object (Next's `headers()`, or `new Headers()` in tests) used here. */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * The client's IP for the consent evidence, from the first header that holds an address:
 * `x-vercel-forwarded-for` (set by Vercel's proxy), the first hop of `x-forwarded-for`, then
 * `x-real-ip`; null if none does. A value that is not an address is skipped, so nothing but an
 * IP is ever stored. Personal data: never log it.
 *
 * Only trustworthy behind Vercel's proxy, which overwrites these headers with what it saw. A
 * request that reaches the app any other way (locally, or another proxy) can put any address in
 * them, so the value is evidence of what the request claimed, not proof of where it came from.
 */
export function clientIp(headers: HeaderReader): string | null {
  return (
    address(firstHop(headers.get("x-vercel-forwarded-for"))) ??
    address(firstHop(headers.get("x-forwarded-for"))) ??
    address(headers.get("x-real-ip"))
  );
}

const firstHop = (value: string | null) => value?.split(",")[0];

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
