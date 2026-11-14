import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideRoute,
  dkimPassDomains,
  isOwnMail,
  parseInbound,
  refsInSubject,
  type RouteInput,
} from "@/features/claims/inbound";
import { MAIL_FIXTURES_DIR } from "../../fixtures/mail/golden";

// The pure parts of ingestMessage (docs/plans/C-claims.md C4). The DB paths are integration tests.

const fixture = (name: string) => readFileSync(join(MAIL_FIXTURES_DIR, "iryo", name));
const inboundFixture = (name: string) =>
  readFileSync(join(process.cwd(), "tests", "fixtures", "claims", "inbound", name));

describe("parseInbound", () => {
  it("reads the headers the matching needs from a golden fixture", async () => {
    const p = await parseInbound(fixture("approved-01.eml"));
    expect(p).toMatchObject({
      from: "atencion.cliente@iryo.eu",
      subject: "Re: Reclamacion por retraso [RTN-T007]",
      messageId: "<fixture-approved-01@mail.example>",
      inReplyTo: "<claim-rtn-t007@retren.example>",
      references: ["<claim-rtn-t007@retren.example>"],
      to: ["reclamaciones@retren.example"],
    });
    expect(p!.text).toContain("aprobada");
  });

  it("derives a stable Message-ID when the mail has none", async () => {
    const raw = Buffer.from("From: a@b.example\r\nSubject: [RTN-ABC]\r\n\r\nhola");
    const a = await parseInbound(raw);
    const b = await parseInbound(raw);
    expect(a!.messageId).toMatch(/^<[0-9a-f]{64}@inbound\.invalid>$/);
    expect(a!.messageId).toBe(b!.messageId);
  });

  it("never throws on garbage: no sender means null", async () => {
    await expect(parseInbound(Buffer.from([0, 1, 2, 255, 254]))).resolves.toBeNull();
    await expect(parseInbound(Buffer.alloc(0))).resolves.toBeNull();
  });
});

describe("refsInSubject", () => {
  it("finds every [RTN-…] reference, upper-cased and once", () => {
    expect(refsInSubject("Re: [rtn-ab12] y [RTN-AB12] [RTN-CD34]")).toEqual([
      "RTN-AB12",
      "RTN-CD34",
    ]);
    expect(refsInSubject("RTN-AB12 without brackets")).toEqual([]);
  });
});

describe("isOwnMail", () => {
  const env = {
    SMTP_USER: "retren@retren.example",
    MAIL_REDIRECT_ALL_TO: "team@retren.example",
  };
  it("our own address", () => {
    expect(isOwnMail({ from: "Retren@Retren.example", to: [] }, env)).toBe("own_mail");
  });
  it("a copy addressed to MAIL_REDIRECT_ALL_TO", () => {
    expect(isOwnMail({ from: "op@iryo.eu", to: ["team@retren.example"] }, env)).toBe(
      "redirected_copy",
    );
  });
  it("anything else is not ours", () => {
    expect(isOwnMail({ from: "op@iryo.eu", to: ["retren@retren.example"] }, env)).toBeNull();
  });
});

describe("dkimPassDomains (Authentication-Results)", () => {
  const AUTHSERV = "mx.google.com";
  it("reads the dkim=pass domains (header.d, or header.i's domain) of Gmail's own header", async () => {
    const p = await parseInbound(inboundFixture("ref-only-dkim-pass.eml"));
    expect(dkimPassDomains(p!.authResults, AUTHSERV)).toEqual(["iryo.eu"]);
    expect(
      dkimPassDomains(["mx.google.com; dkim=pass header.d=Mail.Iryo.EU header.s=x"], AUTHSERV),
    ).toEqual(["mail.iryo.eu"]);
  });
  it("nothing without the header, or with dkim=fail", async () => {
    for (const f of ["ref-only-no-auth.eml", "ref-only-dkim-fail.eml"]) {
      const p = await parseInbound(inboundFixture(f));
      expect(dkimPassDomains(p!.authResults, AUTHSERV)).toEqual([]);
    }
  });
  it("only the topmost header counts: a forged one below it is ignored", async () => {
    const p = await parseInbound(inboundFixture("ref-only-forged-auth.eml"));
    expect(p!.authResults).toHaveLength(2);
    expect(dkimPassDomains(p!.authResults, AUTHSERV)).toEqual([]);
  });
  it("a header from another authserv-id is not Gmail's: ignored", () => {
    expect(dkimPassDomains(["evil.example; dkim=pass header.d=iryo.eu"], AUTHSERV)).toEqual([]);
  });
});

