import { createTransport } from "nodemailer";
import { describe, expect, it } from "vitest";
import { buildMailMessage } from "@/features/claims/outbound";
import { sendingDomain } from "@/features/claims/send-queued";
import {
  createGmailTransport,
  createMailTransport,
  smtpConfigFromEnv,
  smtpOptions,
  type OutboundMail,
} from "@/features/claims/transport";
import { PROVIDERS } from "@/shared/providers";

// The gmail transport (C3): nodemailer over SMTP 465 TLS with an app password. These tests never
// open a connection: the message is rendered by nodemailer's stream transport, in memory.
const SECRET = "app-password-never-printed";
const ENV = {
  MAIL_PROVIDER: "gmail",
  SMTP_HOST: "smtp.gmail.com",
  SMTP_PORT: "465",
  SMTP_SECURE: "true",
  SMTP_USER: "buzon@retren.example",
  SMTP_PASS: SECRET,
  MAIL_REDIRECT_ALL_TO: "equipo@retren.example",
};
const OPERATOR = "atencion.cliente@iryo.eu";
const PDF = new TextEncoder().encode("%PDF-1.7\n% placeholder\n%%EOF\n");

/** Renders the MIME nodemailer would send, without any network. */
function inMemory() {
  const raw: string[] = [];
  const stream = createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  return {
    raw,
    transporter: {
      async sendMail(options: Parameters<typeof stream.sendMail>[0]) {
        const info = await stream.sendMail(options);
        raw.push((info.message as Buffer).toString("utf8"));
        return info;
      },
    },
  };
}

function mail(env: Record<string, string | undefined> = ENV): OutboundMail {
  const built = buildMailMessage(
    {
      from: "reclamaciones@retren.invalid",
      to: OPERATOR,
      subject: "Recordatorio de la reclamacion",
      text: "Texto del recordatorio.",
      publicRef: "RTN-0A1B2C3D",
      messageId: "<rtn-0a1b2c3d.m2@retren.example>",
      thread: [
        { message_id: "<rtn-0a1b2c3d.m1@retren.example>", created_at: "2026-01-18T09:00:00Z" },
      ],
      attachments: [
        {
          kind: "eu_form",
          filename: "formulario_ue.pdf",
          content_type: "application/pdf",
          storage_path: "claim-documents/c/formulario_ue.pdf",
        },
      ],
    },
    env,
  );
  return { ...built, attachments: built.attachments.map((a) => ({ ...a, content: PDF })) };
}

describe("MAIL_PROVIDER", () => {
  it("is fake | gmail, fake by default", () => {
    expect([...PROVIDERS.MAIL_PROVIDER]).toEqual(["fake", "gmail"]);
    expect(createMailTransport({}).name).toBe("fake");
    expect(createMailTransport(ENV).name).toBe("gmail");
  });
});

describe("SMTP configuration", () => {
  it("reads SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER and SMTP_PASS", () => {
    expect(smtpOptions(smtpConfigFromEnv(ENV))).toEqual({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: "buzon@retren.example", pass: SECRET },
      logger: false,
      debug: false,
    });
  });

  it("refuses to construct when an SMTP variable is missing, naming it but no value", () => {
    for (const name of ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS"]) {
      const env = { ...ENV, [name]: undefined };
      let message = "";
      try {
        createGmailTransport(env);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain(name);
      expect(message).not.toContain(SECRET);
    }
  });

  it("refuses an invalid port or secure flag", () => {
    expect(() => createGmailTransport({ ...ENV, SMTP_PORT: "abc" })).toThrow(/SMTP_PORT/);
    expect(() => createGmailTransport({ ...ENV, SMTP_SECURE: "maybe" })).toThrow(/SMTP_SECURE/);
  });

  it("refuses when MAIL_REDIRECT_ALL_TO is the sending mailbox (C4 reads that mailbox)", () => {
    expect(() =>
      createGmailTransport({ ...ENV, MAIL_REDIRECT_ALL_TO: " Buzon@Retren.example " }),
    ).toThrow(/MAIL_REDIRECT_ALL_TO/);
  });

  it("outside production refuses to construct without MAIL_REDIRECT_ALL_TO", () => {
    expect(() => createGmailTransport({ ...ENV, MAIL_REDIRECT_ALL_TO: undefined })).toThrow(
      /MAIL_REDIRECT_ALL_TO/,
    );
    expect(() =>
      createGmailTransport({ ...ENV, MAIL_REDIRECT_ALL_TO: undefined, RETREN_ENV: "production" }),
    ).not.toThrow();
  });

  it("MAIL_SENDING_DOMAIN is the domain of SMTP_USER", () => {
    expect(sendingDomain(ENV)).toBe("retren.example");
    expect(sendingDomain({ ...ENV, SMTP_USER: "buzon@otro.example" })).toBe("otro.example");
    expect(() => createGmailTransport({ ...ENV, MAIL_SENDING_DOMAIN: "distinto.example" })).toThrow(
      /MAIL_SENDING_DOMAIN/,
    );
  });
});

describe("the message nodemailer builds", () => {
  it("has the headers, threading, attachments and redirect", async () => {
    const m = inMemory();
    const t = createGmailTransport(ENV, { transporter: m.transporter });
    const out = await t.send(mail());
    expect(out.providerId).toBe("<rtn-0a1b2c3d.m2@retren.example>");
    expect(m.raw).toHaveLength(1);
    const raw = m.raw[0];
    const headers = raw.slice(0, raw.indexOf("\n\n"));

    // From is the Retren mailbox itself (Gmail rewrites anything else); To is the redirect.
    expect(headers).toMatch(/^From: Retren <buzon@retren\.example>$/m);
    expect(headers).toMatch(/^To: equipo@retren\.example$/m);
    expect(headers).not.toContain(OPERATOR);
    expect(headers).toMatch(/^Subject: \[RTN-0A1B2C3D\] Recordatorio de la reclamacion$/m);
    expect(headers).toMatch(/^Message-ID: <rtn-0a1b2c3d\.m2@retren\.example>$/m);
    expect(headers).toMatch(/^In-Reply-To: <rtn-0a1b2c3d\.m1@retren\.example>$/m);
    expect(headers).toMatch(/^References: <rtn-0a1b2c3d\.m1@retren\.example>$/m);

    // The attachment is the bytes the sender read from storage, never a path.
    expect(raw).toMatch(/Content-Type: application\/pdf; name=formulario_ue\.pdf/);
    expect(raw).toMatch(/Content-Disposition: attachment; filename=formulario_ue\.pdf/);
    expect(raw).toContain(Buffer.from(PDF).toString("base64"));
    expect(raw).not.toContain("claim-documents/c/formulario_ue.pdf");
    expect(raw).toContain("Texto del recordatorio.");
    expect(raw).not.toContain(SECRET);
  });

  it("without a redirect (production only) goes to the real recipient", async () => {
    const env = { ...ENV, MAIL_REDIRECT_ALL_TO: undefined, RETREN_ENV: "production" };
    const m = inMemory();
    await createGmailTransport(env, { transporter: m.transporter }).send(mail(env));
    expect(m.raw[0]).toMatch(/^To: atencion\.cliente@iryo\.eu$/m);
  });

  it("refuses an attachment without its content", async () => {
    const m = inMemory();
    const t = createGmailTransport(ENV, { transporter: m.transporter });
    const broken = mail();
    (broken.attachments[0] as { content?: Uint8Array }).content = undefined;
    await expect(t.send(broken)).rejects.toThrow(/content/);
    expect(m.raw).toEqual([]);
  });
});
