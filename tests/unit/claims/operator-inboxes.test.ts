import { describe, expect, it } from "vitest";
import { operatorInboxes } from "@/features/claims/operator-inboxes";

// MAIL_OPERATOR_INBOXES (C3): per-operator test inboxes, outside production only. Pure: no DB,
// no network. Every address here is a placeholder (example.com); real ones never live in the repo.
const RENFE = "renfe-tester@example.com";
const IRYO = "iryo-tester@example.com";
const SMTP = "retren-sender@example.test";
const env = (value: string | undefined, extra: Record<string, string> = {}) => ({
  SMTP_USER: SMTP,
  MAIL_OPERATOR_INBOXES: value,
  ...extra,
});

describe("MAIL_OPERATOR_INBOXES: valid values", () => {
  it("maps each operator id to its inbox", () => {
    const map = operatorInboxes(env(`renfe:${RENFE},iryo:${IRYO}`));
    expect(map.get("renfe")).toBe(RENFE);
    expect(map.get("iryo")).toBe(IRYO);
    expect(map.size).toBe(2);
  });

  it("is empty when unset, blank or only separators", () => {
    expect(operatorInboxes(env(undefined)).size).toBe(0);
    expect(operatorInboxes(env("   ")).size).toBe(0);
    expect(operatorInboxes(env(" , ,")).size).toBe(0);
    expect(operatorInboxes({}).size).toBe(0);
  });

  it("trims whitespace and lowercases the values", () => {
    const map = operatorInboxes(
      env(`  renfe : Renfe-Tester@Example.COM ,iryo:  IRYO-tester@example.com  `),
    );
    expect(map.get("renfe")).toBe(RENFE);
    expect(map.get("iryo")).toBe(IRYO);
  });

  it("ignores a trailing comma", () => {
    expect(operatorInboxes(env(`iryo:${IRYO},`)).get("iryo")).toBe(IRYO);
  });
});

describe("MAIL_OPERATOR_INBOXES: malformed values throw", () => {
  it("an unknown operator id throws", () => {
    expect(() => operatorInboxes(env(`ave:${IRYO}`))).toThrow(/MAIL_OPERATOR_INBOXES/);
  });

  it("a bad email throws", () => {
    expect(() => operatorInboxes(env("iryo:not-an-address"))).toThrow(/MAIL_OPERATOR_INBOXES/);
    expect(() => operatorInboxes(env("iryo:"))).toThrow(/MAIL_OPERATOR_INBOXES/);
  });

  it("an entry without the operator:email shape throws", () => {
    expect(() => operatorInboxes(env(IRYO))).toThrow(/MAIL_OPERATOR_INBOXES/);
    expect(() => operatorInboxes(env(`:${IRYO}`))).toThrow(/MAIL_OPERATOR_INBOXES/);
  });

  it("an operator listed twice throws", () => {
    expect(() => operatorInboxes(env(`iryo:${IRYO},iryo:${RENFE}`))).toThrow(
      /MAIL_OPERATOR_INBOXES/,
    );
  });

  it("the same mailbox for two operators throws: a reply from it could be read as either", () => {
    expect(() => operatorInboxes(env(`renfe:${IRYO},iryo:${IRYO}`))).toThrow(
      /MAIL_OPERATOR_INBOXES/,
    );
  });

  it("an inbox equal to SMTP_USER throws, whatever the case", () => {
    expect(() => operatorInboxes(env(`iryo:${SMTP.toUpperCase()}`))).toThrow(
      /MAIL_OPERATOR_INBOXES/,
    );
    expect(() => operatorInboxes(env(`iryo:${SMTP}`))).toThrow(/SMTP_USER/);
  });

  it("an inbox equal to IMAP_USER throws too: the mailbox we read is never a tester inbox", () => {
    const withImap = { SMTP_USER: SMTP, IMAP_USER: "imap-reader@example.test" };
    expect(() =>
      operatorInboxes({ ...withImap, MAIL_OPERATOR_INBOXES: "iryo:IMAP-reader@example.test" }),
    ).toThrow(/MAIL_OPERATOR_INBOXES/);
    expect(() =>
      operatorInboxes({ ...withImap, MAIL_OPERATOR_INBOXES: "iryo:imap-reader@example.test" }),
    ).toThrow(/IMAP_USER/);
  });

  it("the error message never contains an address", () => {
    const bad = [
      `iryo:${IRYO},renfe:not-an-address`,
      `ave:${RENFE}`,
      `iryo:${IRYO},iryo:${RENFE}`,
      `renfe:${IRYO},iryo:${IRYO}`,
      `iryo:${SMTP}`,
    ];
    for (const value of bad) {
      let message = "";
      try {
        operatorInboxes(env(value));
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, value).toMatch(/MAIL_OPERATOR_INBOXES/);
      for (const address of [RENFE, IRYO, SMTP, "not-an-address"]) {
        expect(message, value).not.toContain(address);
      }
    }
  });
});

describe("MAIL_OPERATOR_INBOXES: production", () => {
  it("is ignored entirely when RETREN_ENV=production, even if malformed", () => {
    const production = { RETREN_ENV: "production" };
    expect(operatorInboxes(env(`ave:${IRYO},iryo:nope`, production)).size).toBe(0);
    expect(operatorInboxes(env(`iryo:${SMTP}`, production)).size).toBe(0);
  });

  it("NODE_ENV and VERCEL_ENV do not switch it off (there is no production, CLAUDE.md §1)", () => {
    expect(operatorInboxes(env(`iryo:${IRYO}`, { NODE_ENV: "production" })).get("iryo")).toBe(IRYO);
    expect(operatorInboxes(env(`iryo:${IRYO}`, { VERCEL_ENV: "production" })).get("iryo")).toBe(
      IRYO,
    );
  });
});
