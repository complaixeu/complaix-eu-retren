// An in-memory IMAP mailbox and poll-state store for the mailbox tests (C4). Shared by the unit
// tests (tests/unit/claims/poll-inbox.test.ts) and the integration tests of "Check inbox now"
// (tests/integration/claims/team.test.ts). Never a real mailbox: it records every call, and any
// mailbox-changing command is recorded as a mutation.
import { expect } from "vitest";
import {
  INBOX,
  type ImapClient,
  type ImapSearch,
  type PollState,
  type PollStateStore,
} from "@/features/claims/poll-inbox";

export type FakeMail = {
  uid: number;
  subject: string;
  from: string;
  inReplyTo?: string;
  references?: string;
  /** The whole raw mail, when a test needs a real one; otherwise a minimal one is built. */
  raw?: string;
};

/** An in-memory IMAP mailbox. It records every call; anything that changes the mailbox is a mutation. */
export class FakeImap implements ImapClient {
  calls: string[] = [];
  mutations: string[] = [];
  opened: { path: string; readOnly: unknown }[] = [];
  searches: ImapSearch[] = [];
  fetched: number[] = [];
  connected = false;
  loggedOut = false;
  failFetch = new Set<number>();

  constructor(
    public mails: FakeMail[],
    public uidValidity: bigint = BigInt(1),
  ) {}

  get uidNext() {
    return Math.max(0, ...this.mails.map((m) => m.uid)) + 1;
  }

  async connect() {
    this.calls.push("connect");
    this.connected = true;
  }
  async logout() {
    this.calls.push("logout");
    this.loggedOut = true;
  }
  async mailboxOpen(path: string, opts: { readOnly: true }) {
    this.calls.push("mailboxOpen");
    this.opened.push({ path, readOnly: opts?.readOnly });
    return {
      path,
      uidValidity: this.uidValidity,
      uidNext: this.uidNext,
      exists: this.mails.length,
    };
  }
  async search(query: ImapSearch, opts: { uid: true }) {
    this.calls.push("search");
    expect(opts).toEqual({ uid: true });
    this.searches.push(query);
    const [lo, hi] = String(query.uid).split(":");
    const from = Number(lo);
    const max = Math.max(0, ...this.mails.map((m) => m.uid));
    // IMAP's `N:*` always includes the last message, even when N is beyond it.
    const inRange = (u: number) => (hi === "*" ? u >= Math.min(from, max) : u === from);
    const matches = (m: FakeMail) =>
      (query.or ?? [query]).some(
        (c) =>
          (c.subject !== undefined && m.subject.includes(c.subject)) ||
          (c.from !== undefined && m.from.includes(c.from)) ||
          (c.header?.["in-reply-to"] !== undefined &&
            (m.inReplyTo ?? "").includes(c.header["in-reply-to"])) ||
          (c.header?.references !== undefined &&
            (m.references ?? "").includes(c.header.references)),
      );
    return this.mails.filter((m) => inRange(m.uid) && matches(m)).map((m) => m.uid);
  }
  async fetchOne(uid: string, query: { source: true; uid: true }, opts: { uid: true }) {
    this.calls.push("fetchOne");
    expect(query).toEqual({ source: true, uid: true });
    expect(opts).toEqual({ uid: true });
    const n = Number(uid);
    if (this.failFetch.has(n)) throw new Error("connection dropped");
    this.fetched.push(n);
    const m = this.mails.find((x) => x.uid === n);
    if (!m) return false as const;
    return {
      uid: n,
      source: Buffer.from(m.raw ?? `Subject: ${m.subject}\r\nFrom: ${m.from}\r\n\r\nuid ${n}`),
    };
  }
  // Mailbox-changing commands: pollInbox must never call any of them.
  async messageFlagsAdd() {
    this.mutations.push("messageFlagsAdd");
  }
  async messageFlagsSet() {
    this.mutations.push("messageFlagsSet");
  }
  async messageFlagsRemove() {
    this.mutations.push("messageFlagsRemove");
  }
  async messageDelete() {
    this.mutations.push("messageDelete");
  }
  async messageMove() {
    this.mutations.push("messageMove");
  }
}

/** An in-memory poll-state store (the table claims_mail_poll_state, without the database). */
export function memoryState(
  initial?: PollState,
): PollStateStore & { value: PollState | null; poisoned: { uidValidity: bigint; uid: number }[] } {
  const store = {
    value: initial ?? null,
    poisoned: [] as { uidValidity: bigint; uid: number }[],
    async read(mailbox: string) {
      expect(mailbox).toBe(INBOX);
      return store.value;
    },
    async write(mailbox: string, state: PollState) {
      expect(mailbox).toBe(INBOX);
      store.value = { ...state };
    },
    async markPoison(mailbox: string, uidValidity: bigint, uid: number) {
      expect(mailbox).toBe(INBOX);
      store.poisoned.push({ uidValidity, uid });
    },
  };
  return store;
}
