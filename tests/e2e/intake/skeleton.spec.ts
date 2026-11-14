import { expect, test, type Page } from "@playwright/test";
import { PLACEHOLDER_PDF } from "../../fixtures/intake/tickets";
import { completeReview, startDraftWith } from "./support/draft";

// [A0] Flow skeleton: landing → every step renders its heading, the stepper marks the current
// step, and the flow works from the keyboard. Roles and labels only (docs/plans/README.md §3).
// Since [A4] the review step needs a draft (without one it redirects to the upload) and has its
// own form instead of a "Continuar" link, so these specs give it a draft before visiting it and
// fill the review in to get past it. Since [A6] the authorization step needs a reviewed draft.

/** Steps that need a current draft and redirect to the upload without one. */
const needsDraft = (path: string) =>
  path === "/reclamar/revision" || path === "/reclamar/preguntas";

/** Opens a step with the draft it needs: a plain one for the review, a reviewed one after it. */
async function visit(page: Page, baseURL: string | undefined, path: string) {
  if (needsDraft(path)) await startDraftWith(page.context(), baseURL!, {});
  if (needsReviewedDraft(path)) await startDraftWith(page.context(), baseURL!);
  await page.goto(path);
}

const steps = [
  { path: "/reclamar/foto", heading: "Sube la foto de tu billete", label: "Billete" },
  { path: "/reclamar/revision", heading: "Revisa los datos del billete", label: "Revisión" },
  { path: "/reclamar/preguntas", heading: "Unas preguntas sobre el viaje", label: "Preguntas" },
  {
    path: "/reclamar/mandato",
    heading: "Autoriza a ReTren a reclamar por ti",
    label: "Autorización",
  },
  { path: "/reclamar/enviado", heading: "Resultado de tu reclamación", label: "Envío" },
] as const;

const stepper = (page: Page) =>
  page.getByRole("navigation", { name: "Progreso de la reclamación" });

/** Since [A1] the first step needs a ticket before "Continuar" appears: choose a placeholder. */
async function chooseTicket(page: Page) {
  await page.getByLabel("Foto o PDF del billete").setInputFiles({
    name: "billete.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(PLACEHOLDER_PDF),
  });
}

/** The authorization step ([A6]) and the last step ([A7]) need a draft, or they redirect. */
const needsReviewedDraft = (path: string) =>
  path === "/reclamar/mandato" || path === "/reclamar/enviado";

/** Presses Tab until `target` has focus, failing after `max` presses. */
async function tabTo(page: Page, target: ReturnType<Page["getByRole"]>, max = 15) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`could not reach the element with Tab in ${max} presses`);
}

test("the landing page has a Reclamar button that starts the flow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "ReTren" })).toBeVisible();
  await page.getByRole("link", { name: "Reclamar" }).click();
  await expect(page).toHaveURL(/\/reclamar\/foto$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Sube la foto de tu billete" }),
  ).toBeVisible();
});

for (const [index, step] of steps.entries()) {
  test(`step ${index + 1} (${step.path}) renders its heading and is the current step`, async ({
    page,
    baseURL,
  }) => {
    await visit(page, baseURL, step.path);
    await expect(page.getByRole("heading", { level: 1, name: step.heading })).toBeVisible();
    await expect(page).toHaveTitle(new RegExp(step.heading));

    const items = stepper(page).getByRole("listitem");
    await expect(items).toHaveCount(steps.length);
    await expect(stepper(page)).toContainText(`Paso ${index + 1} de ${steps.length}`);

    for (const [i, other] of steps.entries()) {
      const item = items.nth(i);
      await expect(item).toContainText(other.label);
      if (i === index) await expect(item).toHaveAttribute("aria-current", "step");
      else await expect(item).not.toHaveAttribute("aria-current");
    }
  });
}

test("/reclamar starts the flow at its first step", async ({ page }) => {
  await page.goto("/reclamar");
  await expect(page).toHaveURL(/\/reclamar\/foto$/);
  await expect(page.getByRole("heading", { level: 1, name: steps[0].heading })).toBeVisible();
});

test("completed steps are links back, later steps are not", async ({ page, baseURL }) => {
  await startDraftWith(page.context(), baseURL!);
  await page.goto("/reclamar/preguntas");
  const nav = stepper(page);
  await expect(nav.getByRole("link", { name: /Billete/ })).toHaveAttribute(
    "href",
    "/reclamar/foto",
  );
  await expect(nav.getByRole("link", { name: /Revisión/ })).toBeVisible();
  await expect(nav.getByRole("link")).toHaveCount(2);
});

