import { expect, test } from "@playwright/test";

test("the public pages share a light ReTren website frame on phone and desktop", async ({
  page,
}) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");

    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("link", { name: "ReTren, inicio" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Empezar reclamación" }).first()).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();

    const layout = await page.evaluate(() => ({
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      background: getComputedStyle(document.body).backgroundColor,
    }));
    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.background).toBe("rgb(250, 250, 250)");
  }
});
