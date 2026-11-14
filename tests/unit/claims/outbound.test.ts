import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_ALLOWLIST,
  buildMailMessage,
  checkAttachments,
  checkMockText,
  checkRecipient,
  initialClaimRefusal,
  isProduction,
  isStale,
  looksLikeMockText,
  newMessageId,
  redirectRecipients,
  subjectWithRef,
  threadHeaders,
} from "@/features/claims/outbound";
import { MAX_SENDS_PER_CASE } from "@/features/claims/timers";
import { createFakeTransport, createMailTransport } from "@/features/claims/transport";
import { renderTemplate } from "@/features/documents/mock";
import { getOperatorConfig } from "@/features/rules";
import { MailMessage } from "@/shared/contracts";

// The transport's safety rules, one by one (docs/plans/README.md §4.3, C3). Pure: no DB.
const iryo = getOperatorConfig("iryo");
const renfe = getOperatorConfig("renfe");
const USER = "viajero.prueba@example.test";
const OPERATOR = "atencion.cliente@iryo.eu";
const CASE = "11111111-1111-4111-8111-111111111111";
const OTHER_CASE = "22222222-2222-4222-8222-222222222222";

describe("recipient allowlist", () => {
  it("operator mail goes only to the operator config's verified address", () => {
    expect(checkRecipient({ to: OPERATOR, userEmail: USER, operator: iryo })).toEqual({
      ok: true,
      audience: "operator",
    });
    // Case and spacing never matter; the address does.
    expect(
      checkRecipient({ to: " Atencion.Cliente@IRYO.eu ", userEmail: USER, operator: iryo }),
    ).toMatchObject({ ok: true, audience: "operator" });
  });

  it("a non-operator recipient is refused", () => {
    for (const to of ["x@evil.com", "atencion.cliente@iryo.eu.evil.com", "otro@iryo.eu", ""]) {
      expect(checkRecipient({ to, userEmail: USER, operator: iryo })).toEqual({
        ok: false,
        reason: "recipient_not_allowed",
      });
    }
  });

  it("an operator without an email channel has no allowed address", () => {
    expect(checkRecipient({ to: "x@renfe.com", userEmail: USER, operator: renfe })).toEqual({
      ok: false,
      reason: "recipient_not_allowed",
    });
  });

  it("an inactive operator is refused even at its own address", () => {
    const inactive = { ...iryo, active: false };
    expect(checkRecipient({ to: OPERATOR, userEmail: USER, operator: inactive })).toEqual({
      ok: false,
      reason: "operator_inactive",
    });
  });

  it("user mail goes only to the case's own user (C8 adds the kinds allowlist)", () => {
    expect(
      checkRecipient({ to: USER, userEmail: USER, operator: iryo, template: "user_final_result" }),
    ).toEqual({ ok: true, audience: "user" });
    expect(
      checkRecipient({
        to: "otro.viajero@example.test",
        userEmail: USER,
        operator: iryo,
        template: "user_final_result",
      }),
    ).toEqual({ ok: false, reason: "recipient_not_allowed" });
  });
});

describe("attachment allowlist", () => {
  const att = (kind: string, caseId = CASE, deletedAt: string | null = null) => ({
    kind,
    case_id: caseId,
    deleted_at: deletedAt,
  });

  it("is exactly the EU form, the mandate, the ticket and the user's documents", () => {
    expect([...ATTACHMENT_ALLOWLIST].sort()).toEqual(
      ["eu_form", "mandate", "ticket", "user_document"].sort(),
    );
    expect(
      checkAttachments([att("eu_form"), att("mandate"), att("ticket"), att("user_document")], CASE),
    ).toEqual({ ok: true });
    expect(checkAttachments([], CASE)).toEqual({ ok: true });
  });

  it("an attachment not on the allowlist is refused", () => {
    expect(checkAttachments([att("eu_form"), att("invoice")], CASE)).toEqual({
      ok: false,
      reason: "attachment_not_allowed",
    });
  });

  it("an attachment of another case is refused", () => {
    expect(checkAttachments([att("ticket", OTHER_CASE)], CASE)).toEqual({
      ok: false,
      reason: "attachment_not_allowed",
    });
  });

  it("a deleted file is refused", () => {
    expect(checkAttachments([att("user_document", CASE, "2026-01-01T00:00:00Z")], CASE)).toEqual({
      ok: false,
      reason: "attachment_not_allowed",
    });
  });
});

