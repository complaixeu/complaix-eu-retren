import { expect, test } from "@playwright/test";
import {
  OPERATOR_ADDRESS,
  advanceClock,
  caseRows,
  createTeamMember,
  expectStatus,
  historyOf,
  inject,
  messageItem,
  openCase,
  pendingOf,
  removeTeamMember,
  seedSentCase,
  signIn,
} from "./full-helpers";

// C10 path 2, the denial (docs/plans/C-claims.md C10; tracker #26 "Denials"): the operator
// denies → one insistence → it denies again → the case waits for d45 → escalation (and the
// filing owed, in the team queue) → closed at 3 months with the final result to the user.
// A case seeded through createCase + sendInitialClaim, then only the team view (/equipo):
// scripted replies through the real inbound path, and the demo clock scoped to this case.
// Fake mail and classifier, local Supabase, DEMO_MODE=1.

let member: string;
test.beforeAll(async () => {
  member = await createTeamMember();
});
test.afterAll(async () => {
  await removeTeamMember(member);
});

test("denied → one insistence → denied → escalation at d45 → closed", async ({ page }) => {
  test.setTimeout(120_000);
  const c = await seedSentCase();
  await signIn(page, member);
  await openCase(page, c);
  await expectStatus(page, "sent");
  await expect(messageItem(page, "initial_claim")).toContainText("sent");

  // 1. The first denial: the insistence is queued, the case goes back to `sent`.
  await inject(page, "Denegada (01)", "el caso ha cambiado de estado");
  await expect(messageItem(page, "denied")).toHaveCount(1);
  await expect(messageItem(page, "insistence_after_denial")).toContainText("queued");
  await expectStatus(page, "sent");

  // The next tick sends it.
  await advanceClock(page, 1);
  await expect(messageItem(page, "insistence_after_denial")).toContainText("sent");

  // 2. The second denial: no second insistence; the case stays denied, waiting for d45.
  await inject(page, "Denegada (02)", "el caso ha cambiado de estado");
  await expect(messageItem(page, "denied")).toHaveCount(2);
  await expectStatus(page, "denied");
  await expect(messageItem(page, "insistence_after_denial")).toHaveCount(1);

  // Nothing happens before day 45 (no reminders for a denied case).
  await advanceClock(page, 30);
  await expectStatus(page, "denied");
  await expect(messageItem(page, "escalation_d45")).toHaveCount(0);

  // 3. Day 45: the escalation goes out and the filing is owed (team queue).
  await advanceClock(page, 14);
  await expectStatus(page, "escalated");
  await expect(messageItem(page, "escalation_d45")).toContainText("sent");
  await expect(pendingOf(page)).toContainText("escalation_filing_required");

  // 4. Three months after the claim: closed, and the user gets the final result.
  await advanceClock(page, 50);
  await expectStatus(page, "closed");
  await expect(messageItem(page, "user_final_result")).toContainText("sent");
  await expect(historyOf(page)).toContainText("escalated → closed");

  // The outbox of this case, read back: every operator mail went to the operator's verified
  // address only, the final result to the user only, and nothing else was sent.
  const { case: row, messages } = await caseRows(c.id);
  expect(row.status).toBe("closed");
  const outbound = messages.filter((m) => m.direction === "outbound");
  expect(outbound.map((m) => [m.template, m.status, m.to_address])).toEqual([
    ["initial_claim", "sent", OPERATOR_ADDRESS],
    ["insistence_after_denial", "sent", OPERATOR_ADDRESS],
    ["escalation_d45", "sent", OPERATOR_ADDRESS],
    ["user_final_result", "sent", c.userEmail],
  ]);
  expect(row.send_count).toBe(3);
  expect(
    messages.filter((m) => m.direction === "inbound").map((m) => [m.category, m.from_address]),
  ).toEqual([
    ["denied", OPERATOR_ADDRESS],
    ["denied", OPERATOR_ADDRESS],
  ]);
});
