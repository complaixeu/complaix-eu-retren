import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { REVIEW } from "../../fixtures/intake/review";
import { DELAYS, tripData } from "../../fixtures/intake/submit";
import { startDraftWith, startSubmittableDraft, uploadPlaceholderTicket } from "./support/draft";

async function check(page: Page) {
  await expect(page).toHaveTitle(/\S/);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test("photo, review, questions and mandate steps have no serious accessibility violations", async ({
  page,
  context,
  baseURL,
}) => {
  await uploadPlaceholderTicket(page);
  await check(page);

  await page.goto("/reclamar/revision");
  await check(page);
  await page.getByRole("textbox", { name: "Localizador" }).fill("ABC123");
  await page.getByRole("checkbox", { name: "He comprobado el localizador" }).check();
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page).toHaveURL(/\/reclamar\/preguntas$/);
  await check(page);

  await startDraftWith(context, baseURL!, { review: REVIEW });
  await page.goto("/reclamar/mandato");
  await check(page);
});

test("result step has no serious accessibility violations", async ({ page, context, baseURL }) => {
  await startSubmittableDraft(context, baseURL!, tripData(DELAYS.eligible));
  await page.goto("/reclamar/mandato");
  await page.getByRole("checkbox", { name: /^Autorizo a ReTren/ }).check();
  await page.getByRole("checkbox", { name: /aviso de privacidad/ }).check();
  await page.getByRole("button", { name: "Aceptar y enviar" }).click();
  await expect(page).toHaveURL(/\/reclamar\/enviado$/);
  await check(page);
});