describe("send cap (initial claim)", () => {
  const now = new Date("2026-01-20T10:00:00Z");
  const ready = {
    status: "waiting_period" as const,
    earliestSendAt: "2026-01-17T12:30:00Z",
    sendCount: 0,
  };

  it("is six sends per case, the constant C7 uses", () => {
    expect(MAX_SENDS_PER_CASE).toBe(6);
  });

  it("a ready case is not refused", () => {
    expect(initialClaimRefusal(ready, iryo, now)).toBeNull();
    expect(
      initialClaimRefusal({ ...ready, sendCount: MAX_SENDS_PER_CASE - 2 }, iryo, now),
    ).toBeNull();
  });

  it("the cap is reached (the last slot is reserved for the d45 escalation, tracker #26)", () => {
    expect(initialClaimRefusal({ ...ready, sendCount: MAX_SENDS_PER_CASE - 1 }, iryo, now)).toBe(
      "send_cap_reached",
    );
    expect(initialClaimRefusal({ ...ready, sendCount: MAX_SENDS_PER_CASE }, iryo, now)).toBe(
      "send_cap_reached",
    );
    expect(initialClaimRefusal({ ...ready, sendCount: MAX_SENDS_PER_CASE + 3 }, iryo, now)).toBe(
      "send_cap_reached",
    );
  });

  it("is refused before earliest_send_at, at it is allowed, and refused when it is null", () => {
    const at = new Date(ready.earliestSendAt);
    expect(initialClaimRefusal(ready, iryo, new Date(at.getTime() - 1))).toBe("too_early");
    expect(initialClaimRefusal(ready, iryo, at)).toBeNull();
    expect(initialClaimRefusal({ ...ready, earliestSendAt: null }, iryo, now)).toBe(
      "no_earliest_send_at",
    );
  });

  it("only from waiting_period, and never to an inactive operator or one without email", () => {
    expect(initialClaimRefusal({ ...ready, status: "sent" }, iryo, now)).toBe("not_waiting_period");
    expect(initialClaimRefusal(ready, renfe, now)).toBe("operator_inactive");
    expect(initialClaimRefusal(ready, getOperatorConfig("ouigo"), now)).toBe("operator_inactive");
    const activeWebForm = { ...renfe, active: true };
    expect(initialClaimRefusal(ready, activeWebForm, now)).toBe("operator_has_no_email_channel");
  });
});

