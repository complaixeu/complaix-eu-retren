// The tick's inbound step (C4): before the timer actions (./tick.ts), POST /api/claims/tick reads
// the mailbox, so an operator reply stops the schedule before a reminder is queued. Internal to
// domain C.
import { fixedClock } from "@/shared/clock";
import { provider } from "@/shared/providers";
import type { ServiceClient } from "@/shared/supabase/server";
import { createClassifier, type ReplyClassifier } from "./classifier";
import { ingestMessage } from "./inbound";
import { operatorInboxes } from "./operator-inboxes";
import { pollInbox, type PollResult } from "./poll-inbox";

type Env = Record<string, string | undefined>;

/** Codes and counts only: the tick's response holds no personal data and no error text. */
export type InboundTickResult =
  | PollResult
  | { skipped: "mail_provider_fake" }
  /** `config`: MAIL_OPERATOR_INBOXES is malformed; the mailbox was not opened. */
  | { error: "inbound_failed" | "config" };

let classifier: ReplyClassifier | undefined;

/**
 * Reads the mailbox only when MAIL_PROVIDER=gmail; with the fake provider there is no mailbox
 * (the team's simulated mailbox, C9, calls ingestMessage directly). Never throws: a mailbox that
 * can't be read (or refuses to start) never stops the timers.
 */
export async function runInbound(
  db: ServiceClient,
  now: Date,
  env: Env = process.env,
): Promise<InboundTickResult> {
  try {
    if (provider("MAIL_PROVIDER", env) !== "gmail") return { skipped: "mail_provider_fake" };
    // A malformed test-inbox mapping is a configuration error: visible as a code, and the mailbox
    // is not opened. The error text may name an address, so it is never logged.
    try {
      operatorInboxes(env);
    } catch {
      console.error("claims tick: MAIL_OPERATOR_INBOXES is malformed (config)");
      return { error: "config" };
    }
    // Built once, outside the per-mail path (C5: createClassifier throws on a bad config).
    classifier ??= createClassifier(env);
    const c = classifier;
    return await pollInbox({
      db,
      env,
      ingest: (raw) => ingestMessage(raw, { db, env, classifier: c, clock: fixedClock(now) }),
    });
  } catch {
    // A code only: the error text may name a mailbox.
    console.error("claims tick: reading the mailbox failed");
    return { error: "inbound_failed" };
  }
}
