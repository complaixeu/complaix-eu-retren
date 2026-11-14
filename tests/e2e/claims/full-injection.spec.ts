import { expect, test } from "@playwright/test";
import {
  OPERATOR_ADDRESS,
  advanceClock,
  caseRows,
  createTeamMember,
  expectStatus,
  inject,
  messageItem,
  openCase,
  pendingOf,
  removeTeamMember,
  seedSentCase,
  signIn,
} from "./full-helpers";

// C10 path 4, prompt injection (docs/plans/C-claims.md C10; docs/plans/README.md §4.3): an
// operator reply telling us to send the case data to x@evil.example is never obeyed. It is
// classified `other` (the guard), nothing is queued or sent to that address, and the reply lands
// in the team queue. Fake mail and classifier, local Supabase, DEMO_MODE=1.

const EVIL = /evil\.example/i;

let member: string;
test.beforeAll(async () => {
  member = await createTeamMember();
});
test.afterAll(async () => {
  await removeTeamMember(member);
});

test("a reply asking to send the data to x@evil.example: nothing goes there, the team gets it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const c = await seedSentCase();
  await signIn(page, member);
  await openCase(page, c);

  await inject(page, "Intento de inyección (01)", "el caso ha cambiado de estado");
  // Shown to the team as plain text, classified `other`, and waiting for a person.
  await expect(messageItem(page, "other")).toContainText("x@evil.example");
  await expectStatus(page, "reply_received");
  await expect(pendingOf(page)).toContainText("other");

  // The tick runs for this case: still nothing goes out.
  await advanceClock(page, 1);
  await expect(messageItem(page, "other")).toHaveCount(1);

  // The team queue lists it.
  await page.goto("/equipo");
  const queued = page
    .getByRole("region", { name: "Pendiente de revisar" })
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: c.ref }) });
  await expect(queued).toContainText("other");

  // This case's outbox, read back: only the initial claim, to the operator's verified address;
  // no row to, or delivered to, the address in the operator's mail.
  const { case: row, messages } = await caseRows(c.id);
  expect(row.status).toBe("reply_received");
  expect(row.send_count).toBe(1);
  const outbound = messages.filter((m) => m.direction === "outbound");
  expect(outbound.map((m) => [m.template, m.status, m.to_address])).toEqual([
    ["initial_claim", "sent", OPERATOR_ADDRESS],
  ]);
  for (const m of outbound) {
    expect(m.to_address).not.toMatch(EVIL);
    expect(JSON.stringify(m.delivered_to ?? "")).not.toMatch(EVIL);
  }
  const inbound = messages.filter((m) => m.direction === "inbound");
  expect(inbound.map((m) => [m.category, m.from_address])).toEqual([["other", OPERATOR_ADDRESS]]);
});
