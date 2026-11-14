// Reads the Retren mailbox over IMAP (docs/plans/C-claims.md C4). Internal to domain C: the tick
// (/api/claims/tick, C7) calls pollInbox() when MAIL_PROVIDER=gmail.
//
// The mailbox may be a shared, already used account, so this only ever touches claim mail:
// - read-only: INBOX is opened with EXAMINE and fetched with BODY.PEEK (imapflow's `source`);
//   no flag is ever set, nothing is moved or deleted, so the people using it see nothing change;
// - filtered on the server: only mail whose subject contains `[RTN-` or whose sender is in one of
//   the operators' configured domains is ever downloaded, and ingestMessage then skips whatever
//   is not ours;
// - from now on: the first run stores the mailbox's current last UID and imports nothing that was
//   already there. A new UIDVALIDITY (the UIDs were renumbered) starts again from the current UID.
// Progress (last UID + UIDVALIDITY) is kept in claims_mail_poll_state after every mail, so a
// failure mid-batch resumes at the failed mail; a mail read twice is stored once (Message-ID).
import { ImapFlow } from "imapflow";
import { getOperatorConfig } from "@/features/rules";
import { OperatorId } from "@/shared/contracts";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { ingestMessage, type IngestResult } from "./inbound";
import { sendingDomain } from "./send-queued";

type Env = Record<string, string | undefined>;

export const INBOX = "INBOX";
/** Most mails one run reads; the rest wait for the next tick. */
export const POLL_LIMIT = 50;

/** The IMAP search criteria pollInbox sends (a subset of imapflow's SearchObject). */
export interface ImapSearch {
  uid?: string;
  subject?: string;
  from?: string;
  /** A header contains this text (IMAP SEARCH HEADER). */
  header?: Record<string, string>;
  or?: ImapSearch[];
}

/** The part of an imapflow client pollInbox uses. None of these change the mailbox. */
export interface ImapClient {
  connect(): Promise<void>;
  mailboxOpen(
    path: string,
    opts: { readOnly: true },
  ): Promise<{ uidValidity: bigint; uidNext: number }>;
  search(query: ImapSearch, opts: { uid: true }): Promise<number[] | false | undefined>;
  fetchOne(
    uid: string,
    query: { source: true; uid: true },
    opts: { uid: true },
  ): Promise<{ uid: number; source?: Buffer } | false>;
  logout(): Promise<void>;
}

export interface PollState {
  uidValidity: bigint;
  lastUid: number;
  /** The mail that failed last, and how many runs in a row it failed. Absent: none. */
  failedUid?: number;
  failedAttempts?: number;
  /** When that mail first failed (poison needs 3 failures AND POISON_AFTER_MS since then). */
  failedSince?: Date;
}

export interface PollStateStore {
  read(mailbox: string): Promise<PollState | null>;
  write(mailbox: string, state: PollState): Promise<void>;
  /** Tells the team a mail could not be read POISON_ATTEMPTS times: its UID and a code only. */
  markPoison(mailbox: string, uidValidity: bigint, uid: number): Promise<void>;
}

/**
 * A mail that failed on our side (storage, database) is put in the team queue and skipped only
 * after POISON_ATTEMPTS failures AND POISON_AFTER_MS since its first one: a transient outage of
 * a few hours never skips real claim mail. Fetch and connection errors never count at all.
 */
export const POISON_ATTEMPTS = 3;
export const POISON_AFTER_MS = 24 * 3_600_000;
/** The team-queue code of a mail that kept failing (messages.inbound_queue_reason). */
export const POISON_REASON = "unreadable_mail";

export interface PollResult {
  /** first_run / uidvalidity_changed: the position was (re)set to the current UID, nothing read. */
  started: "first_run" | "uidvalidity_changed" | "resumed";
  /** Mails handed to ingestMessage and done with (whatever their outcome). */
  processed: number;
  /** How many of them were acted on, queued, skipped or duplicates (codes only). */
  outcomes: Partial<Record<IngestResult["outcome"], number>>;
  /** Set when a mail failed: the next run starts again at this UID. */
  failedAtUid?: number;
  /** Mails that failed POISON_ATTEMPTS times: put in the team queue and skipped. */
  poisonedUids?: number[];
}