describe("decideRoute", () => {
  const kase = {
    id: "c1",
    public_ref: "RTN-AAAA0001",
    operator: "iryo" as const,
    status: "sent" as const,
    user_email: "user@example.test",
  };
  const base: RouteInput = {
    from: "atencion.cliente@iryo.eu",
    refs: ["RTN-AAAA0001"],
    threadCase: kase,
    refCases: [kase],
    hasAttachment: false,
    operatorDomain: "iryo.eu",
    refOperatorDomain: "iryo.eu",
    dkimPassDomains: [],
  };
  const refOnly: RouteInput = { ...base, threadCase: null };

  it("threaded, our reference, the operator's domain: an operator reply", () => {
    expect(decideRoute(base)).toEqual({ kind: "operator", case: kase });
    expect(decideRoute({ ...base, refs: [], refCases: [] })).toEqual({
      kind: "operator",
      case: kase,
    });
  });
  it("neither threaded nor carrying a reference: skipped", () => {
    expect(decideRoute({ ...base, refs: [], refCases: [], threadCase: null })).toEqual({
      kind: "skip",
    });
  });
  it("a reference that doesn't exist: the team queue, without a case", () => {
    expect(decideRoute({ ...base, refs: ["RTN-NOPE"], refCases: [], threadCase: null })).toEqual({
      kind: "queue",
      case: null,
      reason: "unknown_reference",
    });
  });
  it("our reference only, from the operator's domain with an aligned dkim=pass: matched", () => {
    expect(decideRoute({ ...refOnly, dkimPassDomains: ["iryo.eu"] })).toEqual({
      kind: "operator",
      case: kase,
    });
    // Relaxed alignment: a subdomain of the operator's domain signed it.
    expect(decideRoute({ ...refOnly, dkimPassDomains: ["mail.iryo.eu"] }).kind).toBe("operator");
  });
  it("our reference only, without an aligned dkim=pass: spoofed", () => {
    for (const dkim of [[], ["bulk-sender.example"], ["evil-iryo.eu"], ["iryo.eu.evil.example"]]) {
      expect(decideRoute({ ...refOnly, dkimPassDomains: dkim })).toMatchObject({
        reason: "spoofed_reference",
      });
    }
  });
  it("our reference only, from a foreign sender (even with its own dkim=pass): spoofed", () => {
    expect(
      decideRoute({
        ...refOnly,
        from: "atencion@iryo-soporte.example",
        dkimPassDomains: ["iryo-soporte.example"],
      }),
    ).toEqual({ kind: "queue", case: kase, reason: "spoofed_reference" });
  });
  it("our reference only, but more than one reference or an unknown one alongside: spoofed", () => {
    const other = { ...kase, id: "c2", public_ref: "RTN-BBBB0002" };
    expect(
      decideRoute({
        ...refOnly,
        refs: [kase.public_ref, other.public_ref],
        refCases: [kase, other],
        dkimPassDomains: ["iryo.eu"],
      }),
    ).toMatchObject({ reason: "spoofed_reference" });
    expect(
      decideRoute({
        ...refOnly,
        refs: [kase.public_ref, "RTN-NOPE"],
        dkimPassDomains: ["iryo.eu"],
      }),
    ).toMatchObject({ reason: "spoofed_reference" });
  });
  it("our reference only, from the case user: spoofed (the user must reply in the thread)", () => {
    expect(
      decideRoute({ ...refOnly, from: kase.user_email, dkimPassDomains: ["example.test"] }),
    ).toMatchObject({ reason: "spoofed_reference" });
  });
  it("our reference without a thread match: spoofed", () => {
    expect(decideRoute({ ...base, threadCase: null })).toEqual({
      kind: "queue",
      case: kase,
      reason: "spoofed_reference",
    });
  });
  it("a thread match with another case's reference: spoofed", () => {
    const other = { ...kase, id: "c2", public_ref: "RTN-BBBB0002" };
    expect(decideRoute({ ...base, refs: [other.public_ref], refCases: [other] })).toEqual({
      kind: "queue",
      case: kase,
      reason: "spoofed_reference",
    });
  });
  it("a sender outside the operator's domain: wrong sender", () => {
    expect(decideRoute({ ...base, from: "atencion@iryo-reembolsos.example" })).toEqual({
      kind: "queue",
      case: kase,
      reason: "wrong_sender",
    });
    // A subdomain look-alike is not the domain.
    expect(decideRoute({ ...base, from: "x@evil-iryo.eu" }).kind).toBe("queue");
    // An operator without an email channel has no domain: nobody is its sender.
    expect(decideRoute({ ...base, operatorDomain: null })).toMatchObject({
      reason: "wrong_sender",
    });
  });
  it("the case user, waiting_user, with an attachment: the user's document", () => {
    const waiting = { ...kase, status: "waiting_user" as const };
    const r = { ...base, threadCase: waiting, refCases: [waiting], from: "User@Example.test" };
    expect(decideRoute({ ...r, hasAttachment: true })).toEqual({
      kind: "user_document",
      case: waiting,
    });
    expect(decideRoute(r)).toEqual({ kind: "queue", case: waiting, reason: "user_reply" });
    expect(decideRoute({ ...r, threadCase: kase, refCases: [kase], hasAttachment: true })).toEqual({
      kind: "queue",
      case: kase,
      reason: "user_reply",
    });
  });
});
