import { describe, expect, it } from "vitest";
import {
  ESCALATION_DAY,
  MAX_SENDS_PER_CASE,
  operatorRecipient,
  planReplyAction,
  RecipientRefusedError,
  type ReplyActionContext,
  type ReplyPlan,
} from "@/features/claims/actions";
import type { CaseStatus, OperatorPublicConfig, ReplyCategory } from "@/shared/contracts";

// The category → action table (docs/plans/C-claims.md C6, ARCHITECTURE §5–§7). Written out by
// hand so the test pins the table instead of re-deriving it from the implementation.
const NOW = new Date("2030-03-01T10:00:00.000Z");
const DAY = 86_400_000;
const sentDaysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

const ctx = (over: Partial<ReplyActionContext> = {}): ReplyActionContext => ({
  status: "reply_received",
  category: "acknowledgement",
  insistences: 0,
  sendCount: 1,
  sentAt: sentDaysAgo(10),
  escalationFired: false,
  operatorReachable: true,
  now: NOW,
  ...over,
});

type Row = [
  name: string,
  over: Partial<ReplyActionContext>,
  expected: Omit<ReplyPlan, "steps"> & { steps: [string, CaseStatus, CaseStatus][] },
];

const table: Row[] = [
  [
    "acknowledgement → wait, state kept",
    { category: "acknowledgement" },
    {
      action: "wait",
      status: "reply_received",
      steps: [["acknowledged", "reply_received", "reply_received"]],
    },
  ],
  [
    "acknowledgement while waiting on the user → wait, still waiting_user",
    { category: "acknowledgement", status: "waiting_user" },
    {
      action: "wait",
      status: "waiting_user",
      steps: [["acknowledged", "waiting_user", "waiting_user"]],
    },
  ],
  [
    "asks_for_data → waiting_user and a document request to the user",
    { category: "asks_for_data" },
    {
      action: "request_document",
      status: "waiting_user",
      steps: [["data_requested", "reply_received", "waiting_user"]],
      notice: "user_request_document",
    },
  ],
  [
    "approved → resolved and the final result (confirm receipt) to the user",
    { category: "approved" },
    {
      action: "resolve",
      status: "resolved",
      steps: [["approved", "reply_received", "resolved"]],
      notice: "user_final_result",
    },
  ],
  [
    "approved after the escalation → resolved",
    { category: "approved", status: "escalated" },
    {
      action: "resolve",
      status: "resolved",
      steps: [["approved", "escalated", "resolved"]],
      notice: "user_final_result",
    },
  ],
  [
    "first denial → one insistence to the operator, back to sent",
    { category: "denied" },
    {
      action: "insist",
      status: "sent",
      steps: [
        ["rejected", "reply_received", "denied"],
        ["insistence_sent", "denied", "sent"],
      ],
      operatorMail: "insistence_after_denial",
    },
  ],
  [
    "second denial before d45 → closed and the final result to the user",
    { category: "denied", insistences: 1, sendCount: 2 },
    {
      action: "close",
      status: "closed",
      steps: [
        ["rejected", "reply_received", "denied"],
        ["close", "denied", "closed"],
      ],
      notice: "user_final_result",
    },
  ],
  [
    "second denial with the d45 escalation due → left denied for the tick (C7)",
    { category: "denied", insistences: 1, sendCount: 2, sentAt: sentDaysAgo(ESCALATION_DAY) },
    {
      action: "await_escalation",
      status: "denied",
      steps: [["rejected", "reply_received", "denied"]],
    },
  ],
  [
    "refers_to_form → team queue",
    { category: "refers_to_form" },
    { action: "team_queue", status: "reply_received", steps: [], teamQueue: "refers_to_form" },
  ],
  [
    "other → team queue",
    { category: "other" },
    { action: "team_queue", status: "reply_received", steps: [], teamQueue: "other" },
  ],
  [
    // The last slot (MAX_SENDS_PER_CASE) is reserved for the d45 escalation (C7).
    "first denial at send_count = MAX - 1 (5) → team queue, no insistence",
    { category: "denied", sendCount: MAX_SENDS_PER_CASE - 1 },
    { action: "team_queue", status: "reply_received", steps: [], teamQueue: "send_cap" },
  ],
  [
    "first denial at send_count = MAX - 2 (4) → the insistence still fits",
    { category: "denied", sendCount: MAX_SENDS_PER_CASE - 2 },
    {
      action: "insist",
      status: "sent",
      steps: [
        ["rejected", "reply_received", "denied"],
        ["insistence_sent", "denied", "sent"],
      ],
      operatorMail: "insistence_after_denial",
    },
  ],
  [
    "first denial for an operator without a verified email → team queue",
    { category: "denied", operatorReachable: false },
    {
      action: "team_queue",
      status: "reply_received",
      steps: [],
      teamQueue: "operator_not_emailable",
    },
  ],
];

