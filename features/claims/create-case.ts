// createCase (docs/plans/C-claims.md C2): A hands over a submission, C evaluates it with B's
// rules and stores the case, its `created` event and, for a not-eligible case, the queued
// user_final_result notice, all in one transaction (claims_create_case, migration
// *_claims_create_case_fn.sql). Nothing is sent here: the outbox row stays `queued`.
import { renderTemplate } from "@/features/documents";
import { evaluateEligibility } from "@/features/rules";
import { systemClock } from "@/shared/clock";
import {
  CreateCaseResult,
  IntakeSubmission,
  type CaseStatus,
  type Clock,
  type EligibilityInput,
  type EligibilityResult,
  type TemplateKind,
} from "@/shared/contracts";
import type { Json } from "@/shared/supabase";
import { createServiceClient, type ServiceClient } from "@/shared/supabase/server";
import { transition, type CaseTransitionEvent } from "./state-machine";

/** Sender of the notices to the user until the real mailbox exists (C3, C8). Never delivered. */
export const DEFAULT_NOTICE_FROM = "avisos@retren.invalid";

export interface CreateCaseDeps {
  /** Service-role client; created from env when left out. */
  db?: ServiceClient;
  clock?: Clock;
  /** B's rules; injectable so tests can drive every branch (e.g. doubtful). */
  evaluateEligibility?: (input: EligibilityInput) => EligibilityResult;
  /** From address of the user notice; defaults to MAIL_FROM, then DEFAULT_NOTICE_FROM. */
  noticeFrom?: string;
}

const MADRID = "Europe/Madrid";
const offsetFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: MADRID,
  timeZoneName: "longOffset",
});

/** "GMT+01:00" → "+01:00" at the given instant. */
function madridOffset(at: number): string {
  const name = offsetFormat.formatToParts(at).find((p) => p.type === "timeZoneName")?.value;
  const match = name?.match(/[+-]\d{2}:\d{2}/);
  return match ? match[0] : "+00:00";
}

const toMs = (offset: string) =>
  (offset[0] === "-" ? -1 : 1) *
  (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))) *
  60_000;

