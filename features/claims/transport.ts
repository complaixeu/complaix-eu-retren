// MailTransport implementations (docs/plans/README.md §4.1, C3). Internal to domain C.
//
// - fake: records the mail and answers with a fake provider id. Delivers nothing. The default.
// - gmail: SMTP through Google Workspace (nodemailer, port 465 TLS, an app password), sending as
//   the dedicated Retren mailbox SMTP_USER. Only the sender (./send-queued.ts) calls it, after
//   every safety rule, with the redirect already applied and the attachments read from storage.
import { randomUUID } from "node:crypto";
import { createTransport } from "nodemailer";
import { z } from "zod";
import type { MailAttachment, MailMessage } from "@/shared/contracts";
import { provider } from "@/shared/providers";
import { isProduction } from "./outbound";

type Env = Record<string, string | undefined>;

export type MailProviderName = ReturnType<typeof provider<"MAIL_PROVIDER">>;

/** An attachment with its bytes, read from private storage by the sender. Never a path. */
export type OutboundAttachment = MailAttachment & { content: Uint8Array };
/** What the transport gets: a MailMessage (shared/contracts) whose attachments carry their bytes. */
export type OutboundMail = Omit<MailMessage, "attachments"> & { attachments: OutboundAttachment[] };

/** The MailTransport port of shared/contracts, for mail whose attachments carry their bytes. */
export interface ClaimsTransport {
  send(message: OutboundMail): Promise<{ providerId: string }>;
}

export interface FakeTransport extends ClaimsTransport {
  /** Every mail "sent", in order. The outbox row in `messages` is the source of truth. */
  readonly outbox: OutboundMail[];
}

/** Records the mail and answers with a fake provider id. Delivers nothing. */
export function createFakeTransport(): FakeTransport {
  const outbox: OutboundMail[] = [];
  return {
    outbox,
    async send(message) {
      outbox.push(message);
      return { providerId: `fake-${randomUUID()}` };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// What a transport failure means

/** Raised by a transport for a mail it never handed to the provider (checked before connecting). */
export class NotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSentError";
  }
}

/** nodemailer error codes that guarantee the mail was not accepted. */
const NOT_SENT_CODES: readonly string[] = ["EAUTH", "ECONNECTION", "EENVELOPE"];

/**
 * `transport_error` only when nothing can have been sent: a NotSentError, or nodemailer's EAUTH,
 * ECONNECTION or EENVELOPE. Anything else (a timeout after DATA, a dropped socket, an unknown
 * error) may have been delivered: `delivery_unknown`, never resent automatically.
 */
export function transportFailure(error: unknown): "transport_error" | "delivery_unknown" {
  if (error instanceof NotSentError) return "transport_error";
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && NOT_SENT_CODES.includes(code)
    ? "transport_error"
    : "delivery_unknown";
}

// ---------------------------------------------------------------------------------------------
// gmail

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

const SMTP_VARS = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS"] as const;

/** The SMTP settings. Errors name the variable, never a value (the repo's logs are public). */
export function smtpConfigFromEnv(env: Env = process.env): SmtpConfig {
  const missing = SMTP_VARS.filter((v) => !env[v]?.trim());
  if (missing.length) {
    throw new Error(`MAIL_PROVIDER=gmail needs ${missing.join(", ")}`);
  }
  const port = Number(env.SMTP_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("SMTP_PORT must be a port number");
  }
  const secure = env.SMTP_SECURE!.trim().toLowerCase();
  if (secure !== "true" && secure !== "false") {
    throw new Error("SMTP_SECURE must be true or false");
  }
  const user = env.SMTP_USER!.trim();
  if (!z.email().safeParse(user).success) throw new Error("SMTP_USER must be an email address");
  return {
    host: env.SMTP_HOST!.trim(),
    port,
    secure: secure === "true",
    user,
    pass: env.SMTP_PASS!,
  };
}

/** nodemailer's SMTP options. Its logger and debug output stay off: they could print secrets. */
export function smtpOptions(c: SmtpConfig) {
  return {
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: { user: c.user, pass: c.pass },
    logger: false,
    debug: false,
  };
}

/** The part of a nodemailer transporter the gmail transport uses (injectable for tests). */
export interface Transporter {
  sendMail(options: {
    from: { name: string; address: string };
    to: string[];
    subject: string;
    text: string;
    messageId: string;
    inReplyTo?: string;
    references?: string[];
    attachments: { filename: string; content: Buffer; contentType: string }[];
  }): Promise<{ messageId?: string }>;
}

/**
 * The gmail transport. Refuses to construct when an SMTP variable is missing, when
 * MAIL_REDIRECT_ALL_TO is the sending mailbox (C4 reads that mailbox: redirected copies would come
 * back as operator replies), when MAIL_SENDING_DOMAIN is not SMTP_USER's domain, and outside
 * production (RETREN_ENV=production is the only switch) when MAIL_REDIRECT_ALL_TO is unset:
 * DEV can never email a real operator (README §4.8).
 */
export function createGmailTransport(
  env: Env = process.env,
  opts: { transporter?: Transporter } = {},
): ClaimsTransport {
  const config = smtpConfigFromEnv(env);
  const redirect = env.MAIL_REDIRECT_ALL_TO?.trim().toLowerCase();
  if (redirect && redirect === config.user.toLowerCase()) {
    throw new Error("MAIL_REDIRECT_ALL_TO must be a different mailbox from SMTP_USER");
  }
  if (!isProduction(env) && !redirect) {
    throw new Error("MAIL_PROVIDER=gmail outside production needs MAIL_REDIRECT_ALL_TO");
  }
  const domain = config.user.split("@")[1].toLowerCase();
  const declared = env.MAIL_SENDING_DOMAIN?.trim().toLowerCase();
  if (declared && declared !== domain) {
    throw new Error("MAIL_SENDING_DOMAIN must be the domain of SMTP_USER");
  }
  const transporter: Transporter =
    opts.transporter ?? (createTransport(smtpOptions(config)) as unknown as Transporter);

  return {
    async send(mail) {
      const attachments = mail.attachments.map((a) => {
        if (!(a.content instanceof Uint8Array)) {
          throw new NotSentError(`attachment ${a.kind} has no content`);
        }
        return {
          filename: a.filename,
          content: Buffer.from(a.content),
          contentType: a.contentType,
        };
      });
      const info = await transporter.sendMail({
        // Always the Retren mailbox: Gmail rewrites any other From, and the rows' placeholder
        // senders (…@retren.invalid) are not ours to send as.
        from: { name: "Retren", address: config.user },
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        messageId: mail.messageId,
        ...(mail.inReplyTo && { inReplyTo: mail.inReplyTo }),
        ...(mail.references?.length && { references: mail.references }),
        attachments,
      });
      return { providerId: info.messageId ?? mail.messageId };
    },
  };
}

/** The transport MAIL_PROVIDER selects (`fake` by default; anything unknown throws). */
export function createMailTransport(env: Env = process.env): {
  name: MailProviderName;
  transport: ClaimsTransport;
} {
  const name = provider("MAIL_PROVIDER", env);
  switch (name) {
    case "fake":
      return { name, transport: createFakeTransport() };
    case "gmail":
      return { name, transport: createGmailTransport(env) };
  }
}
