import { describe, expect, it } from "vitest";
import { CaseStatus } from "@/shared/contracts";
import {
  ALLOWED_TRANSITIONS,
  CaseTransitionEvent,
  InvalidTransitionError,
  transition,
} from "@/features/claims/state-machine";

type Move = [from: CaseStatus, event: CaseTransitionEvent, to: CaseStatus];

// The explicit table of allowed moves (ARCHITECTURE §5, §6; plan C1). Written out by hand so the
// test pins the table instead of re-deriving it from the implementation.
const allowed: Move[] = [
  ["draft", "eligible", "waiting_period"],
  ["draft", "not_eligible", "closed"],
  ["waiting_period", "claim_sent", "sent"],
  ["sent", "reminder_sent", "sent"],
  ["sent", "operator_replied", "reply_received"],
  ["sent", "escalate", "escalated"],
  // A reply stops the schedule (ARCHITECTURE §6): an acknowledgement stays in reply_received.
  ["reply_received", "operator_replied", "reply_received"],
  ["reply_received", "acknowledged", "reply_received"],
  ["reply_received", "data_requested", "waiting_user"],
  ["reply_received", "approved", "resolved"],
  ["reply_received", "rejected", "denied"],
  // A reply never drops a pending state: waiting_user and escalated keep what they mean, and the
  // category event (C6) applies to the case's real current state.
  ["waiting_user", "operator_replied", "waiting_user"],
  ["waiting_user", "acknowledged", "waiting_user"],
  ["waiting_user", "data_requested", "waiting_user"],
  ["waiting_user", "approved", "resolved"],
  ["waiting_user", "rejected", "denied"],
  ["waiting_user", "user_document_forwarded", "sent"],
  ["denied", "insistence_sent", "sent"],
  ["denied", "escalate", "escalated"],
  ["escalated", "operator_replied", "escalated"],
  ["escalated", "acknowledged", "escalated"],
  ["escalated", "approved", "resolved"],
  ["draft", "close", "closed"],
  ["waiting_period", "close", "closed"],
  ["sent", "close", "closed"],
  ["reply_received", "close", "closed"],
  ["waiting_user", "close", "closed"],
  ["escalated", "close", "closed"],
  ["resolved", "close", "closed"],
  ["denied", "close", "closed"],
];

const forbidden: [CaseStatus, CaseTransitionEvent][] = [
  ["draft", "claim_sent"], // never send before eligibility and the waiting period
  ["waiting_period", "operator_replied"], // nothing was sent yet
  ["sent", "approved"], // a reply is classified only once it has been received
  ["sent", "eligible"],
  ["waiting_user", "claim_sent"],
  ["denied", "approved"],
  ["resolved", "operator_replied"],
  ["resolved", "escalate"],
  ["escalated", "insistence_sent"],
  ["escalated", "rejected"], // already escalated: never a second insistence or escalation; team queue
  ["escalated", "data_requested"], // team queue
  ["escalated", "escalate"],
  ["sent", "acknowledged"], // a category applies only after operator_replied recorded the reply
  ["sent", "rejected"],
  ["denied", "operator_replied"], // a reply before the insistence: team queue
  ["draft", "operator_replied"],
  ["closed", "close"], // closed is terminal
  ["closed", "operator_replied"],
  ["closed", "eligible"],
];

describe("claims state machine: transition(status, event)", () => {
  it.each(allowed)("%s --%s--> %s", (from, event, to) => {
    expect(transition(from, event)).toBe(to);
  });

  it.each(forbidden)("%s --%s--> throws", (from, event) => {
    expect(() => transition(from, event)).toThrow(InvalidTransitionError);
  });

  // A reply (C4: operator_replied) then its category (C6), applied in order to the real state.
  const run = (from: CaseStatus, events: CaseTransitionEvent[]) =>
    events.reduce<CaseStatus>((status, event) => transition(status, event), from);

  it.each<[CaseStatus, CaseTransitionEvent[], CaseStatus]>([
    ["sent", ["operator_replied", "acknowledged"], "reply_received"],
    ["waiting_user", ["operator_replied", "acknowledged"], "waiting_user"],
    [
      "waiting_user",
      ["operator_replied", "acknowledged", "user_document_forwarded"],
      "sent", // the pending document request survived the acknowledgement
    ],
    ["escalated", ["operator_replied", "acknowledged"], "escalated"],
    ["escalated", ["operator_replied", "approved"], "resolved"],
    ["sent", ["operator_replied", "rejected", "insistence_sent"], "sent"],
  ])("sequence from %s: %j → %s", (from, events, to) => {
    expect(run(from, events)).toBe(to);
  });

  it("an acknowledgement never resumes the schedule (no move back to sent)", () => {
    for (const from of CaseStatus.options) {
      expect(ALLOWED_TRANSITIONS[from].acknowledged, from).not.toBe("sent");
    }
  });

  it("the exported table is exactly the allowed list", () => {
    const table = Object.entries(ALLOWED_TRANSITIONS).flatMap(([from, moves]) =>
      Object.entries(moves ?? {}).map(([event, to]) => [from, event, to]),
    );
    expect(table.map((m) => m.join(" ")).sort()).toEqual(allowed.map((m) => m.join(" ")).sort());
  });

  it("every status/event pair not in the table throws", () => {
    const ok = new Set(allowed.map(([from, event]) => `${from} ${event}`));
    for (const from of CaseStatus.options) {
      for (const event of CaseTransitionEvent.options) {
        if (ok.has(`${from} ${event}`)) continue;
        expect(() => transition(from, event), `${from} ${event}`).toThrow(InvalidTransitionError);
      }
    }
  });

  it("every status reached by the table is a valid CaseStatus", () => {
    for (const [, , to] of allowed) expect(CaseStatus.options).toContain(to);
  });

  it("closed has no way out", () => {
    expect(ALLOWED_TRANSITIONS.closed ?? {}).toEqual({});
  });

  it("rejects values outside the enums", () => {
    expect(() => transition("bogus" as CaseStatus, "close")).toThrow(InvalidTransitionError);
    expect(() => transition("sent", "bogus" as CaseTransitionEvent)).toThrow(
      InvalidTransitionError,
    );
    // Prototype keys must not count as moves.
    expect(() => transition("sent", "toString" as CaseTransitionEvent)).toThrow(
      InvalidTransitionError,
    );
  });

  it("the error says which move was refused", () => {
    expect(() => transition("closed", "operator_replied")).toThrow(/closed.*operator_replied/);
  });
});
