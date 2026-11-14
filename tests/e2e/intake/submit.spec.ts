import { expect, test, type Page } from "@playwright/test";
import { REVIEW } from "../../fixtures/intake/review";
import { DELAYS, tripData } from "../../fixtures/intake/submit";
import {
  casesOfDraft,
  deleteDraftRow,
  draftExists,
  startSubmittableDraft,
  ticketObjectExists,
} from "./support/draft";

// [A7] Submitting the draft creates the case and the last step shows the result: eligible (with
// the earliest send date), not eligible (with the reason) or doubtful. Roles and labels only.
// The app runs on domain B's rules as `@/features/rules` exports them; the eligible and not
// eligible trips go through the real flow, the doubtful screen from a stored result (the rules
// mock never says "doubtful"; the integration test drives createCase to it).

const heading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: "Resultado de tu reclamación" });

async function authorize(page: Page) {
  await page.goto("/reclamar/mandato");
  await page.getByRole("checkbox", { name: /^Autorizo a ReTren/ }).check();
  await page.getByRole("checkbox", { name: /aviso de privacidad/ }).check();
  await page.getByRole("button", { name: "Aceptar y enviar" }).click();
  await expect(page).toHaveURL(/\/reclamar\/enviado$/);
  await expect(heading(page)).toBeVisible();
}

const madridDay = (instant: string) =>
  new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Madrid",
  }).format(new Date(instant));

type StoredCase = { public_ref: string; eligibility: { reason: string; earliestSendAt?: string } };

test.describe("eligible trip", () => {
  test("creates the case, shows the send date and cleans up the draft", async ({
    page,
    context,
    baseURL,
  }) => {
    const draft = await startSubmittableDraft(context, baseURL!, tripData(DELAYS.eligible));
    await authorize(page);

    await expect(
      page.getByRole("status").filter({ hasText: "Tu viaje da derecho a reclamar" }),
    ).toBeVisible();
    const cases = await casesOfDraft(draft.id);
    expect(cases).toHaveLength(1);
    const stored = cases[0] as unknown as StoredCase;
    const summary = page.getByRole("region", { name: "Tu reclamación" });
    await expect(summary).toContainText(stored.public_ref);
    await expect(summary).toContainText(
      `a partir del ${madridDay(stored.eligibility.earliestSendAt!)}`,
    );
    await expect(page.getByText("Tu tren llegó con 120 minutos de retraso.")).toBeVisible();

    // Data minimization: no draft, the ticket file moved out of drafts/, the consent kept.
    expect(await draftExists(draft.id)).toBe(false);
    expect(await ticketObjectExists(draft.ticketPath)).toBe(false);
    expect(await ticketObjectExists(`submitted/${draft.id}.png`)).toBe(true);
  });

  test("a reload shows the same result and creates no second case", async ({
    page,
    context,
    baseURL,
  }) => {
    const draft = await startSubmittableDraft(context, baseURL!, tripData(DELAYS.eligible));
    await authorize(page);
    const ref = ((await casesOfDraft(draft.id))[0] as unknown as StoredCase).public_ref;

    await page.reload();
    await expect(heading(page)).toBeVisible();
    await expect(page.getByRole("region", { name: "Tu reclamación" })).toContainText(ref);
    expect(await casesOfDraft(draft.id)).toHaveLength(1);

    // The draft cookie is gone: going back to a step starts over at the upload.
    await page.goto("/reclamar/mandato");
    await expect(page).toHaveURL(/\/reclamar\/foto$/);
  });

  test("a draft that was not sent yet is sent from the last step, once", async ({
    page,
    context,
    baseURL,
  }) => {
    const draft = await startSubmittableDraft(context, baseURL!, tripData(DELAYS.eligible));
    await page.goto("/reclamar/enviado");
    await expect(heading(page)).toBeVisible();
    await expect(page.getByText("Tienes todo listo. Falta enviar tu reclamación.")).toBeVisible();
    expect(await casesOfDraft(draft.id)).toHaveLength(0);

    await page.getByRole("button", { name: "Enviar reclamación" }).click();
    await expect(page.getByRole("region", { name: "Tu reclamación" })).toBeVisible();
    expect(await casesOfDraft(draft.id)).toHaveLength(1);
  });

  test.describe("mobile, 375 px wide", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("fits without horizontal scrolling", async ({ page, context, baseURL }) => {
      await startSubmittableDraft(context, baseURL!, tripData(DELAYS.eligible));
      await authorize(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const back = await page.getByRole("link", { name: "Volver al inicio" }).boundingBox();
      expect(back?.height ?? 0).toBeGreaterThanOrEqual(44);
    });
  });
});

