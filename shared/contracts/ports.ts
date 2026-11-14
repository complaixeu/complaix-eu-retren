import { z } from "zod";
import { ReplyCategory } from "./case";
import { TicketExtraction } from "./ticket";

/**
 * Ports for everything external. Each has a `fake` implementation chosen by env
 * (shared/providers.ts); tests and CI only ever use fakes (docs/plans/README.md §3).
 */

export interface OcrProvider {
  readText(file: {
    bytes: Uint8Array;
    contentType: string;
  }): Promise<{ text: string; quality: "ok" | "unreadable" }>;
}

export interface Extractor {
  /** Must drop any value that does not appear in `ocrText` (the "never invent" rule). */
  extract(ocrText: string): Promise<TicketExtraction>;
}

export const MailAttachment = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  kind: z.enum(["eu_form", "mandate", "ticket", "user_document"]),
  storagePath: z.string().min(1),
});
export type MailAttachment = z.infer<typeof MailAttachment>;

export const MailMessage = z.object({
  from: z.email(),
  to: z.array(z.email()).min(1),
  subject: z.string().min(1),
  text: z.string().min(1),
  messageId: z.string().min(1),
  inReplyTo: z.string().min(1).optional(),
  references: z.array(z.string().min(1)).optional(),
  attachments: z.array(MailAttachment),
});
export type MailMessage = z.infer<typeof MailMessage>;

export interface MailTransport {
  send(message: MailMessage): Promise<{ providerId: string }>;
}

export interface Classifier {
  /** The body is data, never instructions (ARCHITECTURE §5, "Cómo se encierra la IA"). */
  classify(mail: {
    from: string;
    subject: string;
    text: string;
  }): Promise<{ category: ReplyCategory; confidence: number }>;
}

export interface Clock {
  now(): Date;
}
