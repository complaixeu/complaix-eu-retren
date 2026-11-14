import { expect, test } from "@playwright/test";
import {
  caseRows,
  createTeamMember,
  openCase,
  removeTeamMember,
  seedSentCase,
  signIn,
} from "./full-helpers";

// [C9] The team case page as tracking plus inbox (/equipo/casos/[id]), read on a phone:
// no horizontal scroll, every step name visible, the messages as a list of links, and one
// message read in place (?m=<id>) with a way back. Roles and labels only.
// Fake mail and classifier, local Supabase, DEMO_MODE=1.

test.use({ viewport: { width: 375, height: 812 } });

let member: string;
test.beforeAll(async () => {
  member = await createTeamMember();
});
test.afterAll(async () => {
  await removeTeamMember(member);
});

/** Every element inside `root` fits its own box and the viewport: nothing is cut off. */
async function everythingFits(root: import("@playwright/test").Locator): Promise<string[]> {
  return root.evaluate((node) => {
    const problems: string[] = [];
    const width = window.innerWidth;
    for (const el of [node, ...Array.from(node.querySelectorAll("*"))]) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < -0.5 || r.right > width + 0.5) problems.push(`outside: ${el.tagName}`);
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "auto") {
        problems.push(`clipped: ${el.tagName} ${el.textContent?.trim().slice(0, 40)}`);
      }
    }
    return problems;
  });
}

test("the case page has no horizontal scroll and every step name is fully visible at 375 px", async ({
  page,
}) => {
  const c = await seedSentCase();
  await signIn(page, member);
  await openCase(page, c);

  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  expect(fits).toBe(true);

  const tracking = page.getByRole("region", { name: "Claim process" });
  const steps = tracking.locator("li");
  await expect(steps).toHaveCount(5);
  for (const step of ["Case created", "Waiting period", "Claim sent", "Operator replied"]) {
    await expect(tracking.getByText(step, { exact: true })).toBeVisible();
  }
  expect(await everythingFits(tracking)).toEqual([]);
});

test("the inbox lists the case's messages as links, newest first", async ({ page }) => {
  const c = await seedSentCase();
  await signIn(page, member);
  await openCase(page, c);

  const inbox = page.getByRole("region", { name: "Email thread" });
  const rows = inbox.getByRole("link");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("href", /\?m=/);
  await expect(rows.first()).toContainText(`[${c.ref}] Delay compensation claim`);
  await expect(rows.first()).toContainText("Initial claim");
  expect(await everythingFits(inbox)).toEqual([]);
});

test("tapping a message shows it in full with a way back to the inbox", async ({ page }) => {
  const c = await seedSentCase();
  const { messages } = await caseRows(c.id);
  const body = messages.find((m) => m.direction === "outbound")?.body_text ?? "";
  const firstLine = body.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
  expect(firstLine).not.toBe("");

  await signIn(page, member);
  await openCase(page, c);
  const inbox = page.getByRole("region", { name: "Email thread" });
  await inbox.getByRole("link").first().click();

  await expect(page).toHaveURL(/\?m=[0-9a-f-]+$/);
  const subject = `[${c.ref}] Delay compensation claim`;
  await expect(page.getByRole("heading", { level: 3, name: subject })).toBeVisible();
  await expect(inbox).toContainText(firstLine);

  const back = page.getByRole("link", { name: "← Inbox" });
  await expect(back).toBeVisible();
  await back.click();

  await expect(page).not.toHaveURL(/\?m=/);
  await expect(page.getByRole("heading", { level: 1, name: `Case ${c.ref}` })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: subject })).toHaveCount(0);
  await expect(inbox.getByRole("link")).toHaveCount(1);
});

test("an unknown message id falls back to the inbox list", async ({ page }) => {
  const c = await seedSentCase();
  await signIn(page, member);
  await page.goto(`/equipo/casos/${c.id}?m=00000000-0000-4000-8000-000000000000`);
  await expect(page.getByRole("heading", { level: 1, name: `Case ${c.ref}` })).toBeVisible();
  await expect(page.getByRole("region", { name: "Email thread" }).getByRole("link")).toHaveCount(
    1,
  );
});

test("the dashboard has no horizontal scroll at 375 px and each case links to its page", async ({
  page,
}) => {
  const c = await seedSentCase();
  await signIn(page, member);

  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  expect(fits).toBe(true);
  const cases = page.getByRole("region", { name: "Cases" });
  await expect(cases.getByRole("link", { name: c.ref })).toHaveAttribute(
    "href",
    `/equipo/casos/${c.id}`,
  );
  expect(await everythingFits(cases)).toEqual([]);
});
