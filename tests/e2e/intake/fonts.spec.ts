import { expect, test } from "@playwright/test";

// [A0] The fonts are served from this site (public/fonts/), never from a Google Fonts host, and
// the page loads the woff2 files it uses. The landing is the first thing every user sees.

const EXTERNAL_FONT_HOSTS = /fonts\.googleapis\.com|fonts\.gstatic\.com/;

test("the landing loads its fonts from this site and makes no request to a font host", async ({
  page,
  baseURL,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => {
    requested.push(request.url());
  });

  const fontResponses: string[] = [];
  page.on("response", (response) => {
    if (response.url().endsWith(".woff2")) fontResponses.push(response.url());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "ReTren" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  expect(requested.filter((url) => EXTERNAL_FONT_HOSTS.test(url))).toEqual([]);

  const origin = new URL(baseURL!).origin;
  const siteFonts = requested.filter((url) => url.endsWith(".woff2"));
  for (const url of siteFonts) {
    expect(url.startsWith(`${origin}/fonts/`), url).toBe(true);
  }

  // The latin subsets are preloaded, so they are always fetched from this site.
  expect(fontResponses.some((url) => url.includes("/fonts/dm-sans-v17-latin.woff2"))).toBe(true);
  expect(fontResponses.some((url) => url.includes("/fonts/montserrat-v31-latin.woff2"))).toBe(true);
  for (const url of fontResponses) {
    expect(url.startsWith(`${origin}/fonts/`), url).toBe(true);
  }
});
