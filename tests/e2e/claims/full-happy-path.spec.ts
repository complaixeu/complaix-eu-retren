import { expect, test } from "@playwright/test";
import {
  casesOfDraft,
  currentDraftId,
  uploadPlaceholderTicket,
  completeReview,
} from "../intake/support/draft";
import {
  OPERATOR_ADDRESS,
  advanceClock,
  caseRows,
  createTeamMember,
  db,
  expectStatus,
  inject,
  messageItem,
  openCase,
  removeTeamMember,
  signIn,
} from "./full-helpers";

const DAY = 86_400_000;

function madridDate(daysAgo: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(
    new Date(Date.now() - daysAgo * DAY),
  );
}

let member: string;
test.beforeAll(async () => {
  member = await createTeamMember();
});
test.afterAll(async () => {
  await removeTeamMember(member);
});

test("upload → eligible claim sent to Iryo → approved → user gets the final result", async ({
  page,
}) => {
  test.setTimeout(120_000);

  // The neutral placeholder is read by the fake OCR/extractor. Values are invented test data.
  const travelDate = madridDate(1);
  await uploadPlaceholderTicket(page, "image");
  const draftId = await currentDraftId(page.context());
  await page.getByRole("link", { name: "Continuar" }).click();
  await expect(page).toHaveURL(/\/reclamar\/revision$/);
  await completeReview(page, { travelDate, scheduledArrival: "10:30" });
  await expect(page).toHaveURL(/\/reclamar\/preguntas$/);

  await page.getByLabel("Número de documento", { exact: true }).fill("00000000T");
  await page.getByLabel("Email", { exact: true }).fill("persona@example.test");
  await page.getByLabel("Fecha de llegada", { exact: true }).fill(travelDate);
  await page.getByLabel("Hora de llegada", { exact: true }).fill("12:30");
  await page.getByRole("radio", { name: "Dinero" }).check();
  await page.getByRole("radio", { name: "No", exact: true }).check();
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page).toHaveURL(/\/reclamar\/mandato$/);

  await page.getByRole("checkbox", { name: /^Autorizo a ReTren/ }).check();
  await page.getByRole("checkbox", { name: /aviso de privacidad/ }).check();
  await page.getByRole("button", { name: "Aceptar y enviar" }).click();
  await expect(page).toHaveURL(/\/reclamar\/enviado$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Resultado de tu reclamación" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Tu viaje da derecho a reclamar" }),
  ).toBeVisible();

  // Resolve the case through the draft id created by this browser submission.
  const created = await casesOfDraft(draftId);
  expect(created).toHaveLength(1);
  const caseId = created[0].id as string;
  const { data: stored, error } = await db()
    .from("cases")
    .select("id, public_ref, status, operator, earliest_send_at, user_email")
    .eq("id", caseId)
    .single();
  if (error) throw error;
  expect(stored).toMatchObject({
    id: caseId,
    status: "waiting_period",
    operator: "iryo",
    user_email: "persona@example.test",
  });
  if (!stored.public_ref || !stored.earliest_send_at) {
    throw new Error("the eligible case is missing its reference or earliest send date");
  }

  await signIn(page, member);
  const c = { id: caseId, ref: stored.public_ref };
  await openCase(page, c);
  await expectStatus(page, "waiting_period");

  // The eligible trip arrived yesterday, so Iryo's 48-hour minimum wait is still ahead.
  // Round up the time left before the earliest send, plus one day of margin, so the move
  // always lands past it whatever the time of day or the UTC/Madrid date boundary.
  const daysPastEarliest = Math.ceil((Date.parse(stored.earliest_send_at) - Date.now()) / DAY) + 1;
  await advanceClock(page, Math.max(1, daysPastEarliest));
  await expectStatus(page, "sent");
  await expect(messageItem(page, "initial_claim")).toContainText("Sent");
  await expect(page.getByRole("region", { name: "Claim process" })).toContainText("Claim sent");
  await expect(messageItem(page, "initial_claim")).toContainText("Initial claim");
  await expect(messageItem(page, "initial_claim")).toContainText("EU claim form.pdf");
  await expect(messageItem(page, "initial_claim")).toContainText("Mandate.pdf");
  await expect(messageItem(page, "initial_claim")).toContainText("Ticket");
  await expect(messageItem(page, "initial_claim").locator("ul").getByRole("listitem")).toHaveCount(
    3,
  );

  const sentRows = await caseRows(caseId);
  const initial = sentRows.messages.filter((message) => message.direction === "outbound");
  expect(initial).toHaveLength(1);
  expect(initial[0]).toMatchObject({
    template: "initial_claim",
    status: "sent",
    to_address: OPERATOR_ADDRESS,
    delivered_to: [OPERATOR_ADDRESS],
  });
  expect(initial[0].to_address).toBe(OPERATOR_ADDRESS);
  const claimAttachments = sentRows.attachments.filter(
    (attachment) => attachment.message_id === initial[0].id,
  );
  expect(claimAttachments.map((attachment) => attachment.kind).sort()).toEqual([
    "eu_form",
    "mandate",
    "ticket",
  ]);

  await inject(page, "Approved (01)", "status updated");
  await expectStatus(page, "resolved");
  await expect(page.getByText("AI classification: Approved")).toBeVisible();
  await expect(page.getByText("Case resolved and passenger notified")).toBeVisible();
  await expect(page.getByRole("region", { name: "Claim process" })).toContainText("Resolved");
  await expect(messageItem(page, "user_final_result")).toContainText("Queued");
  await advanceClock(page, 1);
  await expectStatus(page, "resolved");
  await expect(messageItem(page, "user_final_result")).toContainText("Sent");

  const finalRows = await caseRows(caseId);
  expect(finalRows.case.status).toBe("resolved");
  expect(
    finalRows.messages
      .filter((message) => message.direction === "outbound")
      .map((message) => [message.template, message.status, message.to_address]),
  ).toEqual([
    ["initial_claim", "sent", OPERATOR_ADDRESS],
    ["user_final_result", "sent", "persona@example.test"],
  ]);
  const finalNotice = finalRows.messages.find(
    (message) => message.template === "user_final_result",
  );
  expect(finalNotice?.delivered_to).toEqual(["persona@example.test"]);
});