describe("MAIL_REDIRECT_ALL_TO", () => {
  it("replaces every recipient outside production", () => {
    const env = { MAIL_REDIRECT_ALL_TO: "equipo@retren.example" };
    expect(redirectRecipients([OPERATOR], env)).toEqual(["equipo@retren.example"]);
    expect(redirectRecipients([OPERATOR, USER], env)).toEqual(["equipo@retren.example"]);
  });

  it("there is no production: only an explicit flag turns the redirect off", () => {
    expect(isProduction({})).toBe(false);
    expect(isProduction({ NODE_ENV: "production" })).toBe(false);
    expect(isProduction({ VERCEL_ENV: "production" })).toBe(false);
    expect(isProduction({ RETREN_ENV: "production" })).toBe(true);
    const env = { MAIL_REDIRECT_ALL_TO: "equipo@retren.example", NODE_ENV: "production" };
    expect(redirectRecipients([OPERATOR], env)).toEqual(["equipo@retren.example"]);
    expect(redirectRecipients([OPERATOR], { ...env, RETREN_ENV: "production" })).toEqual([
      OPERATOR,
    ]);
  });

  it("unset or blank is a no-op only for the fake provider", () => {
    expect(redirectRecipients([OPERATOR], {})).toEqual([OPERATOR]);
    expect(redirectRecipients([OPERATOR], { MAIL_REDIRECT_ALL_TO: "  " })).toEqual([OPERATOR]);
    expect(redirectRecipients([OPERATOR], {}, "fake")).toEqual([OPERATOR]);
  });

  it("fails safe: a real provider outside production needs the redirect", () => {
    for (const env of [{}, { MAIL_REDIRECT_ALL_TO: "  " }, { MAIL_PROVIDER: "gmail" }]) {
      expect(() => redirectRecipients([OPERATOR], env, "gmail")).toThrow(/MAIL_REDIRECT_ALL_TO/);
    }
    // MAIL_PROVIDER from env counts when no provider name is given.
    expect(() => redirectRecipients([OPERATOR], { MAIL_PROVIDER: "gmail" })).toThrow(
      /MAIL_REDIRECT_ALL_TO/,
    );
    expect(redirectRecipients([OPERATOR], { RETREN_ENV: "production" }, "gmail")).toEqual([
      OPERATOR,
    ]);
    expect(
      redirectRecipients([OPERATOR], { MAIL_REDIRECT_ALL_TO: "equipo@retren.example" }, "gmail"),
    ).toEqual(["equipo@retren.example"]);
  });

  it("an invalid redirect address throws instead of sending to the real recipient", () => {
    expect(() =>
      redirectRecipients([OPERATOR], { MAIL_REDIRECT_ALL_TO: "not-an-address" }),
    ).toThrow(/MAIL_REDIRECT_ALL_TO/);
  });
});

describe("threading headers", () => {
  it("the subject carries [RTN-<ref>] exactly once", () => {
    expect(subjectWithRef("Reclamación", "RTN-0A1B2C3D")).toBe("[RTN-0A1B2C3D] Reclamación");
    expect(subjectWithRef("[RTN-0A1B2C3D] Reclamación", "RTN-0A1B2C3D")).toBe(
      "[RTN-0A1B2C3D] Reclamación",
    );
    expect(subjectWithRef("Re: [RTN-0A1B2C3D] Reclamación", "RTN-0A1B2C3D")).toBe(
      "Re: [RTN-0A1B2C3D] Reclamación",
    );
  });

  it("a new Message-ID is unique, in our domain and names the case", () => {
    const a = newMessageId("RTN-0A1B2C3D", "retren.example");
    const b = newMessageId("RTN-0A1B2C3D", "retren.example");
    expect(a).toMatch(/^<rtn-0a1b2c3d\.[0-9a-f-]{36}@retren\.example>$/);
    expect(a).not.toBe(b);
  });

  it("the first mail of a thread has no In-Reply-To nor References", () => {
    expect(threadHeaders([])).toEqual({});
  });

  it("In-Reply-To is the latest mail of the thread, References the whole thread in order", () => {
    const thread = [
      { message_id: "<b@iryo.eu>", created_at: "2026-01-21T10:00:00Z" },
      { message_id: "<a@retren.example>", created_at: "2026-01-20T10:00:00Z" },
      { message_id: null, created_at: "2026-01-22T10:00:00Z" },
      { message_id: "<c@retren.example>", created_at: "2026-01-23T10:00:00Z" },
    ];
    expect(threadHeaders(thread)).toEqual({
      inReplyTo: "<c@retren.example>",
      references: ["<a@retren.example>", "<b@iryo.eu>", "<c@retren.example>"],
    });
  });

  it("the built mail has the headers, the redirect and the allowlisted attachments", () => {
    const mail = buildMailMessage(
      {
        from: "reclamaciones@retren.example",
        to: OPERATOR,
        subject: "Recordatorio",
        text: "Texto",
        publicRef: "RTN-0A1B2C3D",
        messageId: "<rtn-0a1b2c3d.x@retren.example>",
        thread: [{ message_id: "<a@retren.example>", created_at: "2026-01-20T10:00:00Z" }],
        attachments: [
          {
            kind: "ticket",
            filename: "billete.png",
            content_type: "image/png",
            storage_path: "tickets/x.png",
          },
        ],
      },
      { MAIL_REDIRECT_ALL_TO: "equipo@retren.example" },
    );
    expect(MailMessage.parse(mail)).toEqual(mail);
    expect(mail).toEqual({
      from: "reclamaciones@retren.example",
      to: ["equipo@retren.example"],
      subject: "[RTN-0A1B2C3D] Recordatorio",
      text: "Texto",
      messageId: "<rtn-0a1b2c3d.x@retren.example>",
      inReplyTo: "<a@retren.example>",
      references: ["<a@retren.example>"],
      attachments: [
        {
          kind: "ticket",
          filename: "billete.png",
          contentType: "image/png",
          storagePath: "tickets/x.png",
        },
      ],
    });
  });
});

