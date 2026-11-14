import { expect, test, type Page } from "@playwright/test";
import { fullTicket, manualExtraction, partialExtraction } from "../../fixtures/intake/extraction";
import { completeReview, draftData, seedDraftData, uploadPlaceholderTicket } from "./draft-helpers";

// [A4] Review screen: every field of the ticket is editable, the ones the extraction couldn't
// read are marked and asked for, the localizador must be confirmed explicitly, and the reviewed
// data is saved to the draft. Roles and labels only (docs/plans/README.md §3).

const heading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: "Revisa los datos del billete" });
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
const confirm = (page: Page) =>
  page.getByRole("checkbox", { name: "He comprobado el localizador" });
const continueButton = (page: Page) => page.getByRole("button", { name: "Continuar" });
const MISSING = /No aparece en el billete/;
const NEXT_DAY = /Llegas después de medianoche: lo guardamos como llegada del día siguiente\./;
// The form's error summary. Next's route announcer is also a role="alert", so match by its text.
const errorSummary = (page: Page) =>
  page.getByRole("alert").filter({ hasText: "Faltan datos o hay alguno que corregir" });

async function openWith(page: Page, data: Record<string, unknown>) {
  await uploadPlaceholderTicket(page);
  await seedDraftData(page.context(), data);
  await page.goto("/reclamar/revision");
  await expect(heading(page)).toBeVisible();
}

test("without a draft the step sends you to the upload", async ({ page }) => {
  await page.goto("/reclamar/revision");
  await expect(page).toHaveURL(/\/reclamar\/foto$/);
});

test("shows what was read, editable, with date and time inputs", async ({ page }) => {
  await openWith(page, { extraction: { quality: "ok", data: fullTicket, missing: [] } });

  await expect(page.getByRole("radio", { name: "Iryo" })).toBeChecked();
  await expect(field(page, "Localizador")).toHaveValue("ABC123");
  await expect(field(page, "Fecha del viaje")).toHaveValue("2026-03-12");
  await expect(field(page, "Fecha del viaje")).toHaveAttribute("type", "date");
  await expect(field(page, "Hora de salida prevista")).toHaveValue("09:10");
  await expect(field(page, "Hora de salida prevista")).toHaveAttribute("type", "time");
  await expect(field(page, "Hora de llegada prevista")).toHaveAttribute("type", "time");
  await expect(field(page, "Estación de origen")).toHaveValue("Estación Uno");
  await expect(field(page, "Estación de destino")).toHaveValue("Estación Dos");
  await expect(field(page, "Nombre")).toHaveValue("Persona");
  await expect(field(page, "Apellidos")).toHaveValue("De Prueba");
  await expect(field(page, "Número de tren (opcional)")).toHaveValue("6201");
  await expect(field(page, "Número de billete (opcional)")).toHaveValue("0000000001");
  await expect(field(page, "Precio (opcional)")).toHaveValue("54,90 €");
  await expect(field(page, "Fecha de compra (opcional)")).toHaveValue("2026-03-01");
  await expect(page.getByRole("radio", { name: /web, la app o la taquilla/ })).toBeChecked();

  // Nothing is marked as missing, and the localizador still has to be confirmed by hand.
  await expect(page.getByText(MISSING)).toHaveCount(0);
  await expect(confirm(page)).not.toBeChecked();
});

test("the missing fields are marked and asked for", async ({ page }) => {
  await openWith(page, { extraction: partialExtraction });

  await expect(page.getByText(/3 datos que no aparecen en el billete/)).toBeVisible();
  await expect(field(page, "Localizador")).toHaveValue("");
  await expect(field(page, "Localizador")).toHaveAccessibleDescription(MISSING);
  await expect(field(page, "Hora de llegada prevista")).toHaveAccessibleDescription(MISSING);
  await expect(field(page, "Número de billete (opcional)")).toHaveAccessibleDescription(MISSING);
  await expect(field(page, "Estación de origen")).not.toHaveAccessibleDescription(MISSING);

  await confirm(page).check();
  await continueButton(page).click();

  await expect(errorSummary(page)).toBeVisible();
  await expect(field(page, "Localizador")).toBeFocused();
  await expect(field(page, "Localizador")).toHaveAttribute("aria-invalid", "true");
  await expect(field(page, "Localizador")).toHaveAccessibleDescription(
    /Escribe el localizador tal como aparece en el billete/,
  );
  await expect(field(page, "Hora de llegada prevista")).toHaveAccessibleDescription(
    /Escribe la hora de llegada prevista/,
  );
  // The optional ticket number may stay empty; what was read is kept.
  await expect(field(page, "Número de billete (opcional)")).not.toHaveAttribute("aria-invalid");
  await expect(field(page, "Estación de origen")).toHaveValue("Estación Uno");
  await expect(page).toHaveURL(/\/reclamar\/revision$/);
  expect(await draftData(page.context())).not.toHaveProperty("review");
});

test("you can't continue without confirming the localizador", async ({ page }) => {
  await openWith(page, { extraction: { quality: "ok", data: fullTicket, missing: [] } });

  await continueButton(page).click();
  await expect(confirm(page)).toBeFocused();
  await expect(confirm(page)).toHaveAccessibleDescription(/Marca la casilla/);
  await expect(page).toHaveURL(/\/reclamar\/revision$/);
  expect(await draftData(page.context())).not.toHaveProperty("review");

  await confirm(page).check();
  await continueButton(page).click();
  await expect(page).toHaveURL(/\/reclamar\/preguntas$/);
});

