import { describe, expect, it } from "vitest";
import { decideRoute, type InboundCase, type RouteInput } from "@/features/claims/inbound";
import { buildMailMessage, redirectRecipients } from "@/features/claims/outbound";

// Per-operator test inboxes (MAIL_OPERATOR_INBOXES, C3). Outbound routing and the inbound sender
// rule, pure. Every address is a placeholder (example.com); real ones never live in the repo.
const RENFE_TESTER = "renfe-tester@example.com";
const IRYO_TESTER = "iryo-tester@example.com";
const OPERATOR = "atencion.cliente@iryo.eu";
const USER = "viajero.prueba@example.test";
const TEAM = "equipo@retren.example";
const SMTP = "retren@retren.example";
const withInboxes = {
  SMTP_USER: SMTP,
  MAIL_REDIRECT_ALL_TO: TEAM,
  MAIL_OPERATOR_INBOXES: `renfe:${RENFE_TESTER},iryo:${IRYO_TESTER}`,
};
const threaded = {
  from: "reclamaciones@retren.invalid",
  subject: "Recordatorio",
  text: "Texto",
  publicRef: "RTN-AB12",
  messageId: "<rtn-ab12.x@retren.example>",
  thread: [{ message_id: "<a@retren.example>", created_at: "2026-01-20T10:00:00Z" }],
  attachments: [],
};

describe("outbound: operator mail goes to the operator's mapped inbox", () => {
  it("each operator's mail goes to its own mapped inbox", () => {
    expect(redirectRecipients([OPERATOR], withInboxes, "gmail", "iryo")).toEqual([IRYO_TESTER]);
    expect(redirectRecipients([OPERATOR], withInboxes, "gmail", "renfe")).toEqual([RENFE_TESTER]);
    expect(
      buildMailMessage({ ...threaded, to: OPERATOR, operator: "iryo" }, withInboxes).to,
    ).toEqual([IRYO_TESTER]);
    expect(
      buildMailMessage({ ...threaded, to: OPERATOR, operator: "renfe" }, withInboxes).to,
    ).toEqual([RENFE_TESTER]);
  });

  it("an operator without a mapped inbox keeps MAIL_REDIRECT_ALL_TO", () => {
    const env = { MAIL_REDIRECT_ALL_TO: TEAM, MAIL_OPERATOR_INBOXES: `iryo:${IRYO_TESTER}` };
    expect(redirectRecipients([OPERATOR], env, "gmail", "ouigo")).toEqual([TEAM]);
    expect(buildMailMessage({ ...threaded, to: OPERATOR, operator: "ouigo" }, env).to).toEqual([
      TEAM,
    ]);
  });

  it("user notices and mail without an operator keep MAIL_REDIRECT_ALL_TO", () => {
    expect(redirectRecipients([USER], withInboxes, "gmail")).toEqual([TEAM]);
    expect(buildMailMessage({ ...threaded, to: USER }, withInboxes).to).toEqual([TEAM]);
  });

  it("the threading headers, subject and Message-ID are the same as without a mapped inbox", () => {
    const plain = buildMailMessage({ ...threaded, to: OPERATOR }, { MAIL_REDIRECT_ALL_TO: TEAM });
    const mapped = buildMailMessage({ ...threaded, to: OPERATOR, operator: "iryo" }, withInboxes);
    expect({ ...mapped, to: plain.to }).toEqual(plain);
    expect(mapped.inReplyTo).toBe("<a@retren.example>");
    expect(mapped.references).toEqual(["<a@retren.example>"]);
    expect(mapped.subject).toBe("[RTN-AB12] Recordatorio");
  });

  it("the production switch wins: the real operator address stays", () => {
    const production = { ...withInboxes, RETREN_ENV: "production" };
    expect(redirectRecipients([OPERATOR], production, "gmail", "iryo")).toEqual([OPERATOR]);
  });

  it("a malformed MAIL_OPERATOR_INBOXES throws before any mail is built", () => {
    const bad = { MAIL_REDIRECT_ALL_TO: TEAM, MAIL_OPERATOR_INBOXES: "ave:nope@example.com" };
    expect(() => redirectRecipients([OPERATOR], bad, "gmail", "iryo")).toThrow(
      /MAIL_OPERATOR_INBOXES/,
    );
    expect(() => buildMailMessage({ ...threaded, to: OPERATOR, operator: "iryo" }, bad)).toThrow(
      /MAIL_OPERATOR_INBOXES/,
    );
  });
});

