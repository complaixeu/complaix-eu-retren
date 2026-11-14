import { describe, expect, it, vi } from "vitest";
import type { IngestResult } from "@/features/claims/inbound";
import {
  INBOX,
  assertPollConfig,
  imapConfigFromEnv,
  pollInbox,
  type ImapClient,
  type ImapSearch,
  type PollState,
  type PollStateStore,
} from "@/features/claims/poll-inbox";

// pollInbox (docs/plans/C-claims.md C4) against a fake IMAP client only: never a real mailbox.

const ENV = {
  MAIL_PROVIDER: "gmail",
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "465",
  SMTP_SECURE: "true",
  SMTP_USER: "retren@retren.example",
  SMTP_PASS: "not-a-real-password",
  IMAP_HOST: "imap.example.test",
  IMAP_PORT: "993",
  IMAP_SECURE: "true",
  MAIL_REDIRECT_ALL_TO: "team@retren.example",
};

type FakeMail = { uid: number; subject: string; from: string };

/** An in-memory IMAP mailbox. It records every call; anything that changes the mailbox is a mutation. */
class FakeImap implements ImapClient {
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
          (c.from !== undefined && m.from.includes(c.from)),
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
      source: Buffer.from(`Subject: ${m.subject}\r\nFrom: ${m.from}\r\n\r\nuid ${n}`),
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

function memoryState(initial?: PollState): PollStateStore & { value: PollState | null } {
  const store = {
    value: initial ?? null,
    async read(mailbox: string) {
      expect(mailbox).toBe(INBOX);
      return store.value;
    },
    async write(mailbox: string, state: PollState) {
      expect(mailbox).toBe(INBOX);
      store.value = { ...state };
    },
  };
  return store;
}

const claimMail = (uid: number): FakeMail => ({
  uid,
  subject: `Re: Reclamacion [RTN-ABCD${uid}]`,
  from: "atencion.cliente@iryo.eu",
});
const unrelated = (uid: number): FakeMail => ({
  uid,
  subject: "Newsletter",
  from: "news@shop.example",
});

/** Records the UID of every raw mail it gets (from the fake source) and answers `processed`. */
function recordingIngest(fail: Set<number> = new Set()) {
  const seen: number[] = [];
  const ingest = vi.fn(async (raw: Buffer): Promise<IngestResult> => {
    const uid = Number(/uid (\d+)/.exec(raw.toString())![1]);
    seen.push(uid);
    if (fail.has(uid)) return { outcome: "error", reason: "database" };
    return { outcome: "skipped", reason: "unrelated" };
  });
  return { ingest, seen };
}

describe("pollInbox", () => {
  it("opens INBOX read-only (EXAMINE), sets no flags and logs out", async () => {
    const imap = new FakeImap([claimMail(1), claimMail(2), claimMail(3)]);
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 1 });
    const { ingest } = recordingIngest();
    await pollInbox({ client: imap, state, ingest, env: ENV });
    expect(imap.opened).toEqual([{ path: "INBOX", readOnly: true }]);
    expect(imap.mutations).toEqual([]);
    expect(imap.calls).not.toContain("messageFlagsAdd");
    expect(imap.loggedOut).toBe(true);
  });