test.describe("not eligible trip", () => {
  test("shows the reason, no send date, and still stores the case", async ({
    page,
    context,
    baseURL,
  }) => {
    const draft = await startSubmittableDraft(context, baseURL!, tripData(DELAYS.notEligible));
    await authorize(page);

    await expect(page.getByRole("heading", { name: "Resultado de tu reclamación" })).toBeVisible();
    const cases = await casesOfDraft(draft.id);
    expect(cases).toHaveLength(1);
    const stored = cases[0] as unknown as StoredCase;
    await expect(page.getByText("Este viaje no da derecho a indemnización")).toBeVisible();
    await expect(page.getByText(stored.eligibility.reason)).toBeVisible();
    await expect(page.getByText("No enviaremos nada a la compañía.")).toBeVisible();
    await expect(page.getByText(/a partir del/)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Tu reclamación" })).toContainText(
      stored.public_ref,
    );
    expect(await draftExists(draft.id)).toBe(false);
  });
});

test.describe("doubtful trip", () => {
  test("says the right is doubtful, that we claim anyway, and the send date", async ({
    page,
    context,
    baseURL,
  }) => {
    const result = {
      caseId: "7d9d5a39-6e2c-4c5a-a2f0-0e1d86c7b9d1",
      publicRef: "RTN-D0UBT123",
      status: "waiting_period",
      eligibility: {
        status: "doubtful",
        reason: "Con 60 minutos exactos el derecho es dudoso; se envía igualmente.",
        delayMinutes: 60,
        tier: { percent: 50, payment: ["voucher"] },
        earliestSendAt: "2026-03-12T23:30:00.000Z",
        appliedRules: ["operator_config"],
        configVersion: "test",
      },
    };
    await context.addCookies([
      {
        name: "retren_case",
        value: encodeURIComponent(JSON.stringify(result)),
        domain: new URL(baseURL!).hostname,
        path: "/reclamar",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.goto("/reclamar/enviado");
    await expect(heading(page)).toBeVisible();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Tu derecho es dudoso, pero reclamamos igualmente" }),
    ).toContainText(result.eligibility.reason);
    const summary = page.getByRole("region", { name: "Tu reclamación" });
    await expect(summary).toContainText("RTN-D0UBT123");
    // 23:30 UTC is already the next day in Madrid.
    await expect(summary).toContainText("a partir del 13 de marzo de 2026");
    await expect(page.getByText("Tu tren llegó con 60 minutos de retraso.")).toBeVisible();
  });
});

test.describe("incomplete submission", () => {
  test("without answers, links back to the questions", async ({ page, context, baseURL }) => {
    const draft = await startSubmittableDraft(context, baseURL!, { review: REVIEW });
    await page.goto("/reclamar/enviado");
    await expect(page.getByRole("status")).toContainText("Faltan respuestas sobre tu viaje.");
    await page.getByRole("link", { name: "Responder las preguntas" }).click();
    await expect(page).toHaveURL(/\/reclamar\/preguntas$/);
    expect(await casesOfDraft(draft.id)).toHaveLength(0);
    expect(await draftExists(draft.id)).toBe(true);
  });

  test("without consent, links back to the authorization", async ({ page, context, baseURL }) => {
    await startSubmittableDraft(context, baseURL!, tripData(DELAYS.eligible), { consent: false });
    await page.goto("/reclamar/enviado");
    await expect(page.getByRole("status")).toContainText("Falta tu autorización para reclamar.");
    await page.getByRole("link", { name: "Dar la autorización" }).click();
    await expect(page).toHaveURL(/\/reclamar\/mandato$/);
  });

  test("without a review, links back to it", async ({ page, context, baseURL }) => {
    await startSubmittableDraft(context, baseURL!, { answers: tripData(DELAYS.eligible).answers });
    await page.goto("/reclamar/enviado");
    await page.getByRole("link", { name: "Revisar el billete" }).click();
    await expect(page).toHaveURL(/\/reclamar\/revision$/);
  });

  test("without a draft or a result, goes to the upload", async ({ page }) => {
    await page.goto("/reclamar/enviado");
    await expect(page).toHaveURL(/\/reclamar\/foto$/);
  });
});

test.describe("a second request after the claim went out", () => {
  test("a submit whose draft is already gone says the claim was received", async ({
    page,
    context,
    baseURL,
  }) => {
    const draft = await startSubmittableDraft(context, baseURL!, tripData(DELAYS.eligible));
    await page.goto("/reclamar/enviado");
    await expect(page.getByRole("button", { name: "Enviar reclamación" })).toBeVisible();

    // The other tab submitted and cleaned up; this browser has no result cookie yet.
    await deleteDraftRow(draft.id);
    await page.getByRole("button", { name: "Enviar reclamación" }).click();

    await expect(page).toHaveURL(/\/reclamar\/enviado/);
    await expect(
      page.getByRole("status").filter({ hasText: "Ya hemos recibido tu reclamación" }),
    ).toContainText("revisa tu email");
    await expect(page.getByRole("button", { name: "Enviar reclamación" })).toHaveCount(0);
  });

  test("the same screen is there on a reload", async ({ page }) => {
    await page.goto("/reclamar/enviado?aviso=recibida");
    await expect(page).toHaveURL(/aviso=recibida/);
    await expect(page.getByText("Ya hemos recibido tu reclamación")).toBeVisible();
  });
});