describe("status re-check (stale rows)", () => {
  const queuedAt = "2026-02-01T10:00:00Z";

  it("a row queued while the case was running is sent", () => {
    expect(isStale({ caseStatus: "sent", queuedAt, lastInboundAt: null })).toBe(false);
    expect(isStale({ caseStatus: "sent", queuedAt, lastInboundAt: "2026-01-31T10:00:00Z" })).toBe(
      false,
    );
    expect(isStale({ caseStatus: "escalated", queuedAt, lastInboundAt: null })).toBe(false);
  });

  it("a reply that arrived after the row was queued makes it stale", () => {
    expect(
      isStale({ caseStatus: "reply_received", queuedAt, lastInboundAt: "2026-02-01T10:00:01Z" }),
    ).toBe(true);
    expect(isStale({ caseStatus: "sent", queuedAt, lastInboundAt: "2026-02-02T00:00:00Z" })).toBe(
      true,
    );
  });

  it("a closed or resolved case makes it stale", () => {
    expect(isStale({ caseStatus: "closed", queuedAt, lastInboundAt: null })).toBe(true);
    expect(isStale({ caseStatus: "resolved", queuedAt, lastInboundAt: null })).toBe(true);
  });
});

describe("mock template text never goes through a non-fake provider", () => {
  const mock = renderTemplate("initial_claim", "iryo", { ref: "RTN-0A1B2C3D" });

  it("detects the documents mock's text", () => {
    expect(looksLikeMockText(mock.text)).toBe(true);
    expect(looksLikeMockText("  mock reminder_d12")).toBe(true);
    expect(looksLikeMockText("Estimados señores: reclamamos…")).toBe(false);
    expect(looksLikeMockText("Mockingbird")).toBe(false);
  });

  it("is refused unless MAIL_PROVIDER is fake", () => {
    expect(checkMockText(mock, "fake")).toEqual({ ok: true });
    expect(checkMockText(mock, "smtp")).toEqual({ ok: false, reason: "mock_text" });
    expect(checkMockText({ subject: "mock subject [RTN-1]", text: "Texto real" }, "smtp")).toEqual({
      ok: false,
      reason: "mock_text",
    });
    expect(checkMockText({ subject: "[RTN-1] Reclamación", text: "Texto real" }, "smtp")).toEqual({
      ok: true,
    });
  });
});

describe("MailTransport", () => {
  it("MAIL_PROVIDER allows only the fake", () => {
    expect(createMailTransport({}).name).toBe("fake");
    expect(createMailTransport({ MAIL_PROVIDER: "fake" }).name).toBe("fake");
    expect(() => createMailTransport({ MAIL_PROVIDER: "smtp" })).toThrow(/MAIL_PROVIDER/);
  });

  it("the fake only records the mail and returns a fake provider id", async () => {
    const t = createFakeTransport();
    const mail = {
      ...MailMessage.parse({
        from: "reclamaciones@retren.example",
        to: [OPERATOR],
        subject: "[RTN-0A1B2C3D] x",
        text: "x",
        messageId: "<m@retren.example>",
        attachments: [],
      }),
      attachments: [],
    };
    const a = await t.send(mail);
    const b = await t.send(mail);
    expect(a.providerId).toMatch(/^fake-/);
    expect(a.providerId).not.toBe(b.providerId);
    expect(t.outbox).toEqual([mail, mail]);
  });
});
