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
  removeTeamMember,
  seedSentCase,
  signIn,
  userDocumentExists,
  userRepliesWithDocument,
} from "./full-helpers";

// C10 path 3, the data request (docs/plans/C-claims.md C10; ARCHITECTURE §7.1; tracker #26
// "User documents"): the operator asks for the IBAN → our document request goes to the user →
// the user replies with a document (the real inbound path) → it is forwarded to the operator's
// verified address only → once that mail is sent, the document is deleted.
// Fake mail and classifier, local Supabase, DEMO_MODE=1.

let member: string;
test.beforeAll(async () => {
  member = await createTeamMember();
});
test.afterAll(async () => {
  await removeTeamMember(member);
});

test("asks for the IBAN → the user's document is forwarded to the operator only, then deleted", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const c = await seedSentCase();
  await signIn(page, member);
  await openCase(page, c);

  // 1. The operator asks for data: the case waits on the user, our request is queued for them.
  await inject(page, "Pide datos (IBAN) (01)", "el caso ha cambiado de estado");
  await expectStatus(page, "waiting_user");
  await expect(messageItem(page, "asks_for_data")).toHaveCount(1);
  await expect(messageItem(page, "user_request_document")).toContainText("queued");

  // The next tick sends the request to the user.
  await advanceClock(page, 1);
  await expect(messageItem(page, "user_request_document")).toContainText("sent");

  // 2. The user answers it with one PDF, through the same path as a mail read from the inbox.
  const ingested = await userRepliesWithDocument(c.id);
  expect(ingested).toMatchObject({ outcome: "forwarded", caseId: c.id });

  // Stored and queued for the operator, not sent yet: the file is still there.
  const before = await caseRows(c.id);
  const docs = before.attachments.filter((a) => a.kind === "user_document");
  expect(docs).toHaveLength(1);
  const [doc] = docs;
  expect(doc.message_id).not.toBeNull();
  expect(doc.deleted_at).toBeNull();
  expect(await userDocumentExists(doc.storage_path)).toBe(true);
  const forward = before.messages.find((m) => m.id === doc.message_id)!;
  expect(forward).toMatchObject({
    direction: "outbound",
    status: "queued",
    to_address: OPERATOR_ADDRESS,
  });

  await page.reload();
  await expectStatus(page, "sent");
  await expect(historyOf(page)).toContainText("user_document_forwarded");

  // 3. The next tick sends the forward to the operator, and only then deletes the document.
  await advanceClock(page, 1);
  await expect(messageItem(page, "reply_asks_for_data")).toContainText("sent");
  await expect(historyOf(page)).toContainText("user_document_deleted");

  const after = await caseRows(c.id);
  const sentForward = after.messages.find((m) => m.id === doc.message_id)!;
  expect(sentForward).toMatchObject({
    status: "sent",
    template: "reply_asks_for_data",
    to_address: OPERATOR_ADDRESS,
  });
  expect(sentForward.delivered_to).toEqual([OPERATOR_ADDRESS]);
  const gone = after.attachments.find((a) => a.id === doc.id)!;
  expect(gone.deleted_at).not.toBeNull();
  expect(await userDocumentExists(doc.storage_path)).toBe(false);

  // The document went to the operator only: the one mail that carried it is the forward, and
  // the user got nothing but our request.
  expect(after.attachments.filter((a) => a.kind === "user_document")).toHaveLength(1);
  const outbound = after.messages.filter((m) => m.direction === "outbound");
  expect(outbound.map((m) => [m.template, m.status, m.to_address])).toEqual([
    ["initial_claim", "sent", OPERATOR_ADDRESS],
    ["user_request_document", "sent", c.userEmail],
    ["reply_asks_for_data", "sent", OPERATOR_ADDRESS],
  ]);
});
