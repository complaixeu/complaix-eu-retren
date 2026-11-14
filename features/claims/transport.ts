// MailTransport implementations (docs/plans/README.md §4.1, C3). Internal to domain C.
//
// Only the fake exists: it never touches the network. A real provider is a later step that needs
// Nestor (provider, cost, keys); adding one means adding it to PROVIDERS.MAIL_PROVIDER.
import { randomUUID } from "node:crypto";
import type { MailMessage, MailTransport } from "@/shared/contracts";
import { provider } from "@/shared/providers";

export type MailProviderName = ReturnType<typeof provider<"MAIL_PROVIDER">>;

export interface FakeTransport extends MailTransport {
  /** Every mail "sent", in order. The outbox row in `messages` is the source of truth. */
  readonly outbox: MailMessage[];
}

/** Records the mail and answers with a fake provider id. Delivers nothing. */
export function createFakeTransport(): FakeTransport {
  const outbox: MailMessage[] = [];
  return {
    outbox,
    async send(message) {
      outbox.push(message);
      return { providerId: `fake-${randomUUID()}` };
    },
  };
}

/** The transport MAIL_PROVIDER selects (only `fake` is allowed; anything else throws). */
export function createMailTransport(env: Record<string, string | undefined> = process.env): {
  name: MailProviderName;
  transport: MailTransport;
} {
  const name = provider("MAIL_PROVIDER", env);
  switch (name) {
    case "fake":
      return { name, transport: createFakeTransport() };
  }
}
