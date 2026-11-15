import { describe, expect, it } from "vitest";
import { effectiveOperator } from "@/features/claims/operator-inboxes";
import { getOperatorConfig } from "@/features/rules";

// The one rule for "may this operator be mailed here" (C3, Nestor's decision): outside production,
// an operator with a mapped test inbox counts as active with an email channel to that inbox, even
// when features/rules says web_form or inactive. Production and unmapped operators are unchanged.
// Placeholder addresses only (example.com).
const RENFE_TESTER = "renfe-tester@example.com";
const IRYO_TESTER = "iryo-tester@example.com";
const SMTP = "retren@retren.example";
const dev = { SMTP_USER: SMTP, MAIL_OPERATOR_INBOXES: `renfe:${RENFE_TESTER}` };

describe("effectiveOperator", () => {
  it("a mapped inactive web-form operator is an active email operator at its inbox, outside production", () => {
    const renfe = getOperatorConfig("renfe");
    expect(renfe.active).toBe(false);
    expect(renfe.channel.type).toBe("web_form");
    const effective = effectiveOperator(renfe, dev);
    expect(effective.active).toBe(true);
    expect(effective.channel).toEqual({ type: "email", address: RENFE_TESTER });
    // Everything else about the operator is kept.
    expect(effective).toEqual({ ...renfe, active: true, channel: effective.channel });
  });

  it("an unmapped operator is returned exactly as the config has it", () => {
    const ouigo = getOperatorConfig("ouigo");
    expect(effectiveOperator(ouigo, dev)).toBe(ouigo);
    expect(effectiveOperator(ouigo, {})).toBe(ouigo);
  });

  it("an operator with a mapped inbox and a real email channel uses the inbox", () => {
    const iryo = getOperatorConfig("iryo");
    const effective = effectiveOperator(iryo, {
      SMTP_USER: SMTP,
      MAIL_OPERATOR_INBOXES: `iryo:${IRYO_TESTER}`,
    });
    expect(effective.channel).toEqual({ type: "email", address: IRYO_TESTER });
    expect(effective.active).toBe(true);
  });

  it("production is unchanged, even with a mapping", () => {
    const renfe = getOperatorConfig("renfe");
    expect(effectiveOperator(renfe, { ...dev, RETREN_ENV: "production" })).toBe(renfe);
  });

  it("a malformed mapping throws, like the parser does", () => {
    expect(() =>
      effectiveOperator(getOperatorConfig("renfe"), {
        SMTP_USER: SMTP,
        MAIL_OPERATOR_INBOXES: "renfe:nope",
      }),
    ).toThrow(/MAIL_OPERATOR_INBOXES/);
  });
});
