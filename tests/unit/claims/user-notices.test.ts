import { describe, expect, it } from "vitest";
import { planReplyAction, type ReplyActionContext } from "@/features/claims/actions";
import { planCase } from "@/features/claims/create-case";
import {
  checkRecipient,
  ESCALATION_SIGNATURE_KIND,
  USER_NOTICE_KINDS,
  userMailAllowed,
} from "@/features/claims/outbound";
import { dueActions } from "@/features/claims/timers";
import { getOperatorConfig } from "@/features/rules";
import { CaseStatus, ReplyCategory, TemplateKind } from "@/shared/contracts";
import { submissionFixture } from "../../fixtures/claims/submission";

// C8: the user hears from us only in the three cases of ARCHITECTURE §7, enforced by the sender
// (docs/plans/README.md §4.3). Pure: no DB.
const iryo = getOperatorConfig("iryo");
const USER = "viajero.prueba@example.test";
const OPERATOR = (() => {
  if (iryo.channel.type !== "email") throw new Error("the iryo config must have an email channel");
  return iryo.channel.address;
})();

const toUser = (template: string | null | undefined) =>
  checkRecipient({ to: USER, userEmail: USER, operator: iryo, template });

describe("the user-kind allowlist", () => {
  it("is exactly the document request, the final result and the escalation exception", () => {
    expect([...USER_NOTICE_KINDS].sort()).toEqual(
      ["user_request_document", "user_final_result", ESCALATION_SIGNATURE_KIND].sort(),
    );
    expect(ESCALATION_SIGNATURE_KIND).toBe("user_escalation_signature");
  });

  it("the escalation exception is not a TemplateKind yet (a contract change for B)", () => {
    // When shared/contracts adds it, this fails: queueEscalationSignatureRequest must then render
    // and queue it instead of refusing (features/claims/notices.ts).
    expect(TemplateKind.safeParse(ESCALATION_SIGNATURE_KIND).success).toBe(false);
  });

  it("the escalation exception is refused to the user until it is a TemplateKind", () => {
    // Nothing of ours can render it yet, so a row of that kind can't be our template.
    expect(userMailAllowed(ESCALATION_SIGNATURE_KIND)).toBe(false);
    expect(toUser(ESCALATION_SIGNATURE_KIND)).toEqual({
      ok: false,
      reason: "user_kind_not_allowed",
    });
  });

  it("the document request and the final result reach the case's own user", () => {
    for (const kind of ["user_request_document", "user_final_result"]) {
      expect(userMailAllowed(kind)).toBe(true);
      expect(toUser(kind)).toEqual({ ok: true, audience: "user" });
      // Case and spacing of the address never matter.
      expect(
        checkRecipient({
          to: ` ${USER.toUpperCase()} `,
          userEmail: USER,
          operator: iryo,
          template: kind,
        }),
      ).toEqual({ ok: true, audience: "user" });
    }
  });

  it("every other TemplateKind addressed to the user is refused", () => {
    const others = TemplateKind.options.filter((k) => !USER_NOTICE_KINDS.includes(k));
    expect(others.length).toBe(TemplateKind.options.length - 2);
    for (const kind of others) {
      expect(userMailAllowed(kind)).toBe(false);
      expect(toUser(kind)).toEqual({ ok: false, reason: "user_kind_not_allowed" });
    }
  });

  it("an unknown or missing kind addressed to the user is refused", () => {
    for (const kind of [
      null,
      undefined,
      "",
      "escalation_filing_required",
      "USER_FINAL_RESULT",
      " user_final_result",
      "user_final_result_v2",
      "close_3m",
    ]) {
      expect(userMailAllowed(kind)).toBe(false);
      expect(toUser(kind)).toEqual({ ok: false, reason: "user_kind_not_allowed" });
    }
  });

  it("a user notice addressed to anyone but the case's user is refused", () => {
    for (const kind of USER_NOTICE_KINDS) {
      // Not to another passenger, not to an attacker, and not to the operator either.
      for (const to of ["otro.viajero@example.test", "x@evil.com", OPERATOR, ""]) {
        expect(checkRecipient({ to, userEmail: USER, operator: iryo, template: kind })).toEqual({
          ok: false,
          reason: "recipient_not_allowed",
        });
      }
    }
  });

  it("operator kinds still go to the operator's verified address", () => {
    for (const kind of TemplateKind.options.filter((k) => !USER_NOTICE_KINDS.includes(k))) {
      expect(
        checkRecipient({ to: OPERATOR, userEmail: USER, operator: iryo, template: kind }),
      ).toEqual({ ok: true, audience: "operator" });
    }
  });
});

// The queue-time side (defence in depth without a new migration): every path that queues a user
// notice (C2, C6, C7) only ever plans an allowlisted kind. The plpgsql functions of C2 and C6
// check the same at queue time; C7's queues only what dueActions plans.
describe("audit: what the queueing paths plan for the user", () => {
  const NOW = new Date("2030-03-01T10:00:00.000Z");
  const DAY = 86_400_000;

  it("createCase (C2) plans only user_final_result", () => {
    for (const days of [20, 90]) {
      const sub = submissionFixture(days);
      for (const status of ["eligible", "doubtful", "not_eligible"] as const) {
        const plan = planCase(sub, {
          status,
          reason: "audit",
          delayMinutes: 90,
          appliedRules: [],
          configVersion: "audit",
          ...(status !== "not_eligible" && { earliestSendAt: NOW.toISOString() }),
        });
        if (plan.notice) {
          expect(USER_NOTICE_KINDS).toContain(plan.notice.template);
          expect(plan.notice.to).toBe(sub.answers.email);
        }
      }
    }
  });

  it("the reply actions (C6) plan only allowlisted notices, for every category and status", () => {
    const seen = new Set<string>();
    for (const status of CaseStatus.options) {
      for (const category of ReplyCategory.options) {
        for (const insistences of [0, 1]) {
          for (const sendCount of [1, 5, 6]) {
            for (const escalationFired of [false, true]) {
              const ctx: ReplyActionContext = {
                status,
                category,
                insistences,
                sendCount,
                sentAt: new Date(NOW.getTime() - 10 * DAY).toISOString(),
                escalationFired,
                operatorReachable: true,
                now: NOW,
              };
              const plan = planReplyAction(ctx);
              if (plan.notice) {
                expect(USER_NOTICE_KINDS).toContain(plan.notice);
                seen.add(plan.notice);
              }
            }
          }
        }
      }
    }
    expect([...seen].sort()).toEqual(["user_final_result", "user_request_document"]);
  });

  it("the timers (C7) plan user mail only for the 3-month close, as user_final_result", () => {
    const users = new Set<string>();
    for (const status of CaseStatus.options) {
      for (const daysAgo of [0, 12, 30, 40, 45, 100]) {
        const r = dueActions(
          {
            status,
            sentAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
            paused: false,
            sendCount: 1,
            fired: [],
          },
          NOW,
        );
        for (const a of r.actions) {
          if (a.recipient === "user") users.add(`${a.kind}:${a.template}`);
          else expect(USER_NOTICE_KINDS).not.toContain(a.template);
        }
      }
    }
    expect([...users]).toEqual(["close_3m:user_final_result"]);
  });
});
