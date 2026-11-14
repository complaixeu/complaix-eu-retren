import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { localSupabase } from "../../support/local-supabase";
import {
  PLACEHOLDER_HEIC,
  PLACEHOLDER_JPEG_UNREADABLE,
  PLACEHOLDER_PNG,
} from "../../fixtures/intake/tickets";

// [A3] Reading the ticket after the upload, with the fake OCR and extractor: a readable photo
// leads to the review step with its fields stored; an unreadable one asks for another photo, and
// the second failure goes to manual entry (the review step asks for every field). Roles and
// labels only.

const ALL_FIELDS = [
  "operator",
  "travelDate",
  "origin",
  "destination",
  "bookingRef",
  "ticketNumber",
  "firstName",
  "lastName",
  "scheduledDeparture",
  "scheduledArrival",
  "trainNumber",
  "price",
  "purchaseDate",
  "purchaseChannel",
];

const fileInput = (page: Page) => page.getByLabel("Foto o PDF del billete");
const preview = (page: Page) => page.getByRole("region", { name: "Tu billete" });
const retryAlert = (page: Page) =>
  page.getByRole("status").filter({ hasText: "No hemos podido leer el billete" });

async function upload(page: Page, name: string, mimeType: string, bytes: Uint8Array) {
  await fileInput(page).setInputFiles({ name, mimeType, buffer: Buffer.from(bytes) });
  await page.getByRole("button", { name: "Subir billete" }).click();
}

/** The draft row behind the browser's cookie, read with the local service key. */
async function storedDraft(context: BrowserContext) {
  const cookie = (await context.cookies()).find((c) => c.name === "retren_draft");
  expect(cookie).toBeDefined();
  const sb = localSupabase();
  const db = createClient(sb.url, sb.serviceRoleKey, { auth: { persistSession: false } });
  const { data, error } = await db
    .from("intake_drafts")
    .select("data")
    .eq("id", cookie!.value)
    .single();
  expect(error).toBeNull();
  return data!.data as Record<string, unknown>;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/reclamar/foto");
  await expect(
    page.getByRole("heading", { level: 1, name: "Sube la foto de tu billete" }),
  ).toBeVisible();
});

test("a readable photo is read and leads to the review step with its fields stored", async ({
  page,
  context,
}) => {
  await upload(page, "billete.png", "image/png", PLACEHOLDER_PNG);
  await expect(preview(page)).toContainText("Ya hemos leído el billete");
  await expect(retryAlert(page)).toHaveCount(0);

  const data = await storedDraft(context);
  expect(data.extraction).toMatchObject({
    quality: "ok",
    data: { operator: "iryo", bookingRef: "ABC123", travelDate: "2026-03-12" },
  });

  await page.getByRole("link", { name: "Continuar" }).click();
  await expect(page).toHaveURL(/\/reclamar\/revision$/);
});

test("unreadable → another photo → unreadable again → manual entry in the review step", async ({
  page,
  context,
}) => {
  await upload(page, "borrosa.jpg", "image/jpeg", PLACEHOLDER_JPEG_UNREADABLE);

  // What happened and what to do next; no way forward with this photo.
  await expect(retryAlert(page)).toBeVisible();
  await expect(retryAlert(page)).toContainText(/billete entero/);
  await expect(retryAlert(page)).toContainText(/a mano/);
  await expect(page.getByRole("link", { name: "Continuar" })).toHaveCount(0);
  expect(await storedDraft(context)).toEqual({ ocrAttempts: 1 });

  // The advice stays in view while choosing the next photo.
  await page.getByRole("button", { name: "Subir otra foto" }).click();
  await expect(fileInput(page)).toBeFocused();
  await expect(page.getByText("No hemos podido leer el billete")).toBeVisible();

  await upload(page, "borrosa-otra.jpg", "image/jpeg", PLACEHOLDER_JPEG_UNREADABLE);
  await expect(page).toHaveURL(/\/reclamar\/revision$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Revisa los datos del billete" }),
  ).toBeVisible();
  expect(await storedDraft(context)).toEqual({
    ocrAttempts: 2,
    extraction: { quality: "unreadable", data: {}, missing: ALL_FIELDS },
  });

  // Back on the first step, it says why the data will be typed by hand, and lets the user on.
  await page.goto("/reclamar/foto");
  await expect(preview(page)).toContainText("borrosa-otra.jpg");
  await expect(preview(page)).toContainText(/escribes los datos a mano/);
  await expect(page.getByRole("link", { name: "Continuar" })).toBeVisible();
});

test("a readable photo after an unreadable one goes on normally", async ({ page, context }) => {
  await upload(page, "borrosa.jpg", "image/jpeg", PLACEHOLDER_JPEG_UNREADABLE);
  await expect(retryAlert(page)).toBeVisible();
  await page.getByRole("button", { name: "Subir otra foto" }).click();
  await upload(page, "billete.png", "image/png", PLACEHOLDER_PNG);
  await expect(preview(page)).toContainText("Ya hemos leído el billete");
  await expect(page.getByRole("link", { name: "Continuar" })).toBeVisible();
  expect((await storedDraft(context)).ocrAttempts).toBe(0);
});

test("a HEIC photo explains that HEIC can't be read and suggests another format", async ({
  page,
}) => {
  await upload(page, "IMG_0001.HEIC", "image/heic", PLACEHOLDER_HEIC);
  const alert = page.getByRole("status").filter({ hasText: "HEIC" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/captura de pantalla/);
  await expect(alert).toContainText(/JPG, PNG o PDF/);
  await expect(page.getByRole("button", { name: "Subir otra foto" })).toBeVisible();
});

test("the state survives a reload", async ({ page }) => {
  await upload(page, "borrosa.jpg", "image/jpeg", PLACEHOLDER_JPEG_UNREADABLE);
  await expect(retryAlert(page)).toBeVisible();
  await page.reload();
  await expect(retryAlert(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Subir otra foto" })).toBeVisible();
});

test.describe("mobile, 375 px wide", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  for (const scheme of ["light", "dark"] as const) {
    test(`the "otra foto" state fits and its buttons are easy to tap (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await upload(page, "borrosa.jpg", "image/jpeg", PLACEHOLDER_JPEG_UNREADABLE);
      await expect(retryAlert(page)).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const button = page.getByRole("button", { name: "Subir otra foto" });
      expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    });
  }
});
