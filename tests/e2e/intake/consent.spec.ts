import { expect, test, type Page } from "@playwright/test";
import { REVIEWED_TICKET } from "../../fixtures/intake/review";
import { consentsOf, startDraftWith } from "./support/draft";

// [A6] Mandate and GDPR consent: both texts are shown with their draft version; you can't
// continue without both checkboxes; with both, the evidence is stored and you land on "enviado".
// Roles and labels only.

const VERSION = "mandato-2026-11-14-borrador-2";
const mandateBox = (page: Page) => page.getByRole("checkbox", { name: /^Autorizo a ReTren/ });
const privacyBox = (page: Page) => page.getByRole("checkbox", { name: /aviso de privacidad/ });
const accept = (page: Page) => page.getByRole("button", { name: "Aceptar y enviar" });
const missingAlert = (page: Page) =>
  page.getByRole("alert").filter({ hasText: "Falta tu aceptación" });

// A proxy in front of the app (Vercel) sets x-forwarded-for; here the browser sends it.
test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.23, 10.0.0.1" } });

let draftId: string;

test.describe("with a reviewed trip", () => {
  test.beforeEach(async ({ page, context, baseURL }) => {
    draftId = await startDraftWith(context, baseURL!);
    await page.goto("/reclamar/mandato");
    await expect(
      page.getByRole("heading", { level: 1, name: "Autoriza a ReTren a reclamar por ti" }),
    ).toBeVisible();
  });

  test("shows both texts, marked as a draft with their version, and the trip", async ({ page }) => {
    await expect(page.getByText("Borrador pendiente de revisión jurídica")).toBeVisible();
    await expect(page.getByText(VERSION)).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "Autorización de representación" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "Aviso de privacidad" }),
    ).toBeVisible();

    const trip = page.getByRole("region", { name: "El viaje que autorizas" });
    await expect(trip).toContainText(REVIEWED_TICKET.bookingRef);
    await expect(trip).toContainText(`${REVIEWED_TICKET.origin} – ${REVIEWED_TICKET.destination}`);

    await expect(mandateBox(page)).not.toBeChecked();
    await expect(privacyBox(page)).not.toBeChecked();
  });

  test("you can't continue without either checkbox", async ({ page }) => {
    await accept(page).click();
    await expect(missingAlert(page)).toBeVisible();
    await expect(mandateBox(page)).toBeFocused();
    await expect(mandateBox(page)).toHaveAttribute("aria-invalid", "true");
    await expect(privacyBox(page)).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/\/reclamar\/mandato$/);
    expect(await consentsOf(draftId)).toHaveLength(0);
  });

  test("you can't continue with only the mandate", async ({ page }) => {
    await mandateBox(page).check();
    await accept(page).click();
    await expect(missingAlert(page)).toBeVisible();
    await expect(privacyBox(page)).toBeFocused();
    await expect(mandateBox(page)).not.toHaveAttribute("aria-invalid");
    await expect(page).toHaveURL(/\/reclamar\/mandato$/);
    expect(await consentsOf(draftId)).toHaveLength(0);
  });

  test("you can't continue with only the privacy notice", async ({ page }) => {
    await privacyBox(page).check();
    await accept(page).click();
    await expect(missingAlert(page)).toBeVisible();
    await expect(mandateBox(page)).toBeFocused();
    expect(await consentsOf(draftId)).toHaveLength(0);
  });

  test("checking a box clears its error", async ({ page }) => {
    await accept(page).click();
    await mandateBox(page).check();
    await expect(mandateBox(page)).not.toHaveAttribute("aria-invalid");
    await expect(privacyBox(page)).toHaveAttribute("aria-invalid", "true");
  });

  test("with both, the consent is stored and you land on enviado", async ({ page }) => {
    await mandateBox(page).check();
    await privacyBox(page).check();
    await accept(page).click();
    await expect(page).toHaveURL(/\/reclamar\/enviado$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Resultado de tu reclamación" }),
    ).toBeVisible();

    const rows = await consentsOf(draftId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      text_version: VERSION,
      ip: "198.51.100.23",
      trip_snapshot: { ticket: REVIEWED_TICKET },
    });
    expect(Math.abs(Date.parse(rows[0].accepted_at) - Date.now())).toBeLessThan(60_000);
  });

  test("the keyboard alone checks both boxes and sends", async ({ page }) => {
    await mandateBox(page).focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("Tab");
    await expect(privacyBox(page)).toBeFocused();
    await page.keyboard.press("Space");
    await page.keyboard.press("Tab");
    await expect(accept(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/reclamar\/enviado$/);
    expect(await consentsOf(draftId)).toHaveLength(1);
  });

  test("the server refuses a box that is not checked in the posted form", async ({ page }) => {
    // Both boxes pass the browser's check, then one is unchecked behind React's back: the
    // posted form lacks it, and only the server can refuse it.
    await mandateBox(page).check();
    await privacyBox(page).check();
    await privacyBox(page).evaluate((el) => {
      (el as HTMLInputElement).checked = false;
    });
    await accept(page).click();
    await expect(missingAlert(page)).toBeVisible();
    await expect(privacyBox(page)).toHaveAttribute("aria-invalid", "true");
    await expect(privacyBox(page)).toBeFocused();
    await expect(page).toHaveURL(/\/reclamar\/mandato$/);
    expect(await consentsOf(draftId)).toHaveLength(0);
  });

  test.describe("mobile, 375 px wide", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("fits without horizontal scrolling and has large tap targets", async ({ page }) => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const button = await accept(page).boundingBox();
      expect(button?.height ?? 0).toBeGreaterThanOrEqual(44);
      // The label is part of the target: each checkbox row is at least 44 px tall.
      for (const box of [mandateBox(page), privacyBox(page)]) {
        const label = await box.evaluate((el) => {
          const input = el as HTMLInputElement;
          return input.labels?.[0]?.getBoundingClientRect().height ?? 0;
        });
        expect(label).toBeGreaterThanOrEqual(44);
      }
    });
  });
});

test("without a reviewed trip, the step sends you back to the review", async ({
  page,
  context,
  baseURL,
}) => {
  await startDraftWith(context, baseURL!, {});
  await page.goto("/reclamar/mandato");
  await expect(page).toHaveURL(/\/reclamar\/revision$/);
});

test("without a draft, the step sends you to the upload", async ({ page }) => {
  await page.goto("/reclamar/mandato");
  await expect(page).toHaveURL(/\/reclamar\/foto$/);
});