describe("planReplyAction: the category → action table", () => {
  it.each(table)("%s", (_name, over, expected) => {
    const plan = planReplyAction(ctx(over));
    expect(plan).toEqual({
      ...expected,
      steps: expected.steps.map(([event, from, to]) => ({ event, from, to })),
    });
  });

  it("covers every category", () => {
    const categories = new Set(table.map(([, over]) => over.category));
    const all: ReplyCategory[] = [
      "acknowledgement",
      "asks_for_data",
      "approved",
      "denied",
      "refers_to_form",
      "other",
    ];
    for (const c of all) expect(categories).toContain(c);
  });
});

describe("planReplyAction: replies transition() refuses go to the team queue, never throw", () => {
  const refused: [CaseStatus, ReplyCategory][] = [
    ["closed", "approved"],
    ["closed", "denied"],
    ["closed", "acknowledgement"],
    ["resolved", "approved"],
    ["resolved", "asks_for_data"],
    ["draft", "approved"],
    ["waiting_period", "denied"],
    // denied before the insistence (a second reply racing the first).
    ["denied", "denied"],
    ["denied", "acknowledgement"],
    // Already escalated: a denial or a data request goes to the team.
    ["escalated", "denied"],
    ["escalated", "asks_for_data"],
    // A reply C4 hasn't marked with operator_replied yet.
    ["sent", "approved"],
  ];
  it.each(refused)("%s + %s → team queue (invalid_transition)", (status, category) => {
    expect(planReplyAction(ctx({ status, category }))).toEqual({
      action: "team_queue",
      status,
      steps: [],
      teamQueue: "invalid_transition",
    });
  });

  it("refers_to_form and other stay in the team queue whatever the state", () => {
    for (const status of ["closed", "resolved", "sent"] as const) {
      expect(planReplyAction(ctx({ status, category: "other" })).teamQueue).toBe("other");
      expect(planReplyAction(ctx({ status, category: "refers_to_form" })).teamQueue).toBe(
        "refers_to_form",
      );
    }
  });
});

describe("planReplyAction: only one insistence ever", () => {
  it("never plans an insistence once one was recorded", () => {
    for (const insistences of [1, 2, 5]) {
      for (const sentAt of [sentDaysAgo(5), sentDaysAgo(50), null]) {
        const plan = planReplyAction(ctx({ category: "denied", insistences, sentAt }));
        expect(plan.operatorMail).toBeUndefined();
        expect(plan.steps.map((s) => s.event)).not.toContain("insistence_sent");
      }
    }
  });

  it("the escalation is not due once it fired, or at the send cap: the case closes", () => {
    const late = { category: "denied" as const, insistences: 1, sentAt: sentDaysAgo(60) };
    expect(planReplyAction(ctx({ ...late, escalationFired: true })).action).toBe("close");
    expect(planReplyAction(ctx({ ...late, sendCount: MAX_SENDS_PER_CASE })).action).toBe("close");
    expect(planReplyAction(ctx({ ...late, sentAt: sentDaysAgo(ESCALATION_DAY - 1) })).action).toBe(
      "close",
    );
  });
});

describe("operatorRecipient: the operator's verified address only", () => {
  const email: OperatorPublicConfig = {
    id: "iryo",
    displayName: "Iryo",
    active: true,
    channel: { type: "email", address: "claims@operator.example" },
    responseDays: 30,
    version: "test",
  };

  it("returns the configured address", () => {
    expect(operatorRecipient(email)).toBe("claims@operator.example");
    expect(operatorRecipient(email, "claims@operator.example")).toBe("claims@operator.example");
  });

  it("refuses any other recipient", () => {
    expect(() => operatorRecipient(email, "x@evil.com")).toThrow(RecipientRefusedError);
    expect(() => operatorRecipient(email, "CLAIMS@operator.example.evil.com")).toThrow(
      RecipientRefusedError,
    );
  });

  it("refuses an operator without an email channel, or an inactive one", () => {
    const web: OperatorPublicConfig = {
      ...email,
      channel: { type: "web_form", url: "https://operator.example/" },
    };
    expect(() => operatorRecipient(web)).toThrow(RecipientRefusedError);
    expect(() => operatorRecipient({ ...email, active: false })).toThrow(RecipientRefusedError);
  });
});
