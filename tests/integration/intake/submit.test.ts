import { beforeAll, describe, expect, it } from "vitest";
import { insertConsent, toConsentRef } from "@/features/intake/consent/store";
import { purgeExpiredDrafts } from "@/features/intake/draft/purge";
import {
  TICKET_BUCKET,
  createDraft,
  getDraft,
  mergeDraftData,
  type IntakeDraft,
} from "@/features/intake/draft/store";
import { readTicketUpload } from "@/features/intake/upload/read";
import { submitDraft } from "@/features/intake/submit/submit";
import { createCase } from "@/features/claims";
import type { EligibilityResult } from "@/shared/contracts";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { waitForDb } from "../../fixtures/claims/db-ready";
import { PLACEHOLDER_PNG } from "../../fixtures/intake/tickets";
import { DELAYS, tripData } from "../../fixtures/intake/submit";

// [A7] Submitting a draft with the real createCase against the local Supabase: a case exists, the
// draft is cleaned up, the ticket sits where the purge never looks, and it happens once.
const HOUR = 3_600_000;
let db: ServiceClient;

beforeAll(async () => {
  db = createServiceClient();
  await waitForDb(db);
});

async function newDraft(data: Record<string, unknown>): Promise<IntakeDraft> {
  const read = await readTicketUpload(
    new File([Buffer.from(PLACEHOLDER_PNG)], "billete.png", { type: "image/png" }),
  );
  if (!read.ok) throw new Error("placeholder refused");
  const draft = await createDraft(read.ticket, { db });
  return (await mergeDraftData(draft.id, data as never, { db }))!;
}

async function readyDraft(data: Record<string, unknown> = tripData(DELAYS.eligible)) {
  const draft = await newDraft(data);
  const consent = await insertConsent(
    { draftId: draft.id, textVersion: "v-test", ip: "203.0.113.9", tripSnapshot: { ticket: {} } },
    { db },
  );
  return { draft, consent };
}

const casesOf = async (draftId: string) => {
  const { data, error } = await db.from("cases").select("*").eq("submission->>draftId", draftId);
  expect(error).toBeNull();
  return data ?? [];
};
const exists = async (path: string) =>
  (await db.storage.from(TICKET_BUCKET).exists(path)).data === true;
const rowsOf = async (table: string, column: string, value: string) => {
  const { data } = await db
    .from(table as never)
    .select("*")
    .eq(column, value);
  return (data ?? []) as Record<string, unknown>[];
};
const sleep = async () => {};