test("changing the localizador asks to confirm it again", async ({ page }) => {
  await openWith(page, { extraction: { quality: "ok", data: fullTicket, missing: [] } });
  await confirm(page).check();
  await field(page, "Localizador").fill("ABC124");
  await expect(confirm(page)).not.toBeChecked();
});

test("an edited field is saved to the draft and shown again on the way back", async ({ page }) => {
  await openWith(page, { extraction: partialExtraction });

  await field(page, "Estación de origen").fill("Estación Corregida");
  await field(page, "Localizador").fill("QWE987");
  await field(page, "Hora de llegada prevista").fill("11:55");
  await confirm(page).check();
  await continueButton(page).click();
  await expect(page).toHaveURL(/\/reclamar\/preguntas$/);

  const data = await draftData(page.context());
  expect(data.extraction).toEqual(partialExtraction);
  expect(data.review).toMatchObject({
    bookingRefConfirmed: true,
    ticket: {
      ...partialExtraction.data,
      origin: "Estación Corregida",
      bookingRef: "QWE987",
      scheduledArrival: "11:55",
    },
  });

  await page.goto("/reclamar/revision");
  await page.reload();
  await expect(field(page, "Estación de origen")).toHaveValue("Estación Corregida");
  await expect(field(page, "Localizador")).toHaveValue("QWE987");
  // A saved review never comes back pre-confirmed: the localizador is checked on every submit.
  await expect(confirm(page)).not.toBeChecked();
  await continueButton(page).click();
  await expect(confirm(page)).toBeFocused();
  await expect(confirm(page)).toHaveAccessibleDescription(/Marca la casilla/);
});

test("an arrival after midnight is saved as the next day, with a note", async ({ page }) => {
  await openWith(page, { extraction: { quality: "ok", data: fullTicket, missing: [] } });
  const arrival = field(page, "Hora de llegada prevista");
  await expect(arrival).not.toHaveAccessibleDescription(NEXT_DAY);

  await field(page, "Hora de salida prevista").fill("23:10");
  await arrival.fill("01:40");
  // The note shows as soon as both times are in, before anything is sent.
  await expect(page.getByText(NEXT_DAY)).toBeVisible();
  await expect(arrival).toHaveAccessibleDescription(NEXT_DAY);
  await expect(arrival).not.toHaveAttribute("aria-invalid");

  await confirm(page).check();
  await continueButton(page).click();
  await expect(page).toHaveURL(/\/reclamar\/preguntas$/);
  expect(await draftData(page.context())).toMatchObject({
    review: { ticket: { scheduledDeparture: "23:10", scheduledArrival: "01:40" } },
  });

  // And again on the way back, from what was saved.
  await page.goto("/reclamar/revision");
  await expect(page.getByText(NEXT_DAY)).toBeVisible();
});

test("an arrival at the same time as the departure is refused", async ({ page }) => {
  await openWith(page, { extraction: { quality: "ok", data: fullTicket, missing: [] } });
  await field(page, "Hora de llegada prevista").fill("09:10");
  await confirm(page).check();
  await continueButton(page).click();
  await expect(field(page, "Hora de llegada prevista")).toBeFocused();
  await expect(field(page, "Hora de llegada prevista")).toHaveAccessibleDescription(
    /no puede ser la misma que la de salida/,
  );
  await expect(page).toHaveURL(/\/reclamar\/revision$/);
});

test("with nothing read, every field is typed by hand", async ({ page }) => {
  await openWith(page, { extraction: manualExtraction });
  await expect(page.getByText(/Escribe los datos tal como aparecen en el billete/)).toBeVisible();
  await expect(field(page, "Localizador")).toHaveValue("");
  await completeReview(page);
  await expect(page).toHaveURL(/\/reclamar\/preguntas$/);
});

test.describe("mobile, 375 px wide", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  for (const scheme of ["light", "dark"] as const) {
    test(`the form fits without horizontal scrolling (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openWith(page, { extraction: partialExtraction });
      const overflow = () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
      expect(await overflow()).toBeLessThanOrEqual(0);
      // A radio or checkbox is tapped through its label, so the label is what must be large.
      const choiceLabel = (name: string) => page.getByText(name, { exact: true });
      for (const target of [
        continueButton(page),
        field(page, "Localizador"),
        field(page, "Fecha del viaje"),
        field(page, "Fecha de compra (opcional)"),
        field(page, "Hora de salida prevista"),
        field(page, "Hora de llegada prevista"),
        choiceLabel("Iryo"),
        choiceLabel("Renfe"),
        choiceLabel("Ouigo"),
        choiceLabel("No lo recuerdo"),
        choiceLabel("He comprobado el localizador"),
      ]) {
        const box = await target.boundingBox();
        expect(box?.height ?? 0, String(target)).toBeGreaterThanOrEqual(44);
      }
      await continueButton(page).click();
      await expect(errorSummary(page)).toBeVisible();
      expect(await overflow()).toBeLessThanOrEqual(0);
    });
  }
});