test("continuar and atrás move through every step in order", async ({ page }) => {
  await page.goto(steps[0].path);
  await chooseTicket(page);
  await page.getByRole("button", { name: "Subir billete" }).click();
  await expect(page.getByRole("link", { name: "Continuar" })).toBeVisible();
  await page.getByRole("link", { name: "Continuar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: steps[1].heading })).toBeVisible();

  // The review form saves the trip before A5 can continue.
  await completeReview(page);
  await expect(page.getByRole("heading", { level: 1, name: steps[2].heading })).toBeVisible();
  await page.getByRole("link", { name: "Atrás" }).click();
  await expect(page.getByRole("heading", { level: 1, name: steps[1].heading })).toBeVisible();

  await completeReview(page);
  await expect(page.getByRole("heading", { level: 1, name: steps[2].heading })).toBeVisible();
  await page.getByLabel("Número de documento").fill("12345678Z");
  await page.getByLabel("Email").fill("viajera@example.com");
  await page.getByLabel("Fecha de llegada").fill("2026-11-14");
  await page.getByLabel("Hora de llegada", { exact: true }).fill("18:25");
  await page.getByRole("radio", { name: "No", exact: true }).check();
  await page.getByRole("radio", { name: "Dinero" }).check();
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: steps[3].heading })).toBeVisible();

  // The mandate has two required decisions before the result is created.
  await page.getByRole("checkbox", { name: /^Autorizo a ReTren/ }).check();
  await page.getByRole("checkbox", { name: /aviso de privacidad/ }).check();
  await page.getByRole("button", { name: "Aceptar y enviar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: steps[4].heading })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continuar" })).toHaveCount(0);
});

test.describe("keyboard", () => {
  test("the first Tab reaches the skip link, which moves focus to the content", async ({
    page,
    baseURL,
  }) => {
    await visit(page, baseURL, "/reclamar/revision");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Saltar al contenido" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#contenido$/);
    await expect(page.getByRole("main")).toBeFocused();
  });

  test("the flow can be walked with Tab and Enter, with a visible focus ring", async ({ page }) => {
    await page.goto("/");
    const start = page.getByRole("link", { name: "Reclamar" });
    await tabTo(page, start);
    const outline = await start.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { level: 1, name: "Sube la foto de tu billete" }),
    ).toBeVisible();

    await chooseTicket(page);
    await tabTo(page, page.getByRole("button", { name: "Subir billete" }));
    await page.keyboard.press("Enter");
    await tabTo(page, page.getByRole("link", { name: "Continuar" }));
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { level: 1, name: "Revisa los datos del billete" }),
    ).toBeVisible();

    await tabTo(page, stepper(page).getByRole("link", { name: /Billete/ }));
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { level: 1, name: "Sube la foto de tu billete" }),
    ).toBeVisible();
  });
});

test.describe("mobile, 375 px wide", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  for (const path of ["/", ...steps.map((s) => s.path)]) {
    test(`${path} fits without horizontal scrolling and has large tap targets`, async ({
      page,
      baseURL,
    }) => {
      await visit(page, baseURL, path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      // The first step's primary action is its upload button ([A1]), the review's its submit
      // button ([A4]) and the authorization step's its accept button ([A6]); the others are links.
      const primary = page
        .getByRole("link", { name: /^(Reclamar|Continuar|Volver al inicio)$/ })
        .or(page.getByRole("button", { name: /^(Subir billete|Continuar|Aceptar y enviar)$/ }));
      await expect(primary).toBeVisible();
      const box = await primary.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    });
  }

  test("the stepper's links back are large enough to tap", async ({ page, context, baseURL }) => {
    await startDraftWith(context, baseURL!);
    await page.goto("/reclamar/mandato");
    const links = stepper(page).getByRole("link");
    await expect(links).toHaveCount(3);
    for (const link of await links.all()) {
      const box = await link.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
});

test("dark mode uses its own surface colours", async ({ page }) => {
  await page.goto("/reclamar/foto");
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMedia({ colorScheme: "light" });
  const light = await bg();
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await bg();
  expect(light).not.toBe("rgba(0, 0, 0, 0)");
  expect(dark).not.toBe("rgba(0, 0, 0, 0)");
  expect(dark).not.toBe(light);
});
