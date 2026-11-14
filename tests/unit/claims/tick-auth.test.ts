import { describe, expect, it } from "vitest";
import { fixedClock } from "@/shared/clock";
import { isTickAuthorized, resolveTickNow } from "@/features/claims/tick";

// /api/claims/tick guard (plan C7): Authorization: Bearer <TICK_SECRET>, constant-time compare.
describe("isTickAuthorized", () => {
  const secret = "s3cret-value";

  it("accepts the exact bearer token", () => {
    expect(isTickAuthorized(`Bearer ${secret}`, secret)).toBe(true);
  });

  it.each([
    ["missing header", null],
    ["empty header", ""],
    ["no Bearer scheme", secret],
    ["wrong token", "Bearer nope"],
    ["token with a different length", `Bearer ${secret}x`],
    ["a prefix of the token", `Bearer ${secret.slice(0, 4)}`],
    ["Basic scheme", `Basic ${secret}`],
  ])("refuses %s", (_label, header) => {
    expect(isTickAuthorized(header, secret)).toBe(false);
  });

  it("refuses everything when TICK_SECRET is unset or empty", () => {
    expect(isTickAuthorized("Bearer ", "")).toBe(false);
    expect(isTickAuthorized("Bearer undefined", undefined)).toBe(false);
    expect(isTickAuthorized("Bearer ", undefined)).toBe(false);
  });
});

describe("resolveTickNow", () => {
  const clock = fixedClock("2026-03-01T12:00:00.000Z");
  const override = { now: "2026-06-01T00:00:00.000Z" };

  it("uses the clock without DEMO_MODE, even when the body has a now", () => {
    expect(resolveTickNow(override, {}, clock)).toEqual(clock.now());
    expect(resolveTickNow(override, { DEMO_MODE: "0" }, clock)).toEqual(clock.now());
  });

  it("honours the now override only with DEMO_MODE=1", () => {
    expect(resolveTickNow(override, { DEMO_MODE: "1" }, clock)).toEqual(new Date(override.now));
  });

  it("uses the clock when there is no override", () => {
    expect(resolveTickNow({}, { DEMO_MODE: "1" }, clock)).toEqual(clock.now());
    expect(resolveTickNow(null, { DEMO_MODE: "1" }, clock)).toEqual(clock.now());
  });

  it("rejects an override that is not an ISO date-time", () => {
    expect(() => resolveTickNow({ now: "tomorrow" }, { DEMO_MODE: "1" }, clock)).toThrow();
  });
});
