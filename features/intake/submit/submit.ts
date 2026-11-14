import { randomUUID } from "node:crypto";
import { createCase } from "@/features/claims";
import { systemClock } from "@/shared/clock";
import { CreateCaseResult, type Clock, type IntakeSubmission } from "@/shared/contracts";
import type { Json } from "@/shared/supabase";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { latestConsent, toConsentRef } from "../consent/store";
import { intakeClient } from "../draft/db";
import {
  TICKET_BUCKET,
  deleteDraft,
  getDraft,
  mergeDraftData,
  type IntakeDraft,
} from "../draft/store";
import { draftToSubmission, type SubmissionError } from "./mapping";

/**
 * Where a submitted ticket lives. `purgeExpiredDrafts` only looks under `drafts/` and `uploads/`,
 * so a file here stays as long as the case needs it (the claim email attaches it, domain C).
 */
export const SUBMITTED_PREFIX = "submitted/";

/** A claim on the draft older than this is a crashed attempt and may be taken over. */
const CLAIM_LEASE_MS = 2 * 60_000;
const WAIT_MS = 200;
const WAIT_TRIES = 50;

export interface SubmitDeps {
  db?: ServiceClient;
  clock?: Clock;
  /** Domain C's createCase; injectable so tests can drive every outcome. */
  createCase?: (submission: IntakeSubmission) => Promise<CreateCaseResult>;
  /** Waits between looks at a claim another request holds; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

export type SubmitDraftResult =
  | { ok: true; result: CreateCaseResult }
  | SubmissionError
  /** The draft is gone: another request already submitted it and cleaned up. */
  | { ok: false; reason: "already_submitted" }
  /** Another request is submitting this draft and has not finished. */
  | { ok: false; reason: "busy" };

type Claim =
  | { kind: "won"; by: string }
  | { kind: "recorded"; result: CreateCaseResult }
  | { kind: "gone" }
  | { kind: "busy" };

const submitState = (data: Json): { at?: string; by?: string; result?: CreateCaseResult } => {
  const state = (data as { submit?: unknown } | null)?.submit;
  if (!state || typeof state !== "object") return {};
  const { at, by, result } = state as { at?: unknown; by?: unknown; result?: unknown };
  const parsed = CreateCaseResult.safeParse(result);
  return {
    ...(typeof at === "string" && { at }),
    ...(typeof by === "string" && { by }),
    ...(parsed.success && { result: parsed.data }),
  };
};

/**
 * Turns a finished draft into a case, once. Server-only.
 *
 * 1. Claims the draft: a compare-and-swap on the row, so two requests at once can't both go on.
 *    A crashed attempt's claim goes stale after two minutes and can be taken over.
 * 2. Checks the draft and its consent (`draftToSubmission`); nothing moves if a part is missing.
 * 3. Copies the ticket to `submitted/<draftId>.<ext>`, out of the purge's reach.
 * 4. `createCase` (domain C).
 * 5. Records the result on the draft, then deletes the draft (row and the `drafts/` file). The
 *    case and the consent hold everything that is needed later, so nothing else is kept (data
 *    minimization). The consent row stays: its `draft_id` becomes null.
 *
 * A failure before the case leaves the draft whole, deletes the `submitted/` copy it made and
 * releases its own claim (only if the claim is still its own), so a retry works. A second call
 * finds the recorded result, or no draft (`already_submitted`).
 *
 * Windows that remain, because `cases` has no unique key on the draft: (a) a lease shorter than
 * a slow `createCase`, so a second request takes over and makes a second case; (b) a crash
 * between `createCase` and recording the result, then a takeover after the lease; (c)
 * `createCase` committing and then throwing, so we delete the ticket copy and release the claim
 * of a case that exists. The full fix is a unique `draft_id` on `cases` (domain C, suggested on
 * C's tracker #26); until then these are rare and recoverable by the team.
 *
 * Retention: the `submitted/` copy stays for every case, also a not eligible one. That is a
 * point for the legal review.
 */
export async function submitDraft(
  draft: IntakeDraft,
  deps: SubmitDeps = {},
): Promise<SubmitDraftResult> {
  const raw = deps.db ?? createServiceClient();
  const clock = deps.clock ?? systemClock;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const make =
    deps.createCase ?? ((s: IntakeSubmission) => createCase(s, deps.db ? { db: deps.db } : {}));

  const claim = await claimDraft(raw, draft.id, clock, sleep);
  if (claim.kind === "recorded") {
    await cleanUp(raw, draft.id);
    return { ok: true, result: claim.result };
  }
  if (claim.kind === "gone") return { ok: false, reason: "already_submitted" };
  if (claim.kind === "busy") return { ok: false, reason: "busy" };

  const mine = claim.by;
  let caseCreated = false;
  let copied: string | null = null;
  try {
    const current = await getDraft(draft.id, { db: raw, clock });
    if (!current) return { ok: false, reason: "already_submitted" };
    const ticket = current.ticket;
    if (!ticket) {
      await release(raw, draft.id, mine);
      return { ok: false, reason: "ticket_missing", step: "foto" };
    }
    const consent = await latestConsent(current.id, { db: raw });
    const mapped = draftToSubmission(current, consent && toConsentRef(consent), {
      ticketPath: submittedPath(current.id, ticket.path),
    });
    if (!mapped.ok) {
      await release(raw, draft.id, mine);
      return mapped;
    }

    const target = mapped.submission.ticketPath;
    if (await copyTicket(raw, ticket.path, target)) copied = target;
    const result = await make(mapped.submission);
    caseCreated = true;

    // From here the case exists: whatever fails below must not let a retry create another.
    await mergeDraftData(
      draft.id,
      { submit: { at: clock.now().toISOString(), result } as unknown as Json },
      { db: raw, clock },
    ).catch(() => console.error("[intake] recording the submit result failed"));
    await cleanUp(raw, draft.id);
    return { ok: true, result };
  } catch (error) {
    if (!caseCreated) {
      // No case: nothing may point at the copy, and the draft goes back to how it was.
      if (copied)
        await raw.storage
          .from(TICKET_BUCKET)
          .remove([copied])
          .catch(() => undefined);
      await release(raw, draft.id, mine);
    }
    throw error;
  }
}

/** `submitted/<draftId>.<ext>`: keyed by the draft id, so a retry lands on the same file. */
function submittedPath(draftId: string, draftTicketPath: string): string {
  const ext = draftTicketPath.split(".").pop();
  return `${SUBMITTED_PREFIX}${draftId}.${ext}`;
}

async function claimDraft(
  raw: ServiceClient,
  id: string,
  clock: Clock,
  sleep: (ms: number) => Promise<void>,
): Promise<Claim> {
  const db = intakeClient(raw);
  const by = randomUUID();
  for (let attempt = 0; attempt < WAIT_TRIES; attempt++) {
    const now = clock.now();
    const { data, error } = await db
      .from("intake_drafts")
      .select("data, updated_at")
      .eq("id", id)
      .gt("expires_at", now.toISOString())
      .maybeSingle();
    if (error) throw new Error(`draft read failed: ${error.message}`);
    if (!data) return { kind: "gone" };

    const state = submitState(data.data);
    if (state.result) return { kind: "recorded", result: state.result };
    const held = state.at !== undefined && now.getTime() - Date.parse(state.at) < CLAIM_LEASE_MS;
    if (held) {
      await sleep(WAIT_MS);
      continue;
    }

    // Compare-and-swap on `updated_at`: only one of two requests that read the same row wins.
    const won = await db
      .from("intake_drafts")
      .update({
        data: { ...(data.data as object), submit: { at: now.toISOString(), by } } as Json,
        updated_at: now.toISOString(),
      })
      .eq("id", id)
      .eq("updated_at", data.updated_at)
      .select("id");
    if (won.error) throw new Error(`draft claim failed: ${won.error.message}`);
    if ((won.data ?? []).length > 0) return { kind: "won", by };
  }
  return { kind: "busy" };
}

/**
 * Gives the claim back after a failure, best effort, and only if it is still this request's: a
 * compare-and-swap on the row, so a request whose claim was taken over can't wipe the new
 * owner's. A claim that is never released goes stale anyway.
 */
async function release(raw: ServiceClient, id: string, by: string): Promise<void> {
  const db = intakeClient(raw);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data } = await db
        .from("intake_drafts")
        .select("data, updated_at")
        .eq("id", id)
        .maybeSingle();
      if (!data || submitState(data.data).by !== by) return;
      const rest = { ...(data.data as Record<string, Json>) };
      delete rest.submit;
      const done = await db
        .from("intake_drafts")
        .update({ data: rest as Json })
        .eq("id", id)
        .eq("updated_at", data.updated_at)
        .select("id");
      if ((done.data ?? []).length > 0) return;
    }
  } catch {
    // Best effort.
  }
}

/** Copies the ticket unless it is already there; true if this call made the copy. */
async function copyTicket(raw: ServiceClient, from: string, to: string): Promise<boolean> {
  const bucket = raw.storage.from(TICKET_BUCKET);
  if ((await bucket.exists(to)).data === true) return false;
  const copied = await bucket.copy(from, to);
  if (copied.error) throw new Error(`ticket copy failed: ${copied.error.message}`);
  return true;
}

/** Deletes the draft with its `drafts/` file. The case exists, so a failure here is only logged. */
async function cleanUp(raw: ServiceClient, id: string): Promise<void> {
  await deleteDraft(id, { db: raw }).catch(() =>
    console.error("[intake] draft clean-up after submit failed"),
  );
}
