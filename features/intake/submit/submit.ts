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
  | { kind: "won" }
  | { kind: "recorded"; result: CreateCaseResult }
  | { kind: "gone" }
  | { kind: "busy" };

const submitState = (data: Json): { at?: string; result?: CreateCaseResult } => {
  const state = (data as { submit?: unknown } | null)?.submit;
  if (!state || typeof state !== "object") return {};
  const { at, result } = state as { at?: unknown; result?: unknown };
  const parsed = CreateCaseResult.safeParse(result);
  return {
    ...(typeof at === "string" && { at }),
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
 * A failure before the case leaves the draft whole and releases the claim, so a retry works. A
 * second call finds the recorded result, or no draft (`already_submitted`).
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

  let caseCreated = false;
  try {
    const current = await getDraft(draft.id, { db: raw, clock });
    if (!current) return { ok: false, reason: "already_submitted" };
    const consent = await latestConsent(current.id, { db: raw });
    const ticketPath = current.ticket ? submittedPath(current) : undefined;
    const mapped = draftToSubmission(current, consent && toConsentRef(consent), { ticketPath });
    if (!mapped.ok) {
      await release(raw, draft.id, clock);
      return mapped;
    }

    await copyTicket(raw, current.ticket!.path, mapped.submission.ticketPath);
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
    if (!caseCreated) await release(raw, draft.id, clock);
    throw error;
  }
}

/** `submitted/<draftId>.<ext>`: keyed by the draft id, so a retry lands on the same file. */
function submittedPath(draft: IntakeDraft): string {
  const ext = draft.ticket!.path.split(".").pop();
  return `${SUBMITTED_PREFIX}${draft.id}.${ext}`;
}

async function claimDraft(
  raw: ServiceClient,
  id: string,
  clock: Clock,
  sleep: (ms: number) => Promise<void>,
): Promise<Claim> {
  const db = intakeClient(raw);
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
        data: { ...(data.data as object), submit: { at: now.toISOString() } } as Json,
        updated_at: now.toISOString(),
      })
      .eq("id", id)
      .eq("updated_at", data.updated_at)
      .select("id");
    if (won.error) throw new Error(`draft claim failed: ${won.error.message}`);
    if ((won.data ?? []).length > 0) return { kind: "won" };
  }
  return { kind: "busy" };
}

/** Gives the claim back after a failure, best effort: a stale claim is taken over anyway. */
async function release(raw: ServiceClient, id: string, clock: Clock): Promise<void> {
  await mergeDraftData(id, { submit: null }, { db: raw, clock }).catch(() => undefined);
}

async function copyTicket(raw: ServiceClient, from: string, to: string): Promise<void> {
  const bucket = raw.storage.from(TICKET_BUCKET);
  if ((await bucket.exists(to)).data === true) return;
  const copied = await bucket.copy(from, to);
  if (copied.error) throw new Error(`ticket copy failed: ${copied.error.message}`);
}

/** Deletes the draft with its `drafts/` file. The case exists, so a failure here is only logged. */
async function cleanUp(raw: ServiceClient, id: string): Promise<void> {
  await deleteDraft(id, { db: raw }).catch(() =>
    console.error("[intake] draft clean-up after submit failed"),
  );
}