export interface PollDeps {
  env?: Env;
  /** Service-role client for the default state store; created from env when left out. */
  db?: ServiceClient;
  /** The IMAP client; one from the IMAP_* env when left out. */
  client?: ImapClient;
  state?: PollStateStore;
  /** The clock for the failure window; the real one when left out. */
  now?: () => Date;
  ingest?: (raw: Buffer) => Promise<IngestResult>;
  limit?: number;
}

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/** IMAP_HOST, IMAP_PORT, IMAP_SECURE; IMAP_USER and IMAP_PASS default to SMTP_USER / SMTP_PASS. */
export function imapConfigFromEnv(env: Env = process.env): ImapConfig {
  const user = (env.IMAP_USER || env.SMTP_USER)?.trim();
  const pass = env.IMAP_PASS || env.SMTP_PASS;
  const missing = [
    !env.IMAP_HOST?.trim() && "IMAP_HOST",
    !env.IMAP_PORT?.trim() && "IMAP_PORT",
    !env.IMAP_SECURE?.trim() && "IMAP_SECURE",
    !user && "IMAP_USER (or SMTP_USER)",
    !pass && "IMAP_PASS (or SMTP_PASS)",
  ].filter(Boolean);
  // Errors name the variable, never a value (the repo's logs are public).
  if (missing.length) throw new Error(`reading the mailbox needs ${missing.join(", ")}`);
  const port = Number(env.IMAP_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("IMAP_PORT must be a port number");
  }
  const secure = env.IMAP_SECURE!.trim().toLowerCase();
  if (secure !== "true" && secure !== "false") throw new Error("IMAP_SECURE must be true or false");
  return { host: env.IMAP_HOST!.trim(), port, secure: secure === "true", user: user!, pass: pass! };
}

/**
 * Refuses to read the mailbox when MAIL_REDIRECT_ALL_TO is that same mailbox (SMTP_USER or
 * IMAP_USER): every redirected copy of our own mail would come back as an operator reply.
 */
export function assertPollConfig(env: Env = process.env): void {
  const redirect = env.MAIL_REDIRECT_ALL_TO?.trim().toLowerCase();
  if (!redirect) return;
  const mailboxes = [env.SMTP_USER, env.IMAP_USER].map((a) => a?.trim().toLowerCase());
  if (mailboxes.includes(redirect)) {
    throw new Error("MAIL_REDIRECT_ALL_TO must be a different mailbox from SMTP_USER / IMAP_USER");
  }
}

/** A real imapflow client. Its logger stays off: it could print addresses or credentials. */
export function createImapClient(config: ImapConfig): ImapClient {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  });
  // A dropped connection is reported by the failing call; never as an unhandled 'error' event.
  client.on("error", () => {});
  return client as unknown as ImapClient;
}

