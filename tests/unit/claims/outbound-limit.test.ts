import { describe, expect, it } from "vitest";
import { OUTBOUND_TICK_LIMIT, outboundLimitFromEnv } from "@/features/claims/outbound-tick";

// The tick sends at most OUTBOUND_TICK_LIMIT queued rows per run. Integration tests share one
// database, so they may raise it with OUTBOUND_TICK_LIMIT; nothing else ever changes it.
describe("outboundLimitFromEnv", () => {
  it("defaults to OUTBOUND_TICK_LIMIT (100)", () => {
    expect(OUTBOUND_TICK_LIMIT).toBe(100);
    expect(outboundLimitFromEnv({})).toBe(100);
    expect(outboundLimitFromEnv({ OUTBOUND_TICK_LIMIT: "" })).toBe(100);
  });
  it("takes a positive whole number", () => {
    expect(outboundLimitFromEnv({ OUTBOUND_TICK_LIMIT: "5000" })).toBe(5000);
  });
  it("anything else keeps the safe default", () => {
    for (const v of ["0", "-3", "1.5", "abc", "1e9", "NaN"]) {
      expect(outboundLimitFromEnv({ OUTBOUND_TICK_LIMIT: v })).toBe(100);
    }
  });
});
