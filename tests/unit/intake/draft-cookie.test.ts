import { describe, expect, it } from "vitest";
import {
  DRAFT_COOKIE,
  draftCookieOptions,
  isLocalHost,
  parseDraftId,
} from "@/features/intake/draft/cookie";
import { DRAFT_TTL_MS } from "@/features/intake/draft/store";

// [A1] The draft id lives only in an httpOnly, SameSite=Lax cookie, Secure everywhere but on the
// developer's own machine.

describe("draftCookieOptions", () => {
  it("is httpOnly, SameSite=Lax, scoped to the flow and lives as long as the draft", () => {
    expect(draftCookieOptions("retren-dev.example.app")).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/reclamar",
      maxAge: DRAFT_TTL_MS / 1000,
    });
    expect(DRAFT_COOKIE).toMatch(/^[a-z_]+$/);
  });

  it("is Secure outside localhost, and when the host is unknown", () => {
    for (const host of ["retren.example", "x.vercel.app:443", "localhost.evil.example", null]) {
      expect(draftCookieOptions(host).secure).toBe(true);
    }
  });

  it("is not Secure on localhost, so plain-http local runs keep it", () => {
    for (const host of ["localhost", "localhost:3000", "127.0.0.1:3200", "[::1]:3000"]) {
      expect(isLocalHost(host)).toBe(true);
      expect(draftCookieOptions(host).secure).toBe(false);
    }
  });
});

describe("parseDraftId", () => {
  it("accepts a UUID and nothing else", () => {
    const id = "6f1c2a1e-6d9b-4d0e-9a51-6f0b8f1b2c3d";
    expect(parseDraftId(id)).toBe(id);
    expect(parseDraftId(id.toUpperCase())).toBe(id);
    for (const bad of [undefined, "", "abc", `${id}x`, "../../etc", "1; drop table"]) {
      expect(parseDraftId(bad)).toBeNull();
    }
  });
});
