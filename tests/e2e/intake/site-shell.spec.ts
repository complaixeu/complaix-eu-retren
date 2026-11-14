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
    const logo = page.getByRole("link", { name: "ReTren, inicio" }).locator("img");
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute("src", "/gemini-svg.svg");
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

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const introAnimation = await page
    .locator("main > section > div")
    .first()
    .evaluate((element) => getComputedStyle(element).animationName);
  expect(introAnimation).toBe("none");
});