describe("inbound: a mapped inbox counts as the operator's verified address, for that operator", () => {
  const iryoCase: InboundCase = {
    id: "11111111-1111-4111-8111-111111111111",
    public_ref: "RTN-AB12",
    operator: "iryo",
    status: "sent",
    user_email: USER,
  };
  const renfeCase: InboundCase = {
    id: "22222222-2222-4222-8222-222222222222",
    public_ref: "RTN-CD34",
    operator: "renfe",
    status: "sent",
    user_email: USER,
  };
  const iryoThread: RouteInput = {
    from: IRYO_TESTER,
    refs: ["RTN-AB12"],
    threadCase: iryoCase,
    refCases: [iryoCase],
    hasAttachment: false,
    operatorDomain: "iryo.eu",
    refOperatorDomain: "iryo.eu",
    operatorInbox: IRYO_TESTER,
    refOperatorInbox: IRYO_TESTER,
    dkimPassDomains: [],
  };

  it("a mapped inbox is accepted for its operator's case, by thread", () => {
    expect(decideRoute(iryoThread)).toEqual({ kind: "operator", case: iryoCase });
  });

  it("a mapped inbox is accepted by the subject reference alone, without a DKIM pass", () => {
    expect(decideRoute({ ...iryoThread, threadCase: null })).toEqual({
      kind: "operator",
      case: iryoCase,
    });
  });

  it("the Renfe tester inbox is never accepted as Iryo's", () => {
    const byThread = { ...iryoThread, from: RENFE_TESTER };
    expect(decideRoute(byThread)).toEqual({
      kind: "queue",
      case: iryoCase,
      reason: "wrong_sender",
    });
    const byRef = { ...iryoThread, threadCase: null, from: RENFE_TESTER };
    expect(decideRoute(byRef)).toEqual({
      kind: "queue",
      case: iryoCase,
      reason: "spoofed_reference",
    });
  });

  it("the Iryo tester inbox is accepted for a Renfe case only when Renfe maps it", () => {
    const renfeMapped: RouteInput = {
      ...iryoThread,
      from: RENFE_TESTER,
      threadCase: renfeCase,
      refCases: [renfeCase],
      refs: ["RTN-CD34"],
      operatorDomain: null,
      refOperatorDomain: null,
      operatorInbox: RENFE_TESTER,
      refOperatorInbox: RENFE_TESTER,
    };
    expect(decideRoute(renfeMapped)).toEqual({ kind: "operator", case: renfeCase });
    const renfeUnmapped = { ...renfeMapped, operatorInbox: null, refOperatorInbox: null };
    expect(decideRoute({ ...renfeUnmapped, from: IRYO_TESTER })).toEqual({
      kind: "queue",
      case: renfeCase,
      reason: "wrong_sender",
    });
  });

  it("an address that is not mapped still fails the sender check", () => {
    const stranger = { ...iryoThread, from: "someone@example.org" };
    expect(decideRoute(stranger)).toEqual({
      kind: "queue",
      case: iryoCase,
      reason: "wrong_sender",
    });
    const strangerByRef = { ...iryoThread, threadCase: null, from: "someone@example.org" };
    expect(decideRoute(strangerByRef)).toEqual({
      kind: "queue",
      case: iryoCase,
      reason: "spoofed_reference",
    });
  });

  it("a mapped inbox does not unlock a subject that names two cases", () => {
    const twoRefs = { ...iryoThread, threadCase: null, refs: ["RTN-AB12", "RTN-CD34"] };
    expect(decideRoute(twoRefs).kind).toBe("queue");
  });
});