describe("submitDraft (real createCase, local Supabase)", () => {
  it("creates the case, moves the ticket, deletes the draft and keeps the consent", async () => {
    const { draft, consent } = await readyDraft();
    const out = await submitDraft(draft, { db, sleep });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.eligibility.status).toBe("eligible");

    const cases = await casesOf(draft.id);
    expect(cases).toHaveLength(1);
    expect(cases[0].id).toBe(out.result.caseId);
    const submission = cases[0].submission as { ticketPath: string; consent: unknown };
    expect(submission.ticketPath).toBe(`submitted/${draft.id}.png`);
    expect(submission.consent).toEqual(toConsentRef(consent));

    expect(await getDraft(draft.id, { db })).toBeNull();
    expect(await rowsOf("intake_drafts", "id", draft.id)).toHaveLength(0);
    expect(await exists(draft.ticket!.path)).toBe(false);
    expect(await exists(submission.ticketPath)).toBe(true);

    // The consent evidence outlives the draft.
    const kept = await rowsOf("consents", "id", consent.id);
    expect(kept).toHaveLength(1);
    expect(kept[0].draft_id).toBeNull();
  });

  it("the submitted ticket survives the purge 25 hours later", async () => {
    const { draft } = await readyDraft();
    expect((await submitDraft(draft, { db, sleep })).ok).toBe(true);
    await purgeExpiredDrafts(new Date(Date.now() + 25 * HOUR), { db });
    expect(await exists(`submitted/${draft.id}.png`)).toBe(true);
  });

  it("a not eligible trip also becomes a (closed) case", async () => {
    const { draft } = await readyDraft(tripData(DELAYS.notEligible));
    const out = await submitDraft(draft, { db, sleep });
    expect(out.ok && out.result.eligibility.status).toBe("not_eligible");
    expect(await casesOf(draft.id)).toHaveLength(1);
  });

  it("a second submit of the same draft creates no second case", async () => {
    const { draft } = await readyDraft();
    const first = await submitDraft(draft, { db, sleep });
    const again = await submitDraft(draft, { db, sleep });
    expect(first.ok).toBe(true);
    expect(again).toEqual({ ok: false, reason: "already_submitted" });
    expect(await casesOf(draft.id)).toHaveLength(1);
  });

  it("two submits at once create one case", async () => {
    const { draft } = await readyDraft();
    const both = await Promise.all([
      submitDraft(draft, { db, sleep }),
      submitDraft(draft, { db, sleep }),
    ]);
    expect(await casesOf(draft.id)).toHaveLength(1);
    // The one that lost may be handed the recorded result, but never makes a case of its own.
    const oks = both.flatMap((r) => (r.ok ? [r.result.caseId] : []));
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(new Set(oks).size).toBe(1);
    for (const r of both) if (!r.ok) expect(["already_submitted", "busy"]).toContain(r.reason);
  });

  it("a failed createCase leaves the draft whole, and a retry creates the one case", async () => {
    const { draft } = await readyDraft();
    const failing = {
      db,
      sleep,
      createCase: async (): Promise<never> => {
        throw new Error("boom");
      },
    };
    await expect(submitDraft(draft, failing)).rejects.toThrow("boom");
    const still = await getDraft(draft.id, { db });
    expect(still?.ticket?.path).toBe(draft.ticket!.path);
    expect(await exists(draft.ticket!.path)).toBe(true);
    expect(await casesOf(draft.id)).toHaveLength(0);
    // No case: no copy of the ticket is left behind in submitted/.
    expect(await exists(`submitted/${draft.id}.png`)).toBe(false);

    expect((await submitDraft(still!, { db, sleep })).ok).toBe(true);
    expect(await casesOf(draft.id)).toHaveLength(1);
  });

  it("after a crash that left the case recorded, a retry returns it without a second case", async () => {
    const { draft } = await readyDraft();
    let calls = 0;
    const counting = (s: Parameters<typeof createCase>[0]) => {
      calls += 1;
      return createCase(s, { db });
    };
    const first = await submitDraft(draft, { db, sleep, createCase: counting });
    if (!first.ok) throw new Error("first submit failed");
    // The draft as it would be if the clean-up after the case had crashed: result recorded.
    const restored = await db.from("intake_drafts" as never).insert({
      id: draft.id,
      expires_at: new Date(Date.now() + 24 * HOUR).toISOString(),
      data: {
        ...tripData(DELAYS.eligible),
        submit: { at: new Date().toISOString(), result: first.result },
      },
    } as never);
    expect(restored.error).toBeNull();
    const out = await submitDraft((await getDraft(draft.id, { db }))!, {
      db,
      sleep,
      createCase: counting,
    });
    expect(out.ok && out.result.caseId).toBe(first.result.caseId);
    expect(calls).toBe(1);
    expect(await casesOf(draft.id)).toHaveLength(1);
  });

  it("takes over a claim that has gone stale", async () => {
    const { draft } = await readyDraft();
    const long = new Date(Date.now() - 10 * 60_000).toISOString();
    await mergeDraftData(draft.id, { submit: { at: long } } as never, { db });
    const out = await submitDraft((await getDraft(draft.id, { db }))!, { db, sleep });
    expect(out.ok).toBe(true);
    expect(await casesOf(draft.id)).toHaveLength(1);
  });

  it("answers busy while a fresh claim has no result yet", async () => {
    const { draft } = await readyDraft();
    await mergeDraftData(draft.id, { submit: { at: new Date().toISOString() } } as never, { db });
    const out = await submitDraft((await getDraft(draft.id, { db }))!, { db, sleep });
    expect(out).toEqual({ ok: false, reason: "busy" });
    expect(await casesOf(draft.id)).toHaveLength(0);
  });

  it("an incomplete draft creates nothing and moves nothing", async () => {
    const { draft } = await readyDraft({ review: tripData(DELAYS.eligible).review });
    const out = await submitDraft(draft, { db, sleep });
    expect(out).toEqual({ ok: false, reason: "answers_invalid", step: "preguntas" });
    expect(await casesOf(draft.id)).toHaveLength(0);
    expect(await exists(draft.ticket!.path)).toBe(true);
    expect(await exists(`submitted/${draft.id}.png`)).toBe(false);
    expect(await getDraft(draft.id, { db })).not.toBeNull();
  });

  it("a draft with no consent sends you to the authorization", async () => {
    const draft = await newDraft(tripData(DELAYS.eligible));
    const out = await submitDraft(draft, { db, sleep });
    expect(out).toEqual({ ok: false, reason: "consent_missing", step: "mandato" });
  });

  it("a doubtful result is stored and returned as such", async () => {
    const { draft } = await readyDraft(tripData(DELAYS.doubtful));
    const doubtful = (input: { actualArrival: string }): EligibilityResult => ({
      status: "doubtful",
      reason: "Con 60 minutos exactos el derecho es dudoso; se envía igualmente.",
      delayMinutes: 60,
      earliestSendAt: new Date(Date.parse(input.actualArrival) + 48 * HOUR).toISOString(),
      appliedRules: ["test"],
      configVersion: "test",
    });
    const out = await submitDraft(draft, {
      db,
      sleep,
      createCase: (s) => createCase(s, { db, evaluateEligibility: doubtful }),
    });
    expect(out.ok && out.result.eligibility.status).toBe("doubtful");
  });
});

