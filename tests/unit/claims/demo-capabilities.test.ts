import { describe, expect, it } from "vitest";
import { TeamActionError, assertDemoCapability, demoCapabilities } from "@/features/claims/team";
import { createGmailTransport } from "@/features/claims/transport";

// [C9] Which demo tools a deployment gets, from DEMO_MODE, MAIL_PROVIDER, RETREN_ENV, the redirect
// and whether team Auth is configured. One rule, pure, tested row by row.
const SMTP = {
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "465",
  SMTP_SECURE: "true",
  SMTP_USER: "retren@example.com",
  SMTP_PASS: "not-a-real-password",
};
const REDIRECT = "team@example.com";
/** Team Auth configured (placeholder values): real mail needs a signed-in team member. */
const AUTH = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-placeholder",
};
/** DEV with real mail: the redirect is set, the environment is not production, Auth is on. */
const DEV_REAL = {
  DEMO_MODE: "1",
  MAIL_PROVIDER: "gmail",
  MAIL_REDIRECT_ALL_TO: REDIRECT,
  ...SMTP,
  ...AUTH,
};

const NOTHING = { clock: false, simulateReply: false, checkInbox: false };
const FAKE_MAIL = { clock: true, simulateReply: true, checkInbox: false };
const REAL_MAIL = { clock: true, simulateReply: false, checkInbox: true };

describe("demoCapabilities: the rule", () => {
  it.each([
    ["DEMO_MODE unset", {}],
    ["DEMO_MODE=0", { DEMO_MODE: "0" }],
    ["DEMO_MODE=true", { DEMO_MODE: "true" }],
    ["DEMO_MODE off, real mail otherwise ready", { ...DEV_REAL, DEMO_MODE: "0" }],
  ])("%s: no demo tools", (_, env) => {
    expect(demoCapabilities(env)).toEqual(NOTHING);
  });

  it.each([
    ["MAIL_PROVIDER unset", { DEMO_MODE: "1" }],
    ["MAIL_PROVIDER=fake", { DEMO_MODE: "1", MAIL_PROVIDER: "fake" }],
    [
      "MAIL_PROVIDER=fake in production",
      { DEMO_MODE: "1", MAIL_PROVIDER: "fake", RETREN_ENV: "production" },
    ],
  ])("%s: the clock and the simulated reply, no inbox check", (_, env) => {
    expect(demoCapabilities(env)).toEqual(FAKE_MAIL);
  });

  it("gmail with a valid redirect outside production: the clock and the inbox check, never a simulated reply", () => {
    expect(demoCapabilities(DEV_REAL)).toEqual(REAL_MAIL);
    expect(demoCapabilities({ ...DEV_REAL, RETREN_ENV: "development" })).toEqual(REAL_MAIL);
  });

  it("accepts a redirect written with spaces or capitals", () => {
    expect(demoCapabilities({ ...DEV_REAL, MAIL_REDIRECT_ALL_TO: " Team@Example.com " })).toEqual(
      REAL_MAIL,
    );
  });

  it.each([
    [
      "open mode (no team Auth), with the redirect",
      { ...DEV_REAL, NEXT_PUBLIC_SUPABASE_URL: undefined },
    ],
    ["production, with the redirect", { ...DEV_REAL, RETREN_ENV: "production" }],
    ["no redirect", { ...DEV_REAL, MAIL_REDIRECT_ALL_TO: undefined }],
    ["an empty redirect", { ...DEV_REAL, MAIL_REDIRECT_ALL_TO: "   " }],
    ["a redirect that is not an address", { ...DEV_REAL, MAIL_REDIRECT_ALL_TO: "team at example" }],
    [
      "a redirect that is the sending mailbox",
      { ...DEV_REAL, MAIL_REDIRECT_ALL_TO: "RETREN@example.com" },
    ],
  ])("gmail with %s: no demo tools", (_, env) => {
    expect(demoCapabilities(env)).toEqual(NOTHING);
  });

  it.each([
    ["smtp", "smtp"],
    ["an empty value", ""],
    ["a provider in another case", "GMAIL"],
  ])("an unknown provider (%s) gets no demo tools", (_, provider) => {
    expect(demoCapabilities({ ...DEV_REAL, MAIL_PROVIDER: provider })).toEqual(NOTHING);
  });
});

describe("assertDemoCapability", () => {
  it("passes for the capabilities the environment has", () => {
    expect(() => assertDemoCapability("checkInbox", DEV_REAL)).not.toThrow();
    expect(() => assertDemoCapability("clock", DEV_REAL)).not.toThrow();
    expect(() => assertDemoCapability("simulateReply", FAKE_ONLY)).not.toThrow();
  });

  it("refuses the rest with the demo_only code", () => {
    for (const [cap, env] of [
      ["simulateReply", DEV_REAL],
      ["checkInbox", FAKE_ONLY],
      ["clock", { ...DEV_REAL, RETREN_ENV: "production" }],
    ] as const) {
      let caught: unknown;
      try {
        assertDemoCapability(cap, env);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(TeamActionError);
      expect((caught as TeamActionError).code).toBe("demo_only");
    }
  });
});

const FAKE_ONLY = { DEMO_MODE: "1", MAIL_PROVIDER: "fake" };

describe("real mail can still only reach the redirected inboxes", () => {
  it("without a redirect outside production there is no clock, and no gmail transport either", () => {
    const noRedirect = { ...DEV_REAL, MAIL_REDIRECT_ALL_TO: undefined };
    expect(demoCapabilities(noRedirect).clock).toBe(false);
    // The transport's own rule, still in force for the clock's sends.
    expect(() => createGmailTransport(noRedirect)).toThrow(/MAIL_REDIRECT_ALL_TO/);
  });

  it("with the redirect, the transport is built, and production never gets the demo clock", () => {
    expect(demoCapabilities(DEV_REAL).clock).toBe(true);
    expect(() => createGmailTransport(DEV_REAL)).not.toThrow();
    expect(demoCapabilities({ ...DEV_REAL, RETREN_ENV: "production" }).clock).toBe(false);
  });
});
