import { describe, expect, it, vi } from "vitest";
import type { IngestResult } from "@/features/claims/inbound";
import { assertPollConfig, imapConfigFromEnv, pollInbox } from "@/features/claims/poll-inbox";
import { FakeImap, memoryState, type FakeMail } from "../../fixtures/claims/fake-imap";

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
    expect(state.value).toEqual({
      uidValidity: BigInt(1),
      lastUid: 3,
      failedUid: 4,
      failedAttempts: 1,
      failedSince: expect.any(Date),
    });
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
    // A fetch error is not the mail's fault: no failure is counted.
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

  it("a mail that fails 3 times over 24 hours is put in the team queue (UID and code only) and skipped", async () => {
    const imap = new FakeImap([1, 2, 3, 4].map(claimMail));
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 1 });
    const failing = recordingIngest(new Set([3]));

    const clock = { t: Date.parse("2030-01-01T00:00:00Z") };
    const now = () => new Date(clock.t);
    const first = await pollInbox({ client: imap, state, ingest: failing.ingest, env: ENV, now });
    expect(first.failedAtUid).toBe(3);
    expect(state.value).toEqual({
      uidValidity: BigInt(1),
      lastUid: 2,
      failedUid: 3,
      failedAttempts: 1,
      failedSince: expect.any(Date),
    });
    clock.t += 3_600_000;
    await pollInbox({ client: imap, state, ingest: failing.ingest, env: ENV, now });
    expect(state.value).toMatchObject({ lastUid: 2, failedUid: 3, failedAttempts: 2 });
    expect(state.poisoned).toEqual([]);

    // The 3rd failure, 24 h after the first: marked for the team, skipped, the next mail is read.
    clock.t = Date.parse("2030-01-02T00:00:00Z");
    const third = await pollInbox({ client: imap, state, ingest: failing.ingest, env: ENV, now });
    expect(state.poisoned).toEqual([{ uidValidity: BigInt(1), uid: 3 }]);
    expect(third).toMatchObject({ poisonedUids: [3] });
    expect(third.failedAtUid).toBeUndefined();
    expect(failing.seen).toEqual([2, 3, 3, 3, 4]);
    expect(state.value).toEqual({ uidValidity: BigInt(1), lastUid: 4 });
  });

  it("a success resets the failure count", async () => {
    const imap = new FakeImap([1, 2, 3].map(claimMail));
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 1 });
    const failing = recordingIngest(new Set([2]));
    await pollInbox({ client: imap, state, ingest: failing.ingest, env: ENV });
    await pollInbox({ client: imap, state, ingest: failing.ingest, env: ENV });
    expect(state.value).toMatchObject({ failedUid: 2, failedAttempts: 2 });

    const ok = recordingIngest();
    await pollInbox({ client: imap, state, ingest: ok.ingest, env: ENV });
    expect(state.value).toEqual({ uidValidity: BigInt(1), lastUid: 3 });
    expect(state.poisoned).toEqual([]);

    // A later failure of another mail starts counting from 1 again.
    imap.mails.push(claimMail(4));
    await pollInbox({
      client: imap,
      state,
      ingest: recordingIngest(new Set([4])).ingest,
      env: ENV,
    });
    expect(state.value).toMatchObject({ lastUid: 3, failedUid: 4, failedAttempts: 1 });
  });

  it("a batch exactly at `limit` followed by unrelated mail advances to the current UID", async () => {
    const imap = new FakeImap([
      claimMail(1),
      claimMail(2),
      claimMail(3),
      unrelated(4),
      unrelated(5),
    ]);
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 1 });
    const { ingest, seen } = recordingIngest();
    await pollInbox({ client: imap, state, ingest, env: ENV, limit: 2 });
    expect(seen).toEqual([2, 3]);
    expect(state.value).toEqual({ uidValidity: BigInt(1), lastUid: 5 });
  });

  it("a truncated batch covers up to the next match, and the next run picks up the rest", async () => {
    const imap = new FakeImap([
      claimMail(1),
      claimMail(2),
      unrelated(3),
      claimMail(4),
      unrelated(5),
      claimMail(6),
      unrelated(7),
    ]);
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 1 });
    const { ingest, seen } = recordingIngest();
    await pollInbox({ client: imap, state, ingest, env: ENV, limit: 2 });
    expect(seen).toEqual([2, 4]);
    // Past the unrelated 5, never past the match 6 that didn't fit.
    expect(state.value).toEqual({ uidValidity: BigInt(1), lastUid: 5 });

    await pollInbox({ client: imap, state, ingest, env: ENV, limit: 2 });
    expect(imap.searches.at(-1)!.uid).toBe("6:*");
    expect(seen).toEqual([2, 4, 6]);
    expect(state.value).toEqual({ uidValidity: BigInt(1), lastUid: 7 });

    imap.mails.push(unrelated(8), unrelated(9));
    await pollInbox({ client: imap, state, ingest, env: ENV, limit: 2 });
    expect(seen).toEqual([2, 4, 6]);
    expect(state.value).toEqual({ uidValidity: BigInt(1), lastUid: 9 });
  });

  it("a failure covers the unrelated mail before the failed one", async () => {
    const imap = new FakeImap([claimMail(1), unrelated(2), unrelated(3), claimMail(4)]);
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 1 });
    await pollInbox({
      client: imap,
      state,
      ingest: recordingIngest(new Set([4])).ingest,
      env: ENV,
    });
    expect(state.value).toMatchObject({ lastUid: 3, failedUid: 4, failedAttempts: 1 });
  });

  it("failures within 3 hours are never skipped, however many (no poison before 24 h)", async () => {
    const imap = new FakeImap([1, 2, 3].map(claimMail));
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 1 });
    const failing = recordingIngest(new Set([2]));
    const clock = { t: Date.parse("2030-01-01T00:00:00Z") };
    const now = () => new Date(clock.t);
    for (let i = 0; i < 6; i++) {
      await pollInbox({ client: imap, state, ingest: failing.ingest, env: ENV, now });
      clock.t += 30 * 60_000;
    }
    expect(state.poisoned).toEqual([]);
    expect(state.value).toMatchObject({ lastUid: 1, failedUid: 2, failedAttempts: 6 });
    expect(state.value?.failedSince?.toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  it("3+ failures spanning 24 hours are skipped, and the next mail is read", async () => {
    const imap = new FakeImap([1, 2, 3].map(claimMail));
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 1 });
    const failing = recordingIngest(new Set([2]));
    const clock = { t: Date.parse("2030-01-01T00:00:00Z") };
    const now = () => new Date(clock.t);
    for (const hours of [0, 1, 2]) {
      clock.t = Date.parse("2030-01-01T00:00:00Z") + hours * 3_600_000;
      await pollInbox({ client: imap, state, ingest: failing.ingest, env: ENV, now });
    }
    expect(state.poisoned).toEqual([]);
    clock.t = Date.parse("2030-01-02T00:00:00Z");
    const out = await pollInbox({ client: imap, state, ingest: failing.ingest, env: ENV, now });
    expect(state.poisoned).toEqual([{ uidValidity: BigInt(1), uid: 2 }]);
    expect(out.poisonedUids).toEqual([2]);
    expect(failing.seen.at(-1)).toBe(3);
    expect(state.value).toEqual({ uidValidity: BigInt(1), lastUid: 3 });
  });

  it("a connection drop or fetch error never counts towards the limit", async () => {
    const imap = new FakeImap([1, 2, 3].map(claimMail));
    imap.failFetch.add(2);
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 1 });
    const { ingest } = recordingIngest();
    const clock = { t: Date.parse("2030-01-01T00:00:00Z") };
    for (let i = 0; i < 5; i++) {
      const out = await pollInbox({
        client: imap,
        state,
        ingest,
        env: ENV,
        now: () => new Date(clock.t),
      });
      expect(out.failedAtUid).toBe(2);
      clock.t += 24 * 3_600_000;
    }
    expect(state.poisoned).toEqual([]);
    expect(state.value?.failedAttempts ?? 0).toBe(0);
    expect(state.value?.lastUid).toBe(1);
    // The mailbox comes back: the mail is read normally.
    imap.failFetch.clear();
    await pollInbox({ client: imap, state, ingest, env: ENV });
    expect(state.value).toEqual({ uidValidity: BigInt(1), lastUid: 3 });
  });

  it("a threaded reply from another domain with no reference is fetched (and team-queued)", async () => {
    const reply: FakeMail = {
      uid: 2,
      subject: "Re: Reclamacion por retraso",
      from: "soporte@tickets.example",
      inReplyTo: "<rtn-abcd0001.uuid@retren.example>",
    };
    const imap = new FakeImap([claimMail(1), reply, unrelated(3)]);
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 1 });
    const { ingest, seen } = recordingIngest();
    await pollInbox({ client: imap, state, ingest, env: ENV });
    expect(imap.searches[0].or).toEqual(
      expect.arrayContaining([
        { header: { "in-reply-to": "@retren.example" } },
        { header: { references: "@retren.example" } },
      ]),
    );
    // The threaded reply reaches ingestMessage (which then queues it as a wrong sender); the
    // unrelated newsletter never leaves the server.
    expect(seen).toEqual([2]);
    expect(imap.fetched).toEqual([2]);
  });

  it("the sending domain is MAIL_SENDING_DOMAIN, else SMTP_USER's domain (as C3's Message-IDs)", async () => {
    const imap = new FakeImap([claimMail(1), claimMail(2)]);
    const state = memoryState({ uidValidity: BigInt(1), lastUid: 1 });
    const { ingest } = recordingIngest();
    await pollInbox({
      client: imap,
      state,
      ingest,
      env: { ...ENV, MAIL_SENDING_DOMAIN: "mail.retren.example" },
    });
    expect(imap.searches[0].or).toEqual(
      expect.arrayContaining([{ header: { "in-reply-to": "@mail.retren.example" } }]),
    );
  });
});