/** The service client with `storage.copy` failing, everything else real. */
function withFailingCopy(real: ServiceClient): ServiceClient {
  const bound = (target: object, key: string | symbol) => {
    const value = (target as Record<string | symbol, unknown>)[key];
    return typeof value === "function" ? value.bind(target) : value;
  };
  return new Proxy(real, {
    get(target, key) {
      if (key !== "storage") return bound(target, key);
      return {
        from: (bucket: string) =>
          new Proxy(target.storage.from(bucket), {
            get: (file, method) =>
              method === "copy"
                ? async () => ({ data: null, error: { message: "copy refused" } })
                : bound(file, method),
          }),
      };
    },
  });
}

describe("the ticket copy (local Supabase)", () => {
  it("keeps the content type of the ticket", async () => {
    const { draft } = await readyDraft();
    expect((await submitDraft(draft, { db, sleep })).ok).toBe(true);
    const { data } = await db.storage.from(TICKET_BUCKET).list("submitted", {
      search: `${draft.id}.png`,
    });
    expect(data).toHaveLength(1);
    expect(data![0].metadata).toMatchObject({ mimetype: "image/png" });
  });

  it("a failing copy stops before createCase: draft whole, no case, claim released", async () => {
    const { draft } = await readyDraft();
    let calls = 0;
    const counting = (s: Parameters<typeof createCase>[0]) => {
      calls += 1;
      return createCase(s, { db });
    };
    await expect(
      submitDraft(draft, { db: withFailingCopy(db), sleep, createCase: counting }),
    ).rejects.toThrow(/ticket copy failed/);
    expect(calls).toBe(0);
    expect(await casesOf(draft.id)).toHaveLength(0);
    expect(await exists(draft.ticket!.path)).toBe(true);
    expect(await exists(`submitted/${draft.id}.png`)).toBe(false);
    // The claim was given back, so a retry works at once.
    expect((await submitDraft((await getDraft(draft.id, { db }))!, { db, sleep })).ok).toBe(true);
  });
});

describe("releasing a claim", () => {
  it("never wipes the claim of the request that took over", async () => {
    const { draft } = await readyDraft();
    const takenOver = new Date(Date.now() + 5 * 60_000).toISOString();
    const failing = {
      db,
      sleep,
      createCase: async (): Promise<never> => {
        // Meanwhile the lease ran out and another request claimed the draft.
        await mergeDraftData(
          draft.id,
          { submit: { at: takenOver, by: "other-request" } } as never,
          { db },
        );
        throw new Error("boom");
      },
    };
    await expect(submitDraft(draft, failing)).rejects.toThrow("boom");
    const row = (await rowsOf("intake_drafts", "id", draft.id))[0];
    expect((row.data as { submit?: { by?: string } }).submit?.by).toBe("other-request");
  });
});
