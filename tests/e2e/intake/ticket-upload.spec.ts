import { expect, test, type Page } from "@playwright/test";
import {
  PLACEHOLDER_HEIC,
  PLACEHOLDER_PDF,
  PLACEHOLDER_PNG,
  PLACEHOLDER_TEXT,
  placeholderPngOfSize,
} from "../../fixtures/intake/tickets";

// [A1] Ticket upload: a valid file is stored and previewed, with "Continuar" to the review step;
// a wrong type or an oversize file shows an error under the field. Roles and labels only.

const TEN_MB = 10 * 1024 * 1024;
const fileInput = (page: Page) => page.getByLabel("Foto o PDF del billete");
const uploadButton = (page: Page) => page.getByRole("button", { name: "Subir billete" });
const preview = (page: Page) => page.getByRole("region", { name: "Tu billete" });

async function choose(page: Page, name: string, mimeType: string, bytes: Uint8Array) {
  await fileInput(page).setInputFiles({ name, mimeType, buffer: Buffer.from(bytes) });
}

async function upload(page: Page, name: string, mimeType: string, bytes: Uint8Array) {
  await choose(page, name, mimeType, bytes);
  await uploadButton(page).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/reclamar/foto");
  await expect(
    page.getByRole("heading", { level: 1, name: "Sube la foto de tu billete" }),
  ).toBeVisible();
});

test("a photo uploads, shows its thumbnail and leads to the review step", async ({
  page,
  context,
}) => {
  await expect(page.getByRole("link", { name: "Continuar" })).toHaveCount(0);
  await upload(page, "billete.png", "image/png", PLACEHOLDER_PNG);

  await expect(preview(page)).toBeVisible();
  await expect(preview(page).getByRole("heading", { name: "Tu billete" })).toBeFocused();
  const thumbnail = preview(page).getByRole("img", { name: "Vista previa de tu billete" });
  await expect(thumbnail).toBeVisible();
  await expect
    .poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0);
  await expect(preview(page)).toContainText("billete.png");
  await expect(preview(page)).toContainText("PNG");

  // The draft id lives only in an httpOnly, SameSite=Lax cookie, never in the URL.
  const cookies = await context.cookies();
  const draft = cookies.find((c) => c.name === "retren_draft");
  expect(draft).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/reclamar" });
  expect(page.url()).not.toContain(draft!.value);

  // The draft survives a reload.
  await page.reload();
  await expect(preview(page)).toContainText("billete.png");

  await page.getByRole("link", { name: "Continuar" }).click();
  await expect(page).toHaveURL(/\/reclamar\/revision$/);
  expect(page.url()).not.toContain(draft!.value);
});

test("a PDF shows a file card instead of a thumbnail", async ({ page }) => {
  await upload(page, "billete.pdf", "application/pdf", PLACEHOLDER_PDF);
  await expect(preview(page)).toContainText("billete.pdf");
  await expect(preview(page)).toContainText("PDF");
  await expect(preview(page).getByRole("img")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Continuar" })).toBeVisible();
});

test("a HEIC photo is accepted and shown as a file card", async ({ page }) => {
  await upload(page, "IMG_0001.HEIC", "image/heic", PLACEHOLDER_HEIC);
  await expect(preview(page)).toContainText("IMG_0001.HEIC");
  await expect(preview(page)).toContainText("HEIC");
});

test("the file can be changed after uploading", async ({ page }) => {
  await upload(page, "primero.pdf", "application/pdf", PLACEHOLDER_PDF);
  await expect(preview(page)).toContainText("primero.pdf");

  await page.getByRole("button", { name: "Cambiar archivo" }).click();
  await expect(fileInput(page)).toBeFocused();
  await page.getByRole("button", { name: "Cancelar" }).click();
  await expect(preview(page)).toContainText("primero.pdf");

  await page.getByRole("button", { name: "Cambiar archivo" }).click();
  await upload(page, "segundo.png", "image/png", PLACEHOLDER_PNG);
  await expect(preview(page)).toContainText("segundo.png");
  await expect(preview(page)).not.toContainText("primero.pdf");
});

test.describe("errors", () => {
  test("a wrong type shows an error under the field and nothing is uploaded", async ({ page }) => {
    await choose(page, "notas.txt", "text/plain", PLACEHOLDER_TEXT);
    await expect(fileInput(page)).toHaveAttribute("aria-invalid", "true");
    await expect(fileInput(page)).toHaveAccessibleDescription(/no es una foto/i);

    await uploadButton(page).click();
    await expect(fileInput(page)).toBeFocused();
    await expect(preview(page)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Continuar" })).toHaveCount(0);
  });

  test("a file that only claims to be a photo is refused by the server", async ({ page }) => {
    await upload(page, "billete.jpg", "image/jpeg", PLACEHOLDER_TEXT);
    await expect(fileInput(page)).toHaveAttribute("aria-invalid", "true");
    await expect(fileInput(page)).toHaveAccessibleDescription(/no es una foto/i);
    await expect(fileInput(page)).toBeFocused();
    await expect(preview(page)).toHaveCount(0);
  });

  test("a file over 10 MB shows an error", async ({ page }) => {
    await choose(page, "grande.png", "image/png", placeholderPngOfSize(TEN_MB + 1));
    await expect(fileInput(page)).toHaveAccessibleDescription(/más de 10 MB/);
    await uploadButton(page).click();
    await expect(fileInput(page)).toBeFocused();
    await expect(preview(page)).toHaveCount(0);
  });

  test("uploading with no file asks for one", async ({ page }) => {
    await uploadButton(page).click();
    await expect(fileInput(page)).toHaveAccessibleDescription(/Elige la foto o el PDF/);
    await expect(fileInput(page)).toBeFocused();
  });

  test("choosing a valid file clears the error", async ({ page }) => {
    await choose(page, "notas.txt", "text/plain", PLACEHOLDER_TEXT);
    await expect(fileInput(page)).toHaveAttribute("aria-invalid", "true");
    await choose(page, "billete.png", "image/png", PLACEHOLDER_PNG);
    await expect(fileInput(page)).not.toHaveAttribute("aria-invalid");
  });
});

test.describe("mobile, 375 px wide", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  for (const scheme of ["light", "dark"] as const) {
    test(`the form and the preview fit without horizontal scrolling (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const overflow = () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
      expect(await overflow()).toBeLessThanOrEqual(0);
      expect((await uploadButton(page).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

      await upload(
        page,
        "un-nombre-de-archivo-muy-largo-sin-espacios-del-billete.png",
        "image/png",
        PLACEHOLDER_PNG,
      );
      await expect(preview(page)).toBeVisible();
      expect(await overflow()).toBeLessThanOrEqual(0);
      for (const target of [
        page.getByRole("link", { name: "Continuar" }),
        page.getByRole("button", { name: "Cambiar archivo" }),
      ]) {
        expect((await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
    });
  }
});