  it("searches on the server: subject [RTN- or an operator's domain, after the stored UID", async () => {
    const imap = new FakeImap([claimMail(1), unrelated(2), claimMail(3)]);
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 1 });
    const { ingest, seen } = recordingIngest();
    await pollInbox({ client: imap, state, ingest, env: ENV });
    expect(imap.searches).toHaveLength(1);
    const q = imap.searches[0];
    expect(q.uid).toBe("2:*");
    expect(q.or).toEqual(expect.arrayContaining([{ subject: "[RTN-" }, { from: "@iryo.eu" }]));
    // Unrelated mail never even leaves the server.
    expect(imap.fetched).toEqual([3]);
    expect(seen).toEqual([3]);
  });

  it("the first run imports nothing that was already there", async () => {
    const imap = new FakeImap([claimMail(1), claimMail(2), claimMail(3)], BigInt(7));
    const state = memoryState();
    const { ingest } = recordingIngest();
    const out = await pollInbox({ client: imap, state, ingest, env: ENV });
    expect(ingest).not.toHaveBeenCalled();
    expect(imap.fetched).toEqual([]);
    expect(state.value).toEqual({ uidValidity: BigInt(7), lastUid: 3 });
    expect(out).toMatchObject({ started: "first_run", processed: 0 });
    expect(imap.opened[0].readOnly).toBe(true);

    // Mail that arrives afterwards is read on the next run.
    imap.mails.push(claimMail(4));
    const next = await pollInbox({ client: imap, state, ingest, env: ENV });
    expect(imap.fetched).toEqual([4]);
    expect(next.processed).toBe(1);
    expect(state.value).toEqual({ uidValidity: BigInt(7), lastUid: 4 });
  });

  it("resumes from the stored UID", async () => {
    const imap = new FakeImap([1, 2, 3, 4, 5].map(claimMail));
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 2 });
    const { ingest, seen } = recordingIngest();
    const out = await pollInbox({ client: imap, state, ingest, env: ENV });
    expect(seen).toEqual([3, 4, 5]);
    expect(out.processed).toBe(3);
    expect(state.value).toEqual({ uidValidity: BigInt(1), lastUid: 5 });

    // Nothing new: the `N:*` quirk returns the last message again, and it is not re-imported.
    const again = await pollInbox({ client: imap, state, ingest, env: ENV });
    expect(again.processed).toBe(0);
    expect(seen).toEqual([3, 4, 5]);
  });

  it("advances past unrelated mail after a full batch", async () => {
    const imap = new FakeImap([claimMail(1), unrelated(2), unrelated(3)]);
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 1 });
    const { ingest } = recordingIngest();
    await pollInbox({ client: imap, state, ingest, env: ENV });
    expect(ingest).not.toHaveBeenCalled();
    expect(state.value).toEqual({ uidValidity: BigInt(1), lastUid: 3 });
  });

  it("a UIDVALIDITY change restarts from the current UID without re-importing", async () => {
    const imap = new FakeImap([1, 2, 3, 4, 5].map(claimMail), BigInt(2));
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 2 });
    const { ingest } = recordingIngest();
    const out = await pollInbox({ client: imap, state, ingest, env: ENV });
    expect(ingest).not.toHaveBeenCalled();
    expect(imap.fetched).toEqual([]);
    expect(state.value).toEqual({ uidValidity: BigInt(2), lastUid: 5 });
    expect(out).toMatchObject({ started: "uidvalidity_changed", processed: 0 });
  });

  it("a failure mid-batch resumes at the failed message", async () => {
    const imap = new FakeImap([1, 2, 3, 4, 5].map(claimMail));
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 1 });
    const failing = recordingIngest(new Set([4]));
    const out = await pollInbox({ client: imap, state, ingest: failing.ingest, env: ENV });
    expect(failing.seen).toEqual([2, 3, 4]);
    expect(out).toMatchObject({ processed: 2, failedAtUid: 4 });
    expect(state.value).toEqual({ uidValidity: BigInt(1), lastUid: 3 });
    expect(imap.loggedOut).toBe(true);

    const ok = recordingIngest();
    const next = await pollInbox({ client: imap, state, ingest: ok.ingest, env: ENV });
    expect(ok.seen).toEqual([4, 5]);
    expect(next.failedAtUid).toBeUndefined();
    expect(state.value).toEqual({ uidValidity: BigInt(1), lastUid: 5 });
  });

  it("a fetch that fails mid-batch also resumes at that message", async () => {
    const imap = new FakeImap([1, 2, 3].map(claimMail));
    imap.failFetch.add(3);
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 1 });
    const { ingest, seen } = recordingIngest();
    const out = await pollInbox({ client: imap, state, ingest, env: ENV });
    expect(seen).toEqual([2]);
    expect(out.failedAtUid).toBe(3);
    expect(state.value).toEqual({ uidValidity: BigInt(1), lastUid: 2 });
  });

  it("reads at most `limit` mails per run and continues on the next one", async () => {
    const imap = new FakeImap([1, 2, 3, 4, 5, 6].map(claimMail));
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 1 });
    const { ingest, seen } = recordingIngest();
    await pollInbox({ client: imap, state, ingest, env: ENV, limit: 2 });
    expect(seen).toEqual([2, 3]);
    expect(state.value).toEqual({ uidValidity: BigInt(1), lastUid: 3 });
    await pollInbox({ client: imap, state, ingest, env: ENV, limit: 2 });
    expect(seen).toEqual([2, 3, 4, 5]);
  });

  it("same mailbox for the redirect and the sender: refuses to start", async () => {
    const imap = new FakeImap([claimMail(1)]);
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 0 });
    const { ingest } = recordingIngest();
    const env = { ...ENV, MAIL_REDIRECT_ALL_TO: " Retren@Retren.example " };
    await expect(pollInbox({ client: imap, state, ingest, env })).rejects.toThrow(
      /MAIL_REDIRECT_ALL_TO/,
    );
    expect(imap.calls).toEqual([]);
    expect(state.value).toEqual({ uidValidity: BigInt(1), lastUid: 0 });
    expect(() => assertPollConfig(env)).toThrow(/different mailbox/);
    // The IMAP user (when it is not SMTP_USER) counts too.
    expect(() => assertPollConfig({ ...ENV, IMAP_USER: "team@retren.example" })).toThrow(
      /different mailbox/,
    );
  });

  it("IMAP settings: IMAP_USER and IMAP_PASS default to SMTP_USER and SMTP_PASS", () => {
    expect(imapConfigFromEnv(ENV)).toEqual({
      host: "imap.example.test",
      port: 993,
      secure: true,
      user: "retren@retren.example",
      pass: "not-a-real-password",
    });
    expect(
      imapConfigFromEnv({ ...ENV, IMAP_USER: "other@retren.example", IMAP_PASS: "x" }),
    ).toMatchObject({ user: "other@retren.example", pass: "x" });
    expect(() => imapConfigFromEnv({ ...ENV, IMAP_HOST: "" })).toThrow(/IMAP_HOST/);
    // Errors name the variable, never a value.
    try {
      imapConfigFromEnv({ ...ENV, IMAP_PORT: "nope" });
    } catch (e) {
      expect(String(e)).not.toContain(ENV.SMTP_PASS);
    }
  });
});
