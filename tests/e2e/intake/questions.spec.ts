import { expect, test, type Page } from "@playwright/test";
import { REVIEW } from "../../fixtures/intake/review";
import { draftData, seedDraftData, uploadPlaceholderTicket } from "./support/draft";

const field = (page: Page, name: string) => page.getByLabel(name, { exact: true });

async function openQuestions(page: Page) {
  await uploadPlaceholderTicket(page);
  await seedDraftData(page.context(), { review: REVIEW });
  await page.goto("/reclamar/preguntas");
  await expect(
    page.getByRole("heading", { level: 1, name: "Unas preguntas sobre el viaje" }),
  ).toBeVisible();
}

async function completeBase(page: Page) {
  await field(page, "Número de documento").fill("12345678Z");
  await field(page, "Email").fill("viajera@example.com");
  await field(page, "Fecha de llegada").fill("2026-11-14");
  await field(page, "Hora de llegada").fill("18:25");
  await page.getByRole("radio", { name: "Dinero" }).check();
}

test("asks the required questions and saves a no answer", async ({ page, context }) => {
  await openQuestions(page);
  await expect(page.getByRole("radio", { name: "DNI" })).toBeChecked();
  await expect(field(page, "Número de documento")).toBeVisible();
  await expect(field(page, "Email")).toHaveAttribute("type", "email");
  await completeBase(page);
  await page.getByRole("radio", { name: "No", exact: true }).check();
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page).toHaveURL(/\/reclamar\/mandato$/);
  expect(await draftData(context)).toMatchObject({
    answers: {
      documentNumber: "12345678Z",
      previousClaim: { made: false },
      paymentPreference: "money",
    },
  });
});

test("asks for prior claim details only on the yes branch", async ({ page }) => {
  await openQuestions(page);
  await expect(field(page, "Fecha de la reclamación")).toHaveCount(0);
  await page.getByRole("radio", { name: "Sí", exact: true }).check();
  await expect(field(page, "Fecha de la reclamación")).toBeVisible();
  await expect(field(page, "A quién reclamaste")).toBeVisible();
  await expect(field(page, "Cómo reclamaste")).toBeVisible();
  await page.getByRole("radio", { name: "No", exact: true }).check();
  await expect(field(page, "Fecha de la reclamación")).toHaveCount(0);
});

test("rejects a wrong identity check letter and focuses the field", async ({ page }) => {
  await openQuestions(page);
  await completeBase(page);
  await field(page, "Número de documento").fill("12345678A");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(field(page, "Número de documento")).toBeFocused();
  await expect(field(page, "Número de documento")).toHaveAccessibleDescription(
    /letra de control no coincide/,
  );
});