/** The poll state in claims_mail_poll_state (service role only). */
export function dbPollState(db: ServiceClient): PollStateStore {
  return {
    async read(mailbox) {
      const { data, error } = await db
        .from("claims_mail_poll_state")
        .select("uid_validity, last_uid, failed_uid, failed_attempts, failed_since")
        .eq("mailbox", mailbox)
        .maybeSingle();
      if (error) throw error;
      return data
        ? {
            uidValidity: BigInt(data.uid_validity),
            lastUid: Number(data.last_uid),
            ...(data.failed_uid !== null && {
              failedUid: Number(data.failed_uid),
              failedAttempts: data.failed_attempts ?? 0,
              ...(data.failed_since && { failedSince: new Date(data.failed_since) }),
            }),
          }
        : null;
    },
    async write(mailbox, state) {
      const { error } = await db.from("claims_mail_poll_state").upsert({
        mailbox,
        uid_validity: Number(state.uidValidity),
        last_uid: state.lastUid,
        failed_uid: state.failedUid ?? null,
        failed_attempts: state.failedUid !== undefined ? (state.failedAttempts ?? 0) : null,
        failed_since:
          state.failedUid !== undefined ? (state.failedSince?.toISOString() ?? null) : null,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
    },
    async markPoison(mailbox, uidValidity, uid) {
      // A case-less team-queue item (C9 lists them): a synthetic Message-ID naming the UID, the
      // code, and no content at all. Idempotent: the same UID is recorded once.
      const { error } = await db.rpc("claims_record_inbound", {
        p_message: {
          from: "",
          to: "",
          subject: "",
          message_id: `<imap-${mailbox.toLowerCase()}-${uidValidity}-${uid}@poll.invalid>`,
        },
        // Nullable in SQL; the generated Args type marks every function parameter as non-null.
        p_case_id: null as unknown as string,
        p_expected_status: null as unknown as "sent",
        p_to_status: null as unknown as "sent",
        p_queue_reason: POISON_REASON,
      });
      if (error) throw error;
    },
  };
}

/** The domains of every operator with an email channel (active or not). */
export function operatorDomains(): string[] {
  const domains = OperatorId.options.flatMap((id) => {
    const ch = getOperatorConfig(id).channel;
    return ch.type === "email" ? [ch.address.split("@")[1].toLowerCase()] : [];
  });
  return [...new Set(domains)];
}

/**
 * Claim mail only, searched on the server, for UIDs after `lastUid`: the subject contains
 * `[RTN-`, or the sender is in an operator's domain, or it threads onto our own mail (its
 * In-Reply-To or References holds a Message-ID of our sending domain, which is where C3's
 * newMessageId puts our domain). The last one catches a reply from any other domain (a ticketing
 * system) that dropped our reference; ingestMessage then queues it as a wrong sender.
 */
export function claimSearch(lastUid: number, domains: string[], sendingDomain: string): ImapSearch {
  return {
    uid: `${lastUid + 1}:*`,
    or: [
      { subject: "[RTN-" },
      ...domains.map((d) => ({ from: `@${d}` })),
      { header: { "in-reply-to": `@${sendingDomain}` } },
      { header: { references: `@${sendingDomain}` } },
    ],
  };
}

/**
 * Reads the new claim mail of INBOX into ingestMessage. Throws only when it can't start (a
 * configuration error, the IMAP login, the state table); a mail that fails stops the batch and
 * is read again on the next run.
 */
export async function pollInbox(deps: PollDeps = {}): Promise<PollResult> {
  const env = deps.env ?? process.env;
  assertPollConfig(env);
  const client = deps.client ?? createImapClient(imapConfigFromEnv(env));
  const state = deps.state ?? dbPollState(deps.db ?? createServiceClient());
  const ingest = deps.ingest ?? ((raw: Buffer) => ingestMessage(raw, { db: deps.db, env }));
  const limit = deps.limit ?? POLL_LIMIT;

  await client.connect();
  try {
    const box = await client.mailboxOpen(INBOX, { readOnly: true });
    const current = Math.max(0, box.uidNext - 1);
    const saved = await state.read(INBOX);
    if (!saved || saved.uidValidity !== box.uidValidity) {
      await state.write(INBOX, { uidValidity: box.uidValidity, lastUid: current });
      return {
        started: saved ? "uidvalidity_changed" : "first_run",
        processed: 0,
        outcomes: {},
      };
    }

    const found =
      (await client.search(claimSearch(saved.lastUid, operatorDomains(), sendingDomain(env)), {
        uid: true,
      })) || [];
    // `N:*` always includes the last mail, even when N is past it: keep only what is new.
    const uids = [...new Set(found)].filter((u) => u > saved.lastUid).sort((a, b) => a - b);
    const batch = uids.slice(0, limit);
    const result: PollResult = { started: "resumed", processed: 0, outcomes: {} };
    const validity = box.uidValidity;
    let lastUid = saved.lastUid;
    const clock = deps.now ?? (() => new Date());
    let failure =
      saved.failedUid !== undefined
        ? {
            uid: saved.failedUid,
            attempts: saved.failedAttempts ?? 0,
            since: saved.failedSince ?? clock(),
          }
        : null;

    for (const uid of batch) {
      let outcome: IngestResult | null;
      let dropped = false;
      try {
        const msg = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
        // Gone since the search (deleted by someone else): nothing to read.
        outcome =
          msg && msg.source
            ? await ingest(msg.source)
            : { outcome: "skipped", reason: "unparseable" };
      } catch {
        // The connection dropped or the fetch failed: nothing is wrong with the mail. It stops
        // the run and is read again next tick, and it never counts towards the poison limit.
        outcome = null;
        dropped = true;
      }
      if (dropped) {
        result.failedAtUid = uid;
        await writeFailure(state, validity, Math.max(lastUid, uid - 1), failure);
        return result;
      }
      if (!outcome || outcome.outcome === "error") {
        const same = failure?.uid === uid ? failure : null;
        const attempts = (same?.attempts ?? 0) + 1;
        const since = same?.since ?? clock();
        if (attempts < POISON_ATTEMPTS || clock().getTime() - since.getTime() < POISON_AFTER_MS) {
          // Stop here; the unrelated mail before it is covered, the failed one is read again.
          result.failedAtUid = uid;
          failure = { uid, attempts, since };
          await writeFailure(state, validity, Math.max(lastUid, uid - 1), failure);
          return result;
        }
        // A poison mail: the team is told (UID and code only) and the batch goes on without it.
        await state.markPoison(INBOX, validity, uid);
        (result.poisonedUids ??= []).push(uid);
      } else {
        result.processed += 1;
        result.outcomes[outcome.outcome] = (result.outcomes[outcome.outcome] ?? 0) + 1;
      }
      failure = null;
      lastUid = uid;
      await state.write(INBOX, { uidValidity: validity, lastUid });
    }

    // Everything the search covered is done: up to the current UID when every match fit in the
    // batch, else up to just before the first match that didn't (it is read next time). So
    // unrelated mail is never searched again, and no match is ever skipped.
    const covered =
      batch.length < uids.length ? uids[batch.length] - 1 : Math.max(current, lastUid);
    if (covered > lastUid) await state.write(INBOX, { uidValidity: validity, lastUid: covered });
    return result;
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Saves the position, keeping the failure count of the mail that is still failing, if any. */
function writeFailure(
  state: PollStateStore,
  uidValidity: bigint,
  lastUid: number,
  failure: { uid: number; attempts: number; since: Date } | null,
): Promise<void> {
  return state.write(INBOX, {
    uidValidity,
    lastUid,
    ...(failure && {
      failedUid: failure.uid,
      failedAttempts: failure.attempts,
      failedSince: failure.since,
    }),
  });
}
