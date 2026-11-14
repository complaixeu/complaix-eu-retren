// The case state machine (docs/plans/C-claims.md C1, ARCHITECTURE §5–§6). Pure: no DB, no clock.
// Internal to domain C: other domains see only CaseStatus, never these events.
import { z } from "zod";
import { CaseStatus } from "@/shared/contracts";

/** What can happen to a case. Each event moves it along one row of ALLOWED_TRANSITIONS. */
export const CaseTransitionEvent = z.enum([
  "eligible", // createCase: eligible or doubtful → wait for the earliest send date
  "not_eligible", // createCase: not eligible → closed, the user is told
  "claim_sent", // the initial claim went out (C3)
  "reminder_sent", // a timer reminder went out (C7); the case stays sent
  "operator_replied", // an operator reply arrived and matched the case (C4); stops the schedule
  "acknowledged", // the reply only acknowledges receipt: the state is kept (C6)
  "data_requested", // the operator asks for something only the user has (C6)
  "user_document_forwarded", // the user's document went to the operator (C6)
  "approved", // C6
  "rejected", // the operator denied the claim (C6)
  "insistence_sent", // the one insistence after a denial (C6)
  "escalate", // d45 escalation, or after a denial (C6, C7)
  "close", // 3 months, a final denial, the team, or after a resolution
]);
export type CaseTransitionEvent = z.infer<typeof CaseTransitionEvent>;

type Table = {
  readonly [S in CaseStatus]: Readonly<Partial<Record<CaseTransitionEvent, CaseStatus>>>;
};

/** The explicit table of allowed moves. Anything not listed here throws. */
export const ALLOWED_TRANSITIONS: Table = Object.freeze({
  draft: { eligible: "waiting_period", not_eligible: "closed", close: "closed" },
  waiting_period: { claim_sent: "sent", close: "closed" },
  sent: {
    reminder_sent: "sent",
    operator_replied: "reply_received",
    escalate: "escalated",
    close: "closed",
  },
  reply_received: {
    operator_replied: "reply_received",
    acknowledged: "reply_received",
    data_requested: "waiting_user",
    approved: "resolved",
    rejected: "denied",
    close: "closed",
  },
  // A reply keeps a pending state: the document request is still open, and the category applies
  // to this state, not to reply_received.
  waiting_user: {
    operator_replied: "waiting_user",
    acknowledged: "waiting_user",
    data_requested: "waiting_user",
    approved: "resolved",
    rejected: "denied",
    user_document_forwarded: "sent",
    close: "closed",
  },
  // Already escalated: a reply keeps it escalated. A denial or a data request here goes to the
  // team queue (throws), so there is never a second insistence or escalation.
  escalated: {
    operator_replied: "escalated",
    acknowledged: "escalated",
    approved: "resolved",
    close: "closed",
  },
  resolved: { close: "closed" },
  denied: { insistence_sent: "sent", escalate: "escalated", close: "closed" },
  closed: {},
});

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly event: string,
  ) {
    super(`Invalid case transition: ${from} --${event}-->`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * Returns the status a case moves to on `event`, or throws InvalidTransitionError.
 *
 * An operator reply is two steps, both applied to the case's real current state: C4 applies
 * `operator_replied` (sent → reply_received; waiting_user and escalated keep their state), then
 * C6 applies the reply's category event to the resulting state.
 *
 * Replies to terminal or unsent states throw by design: `draft`, `waiting_period`, `denied`
 * before the insistence, `resolved` and `closed`. C4/C6 must then record the message and route
 * it to the team queue without a transition.
 */
export function transition(status: CaseStatus, event: CaseTransitionEvent): CaseStatus {
  if (!CaseStatus.safeParse(status).success || !CaseTransitionEvent.safeParse(event).success) {
    throw new InvalidTransitionError(String(status), String(event));
  }
  const moves = ALLOWED_TRANSITIONS[status];
  const next = Object.hasOwn(moves, event) ? moves[event] : undefined;
  if (next === undefined) throw new InvalidTransitionError(status, event);
  return next;
}
