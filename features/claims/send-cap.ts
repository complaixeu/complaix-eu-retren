// The send cap (ARCHITECTURE §6, docs/plans/C-claims.md C3 and C7). Internal to domain C.

/**
 * Most mails Retren sends to an operator for one case, so it is never treated as spam: the
 * initial claim, three reminders, the escalation and one insistence after a denial.
 * `cases.send_count` is incremented when a mail is **queued** (C7's rule): the initial claim in
 * claims_send_initial_claim, timer mail in the tick. The transport never re-checks it.
 */
export const MAX_SENDS_PER_CASE = 6;