/** A Madrid wall-clock date and time (tickets and the user's answers) as an ISO instant. */
export function madridInstant(date: string, time: string): string {
  const hhmm = time.slice(0, 5);
  const wall = Date.parse(`${date}T${hhmm}:00Z`);
  // The offset at the wall time read as UTC, corrected once at the real instant (DST edges).
  let offset = madridOffset(wall);
  offset = madridOffset(wall - toMs(offset));
  return `${date}T${hhmm}:00${offset}`;
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The submission as the rules' input (ARCHITECTURE §3). */
export function toEligibilityInput(submission: IntakeSubmission, now: Date): EligibilityInput {
  const { ticket, answers } = submission;
  // A scheduled arrival earlier than the departure is on the next day (overnight train).
  const arrivalDate =
    ticket.scheduledArrival < ticket.scheduledDeparture
      ? nextDay(ticket.travelDate)
      : ticket.travelDate;
  return {
    operator: ticket.operator,
    scheduledDeparture: madridInstant(ticket.travelDate, ticket.scheduledDeparture),
    scheduledArrival: madridInstant(arrivalDate, ticket.scheduledArrival),
    actualArrival: madridInstant(answers.actualArrival.date, answers.actualArrival.time),
    ...(ticket.purchaseDate !== undefined && { purchaseDate: ticket.purchaseDate }),
    ...(ticket.purchaseChannel !== undefined && { purchaseChannel: ticket.purchaseChannel }),
    now: now.toISOString(),
  };
}

export interface CasePlan {
  event: CaseTransitionEvent;
  status: CaseStatus;
  earliestSendAt: string | null;
  /** When the tick (C7) next looks at the case; null for a closed case. */
  nextActionAt: string | null;
  notice?: { template: TemplateKind; to: string };
}

/**
 * What a new case becomes. Eligible and doubtful both wait for the earliest send date (a doubtful
 * claim is still sent); without one there is no minimum wait, so the next action is now. Not
 * eligible closes the case and tells the user (ARCHITECTURE §7, final result).
 */
export function planCase(
  submission: IntakeSubmission,
  eligibility: EligibilityResult,
  now: Date,
): CasePlan {
  const event: CaseTransitionEvent =
    eligibility.status === "not_eligible" ? "not_eligible" : "eligible";
  const status = transition("draft", event);
  if (event === "not_eligible") {
    return {
      event,
      status,
      earliestSendAt: null,
      nextActionAt: null,
      notice: { template: "user_final_result", to: submission.answers.email },
    };
  }
  const earliestSendAt = eligibility.earliestSendAt ?? null;
  return { event, status, earliestSendAt, nextActionAt: earliestSendAt ?? now.toISOString() };
}

type DbError = { code?: string; message: string };

class CreateCaseDbError extends Error {
  constructor(
    readonly step: string,
    readonly code: string | undefined,
    message: string,
  ) {
    super(`createCase: ${step} failed: ${message}`);
    this.name = "CreateCaseDbError";
  }
}

const UNIQUE_VIOLATION = "23505";

/** Creates the case for an intake submission. Throws a ZodError on an invalid submission. */
export async function createCase(
  input: IntakeSubmission,
  deps: CreateCaseDeps = {},
): Promise<CreateCaseResult> {
  const submission = IntakeSubmission.parse(input);
  const now = (deps.clock ?? systemClock).now();
  const evaluate = deps.evaluateEligibility ?? evaluateEligibility;
  const eligibility = evaluate(toEligibilityInput(submission, now));
  const plan = planCase(submission, eligibility, now);
  const db = deps.db ?? createServiceClient();
  const from = deps.noticeFrom ?? process.env.MAIL_FROM ?? DEFAULT_NOTICE_FROM;

  // The data of the `created` event: no email, name, document or booking reference.
  const eventData = {
    event: plan.event,
    eligibility: eligibility.status,
    delayMinutes: eligibility.delayMinutes,
    appliedRules: eligibility.appliedRules,
    configVersion: eligibility.configVersion,
  };

  // A reference collision is astronomically rare but possible: ask for a new one once.
  for (let attempt = 1; ; attempt++) {
    const ref = await db.rpc("claims_new_public_ref");
    if (ref.error) throw dbError("claims_new_public_ref", ref.error);
    const publicRef = ref.data;

    const created = await db.rpc("claims_create_case", {
      p_public_ref: publicRef,
      p_operator: submission.ticket.operator,
      p_status: plan.status,
      p_submission: submission as unknown as Json,
      p_eligibility: eligibility as unknown as Json,
      p_user_email: submission.answers.email,
      // Nullable in SQL; the generated Args type marks every function parameter as non-null.
      p_earliest_send_at: plan.earliestSendAt as string,
      p_next_action_at: plan.nextActionAt as string,
      p_event_data: eventData,
      p_notice: (plan.notice
        ? notice(plan.notice, from, publicRef, submission, eligibility)
        : null) as Json,
    });
    if (created.error) {
      if (created.error.code === UNIQUE_VIOLATION && attempt < 2) continue;
      throw dbError("claims_create_case", created.error);
    }
    return CreateCaseResult.parse({
      caseId: created.data,
      publicRef,
      status: plan.status,
      eligibility,
    });
  }
}

function dbError(step: string, error: DbError) {
  return new CreateCaseDbError(step, error.code, error.message);
}

function notice(
  n: NonNullable<CasePlan["notice"]>,
  from: string,
  ref: string,
  submission: IntakeSubmission,
  eligibility: EligibilityResult,
) {
  // TODO(B6): the real user_final_result text comes from renderTemplate once B6 lands; the
  // variables below are what this notice needs (result and reason).
  const rendered = renderTemplate(n.template, submission.ticket.operator, {
    ref,
    passengerName: `${submission.ticket.firstName} ${submission.ticket.lastName}`,
    result: "not_eligible",
    reason: eligibility.reason,
  });
  return {
    template: n.template,
    from,
    to: n.to,
    subject: rendered.subject,
    body_text: rendered.text,
  };
}
