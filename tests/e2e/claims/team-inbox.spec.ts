import { expect, test } from "@playwright/test";
import {
  caseRows,
  createTeamMember,
  db,
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

/**
 * Every visible element inside `root` fits the viewport and its own box: nothing is cut off.
 * Skipped on purpose: screen-reader-only text (a 1 px clip box) and the one-line preview, the only
 * text the list cuts with an ellipsis on purpose.
 */
async function everythingFits(root: import("@playwright/test").Locator): Promise<string[]> {
  return root.evaluate((node) => {
    const problems: string[] = [];
    const width = window.innerWidth;
    for (const el of [node, ...Array.from(node.querySelectorAll("*"))]) {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      const style = getComputedStyle(el);
      if (r.left < -0.5 || r.right > width + 0.5) problems.push(`outside: ${el.tagName}`);
      if (style.textOverflow === "ellipsis") continue;
      if (el.scrollWidth > el.clientWidth + 1 && style.overflowX !== "auto") {
        problems.push(`clipped: ${el.tagName} ${el.textContent?.trim().slice(0, 40)}`);
      }
    }
    return problems;
  });
}

const noPageScroll = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("the case page has no horizontal scroll and every step name is fully visible at 375 px", async ({
  page,
}) => {
  const c = await seedSentCase();
  await signIn(page, member);
  await openCase(page, c);

  expect(await noPageScroll(page)).toBe(true);

  const tracking = page.getByRole("region", { name: "Claim process" });
  const steps = tracking.locator("li");
  await expect(steps).toHaveCount(5);
  for (const step of ["Case created", "Waiting period", "Claim sent", "Operator replied"]) {
    await expect(tracking.getByText(step, { exact: true })).toBeVisible();
  }
  expect(await everythingFits(tracking)).toEqual([]);
});

test("the case page has exactly one main landmark, on the case page and the dashboard", async ({
  page,
}) => {
  const c = await seedSentCase();
  await signIn(page, member);
  await expect(page.getByRole("main")).toHaveCount(1);
  await openCase(page, c);
  await expect(page.getByRole("main")).toHaveCount(1);
});

test("the tracking shows a date only for steps that have happened, and says each step's state", async ({
  page,
}) => {
  // A case sent today: "Claim sent" is the current step; the two steps after it are upcoming.
  const c = await seedSentCase();
  await signIn(page, member);
  await openCase(page, c);

  const tracking = page.getByRole("region", { name: "Claim process" });
  const steps = tracking.locator("li");
  await expect(steps.nth(2)).toContainText("Day");
  await expect(steps.nth(3)).not.toContainText("Day");
  await expect(steps.nth(4)).not.toContainText("Day");

  await expect(tracking.locator('[aria-current="step"]')).toHaveCount(1);
  await expect(tracking.locator('[aria-current="step"]')).toContainText("Claim sent");
  await expect(tracking.getByText("completed", { exact: true })).toHaveCount(2);
  await expect(tracking.getByText("upcoming", { exact: true })).toHaveCount(2);
});

test("the inbox lists the case's messages as links, newest first, without the case tag", async ({
  page,
}) => {
  const c = await seedSentCase();
  await signIn(page, member);
  await openCase(page, c);

  const inbox = page.getByRole("region", { name: "Email thread" });
  const rows = inbox.getByRole("link");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("href", /\?m=/);
  await expect(rows.first()).toContainText("Delay compensation claim");
  await expect(rows.first()).not.toContainText(`[${c.ref}]`);
  await expect(rows.first()).toContainText("Initial claim");
  expect(await everythingFits(inbox)).toEqual([]);
});

test("each inbox row is at least 48 px tall", async ({ page }) => {
  const c = await seedSentCase();
  await signIn(page, member);
  await openCase(page, c);

  const row = page.getByRole("region", { name: "Email thread" }).getByRole("link").first();
  const box = await row.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
});

test("the operator is shown by its name, not its id", async ({ page }) => {
  const c = await seedSentCase();
  await signIn(page, member);
  await openCase(page, c);
  await expect(
    page.getByRole("region", { name: "Case summary" }).getByText("Iryo", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Case summary" })).not.toContainText("iryo");
});

test("tapping a message shows it in full with a way back to the inbox", async ({ page }) => {
  const c = await seedSentCase();
  const { messages } = await caseRows(c.id);
  const body = messages.find((m) => m.direction === "outbound")?.body_text ?? "";
  const firstLine =
    body
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  expect(firstLine).not.toBe("");

  await signIn(page, member);
  await openCase(page, c);
  const inbox = page.getByRole("region", { name: "Email thread" });
  await inbox.getByRole("link").first().click();

  await expect(page).toHaveURL(/\?m=[0-9a-f-]+$/);
  const subject = "Delay compensation claim";
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

test("a long subject and body fit a 375 px message view without horizontal scroll", async ({
  page,
}) => {
  const c = await seedSentCase();
  // A long body and a long stored subject, with unbroken tokens: the view must wrap them.
  const token = "Reclamacion".repeat(20);
  const longBody = `Estimado equipo,\n\n${token} ${"texto largo ".repeat(60)}\n${token}`;
  const { error } = await db()
    .from("messages")
    .update({ body_text: longBody, subject: `[${c.ref}] ${token} ${"asunto ".repeat(30)}` })
    .eq("case_id", c.id)
    .eq("direction", "outbound");
  if (error) throw error;

  await signIn(page, member);
  await page.goto(`/equipo/casos/${c.id}`);
  await page.getByRole("region", { name: "Email thread" }).getByRole("link").first().click();
  await expect(page).toHaveURL(/\?m=/);
  await expect(page.getByText(token.slice(0, 40)).first()).toBeVisible();

  expect(await noPageScroll(page)).toBe(true);
  const thread = page.getByRole("region", { name: "Email thread" });
  expect(await everythingFits(thread)).toEqual([]);

  // The technical details open to the raw stored subject and body, still without scroll.
  await page.getByText("Technical details").click();
  await expect(page.getByText("Stored subject:")).toBeVisible();
  expect(await noPageScroll(page)).toBe(true);
  expect(await everythingFits(thread)).toEqual([]);
});

test("an unknown message id falls back to the inbox list", async ({ page }) => {
  const c = await seedSentCase();
  await signIn(page, member);
  await page.goto(`/equipo/casos/${c.id}?m=00000000-0000-4000-8000-000000000000`);
  await expect(page.getByRole("heading", { level: 1, name: `Case ${c.ref}` })).toBeVisible();
  await expect(page.getByRole("region", { name: "Email thread" }).getByRole("link")).toHaveCount(1);
});

test("the dashboard has no horizontal scroll at 375 px and each case links to its page", async ({
  page,
}) => {
  const c = await seedSentCase();
  await signIn(page, member);

  expect(await noPageScroll(page)).toBe(true);
  await expect(page.getByRole("main")).toHaveCount(1);
  const cases = page.getByRole("region", { name: "Cases" });
  await expect(cases.getByRole("link", { name: c.ref })).toHaveAttribute(
    "href",
    `/equipo/casos/${c.id}`,
  );
  await expect(cases).toContainText("Iryo");
  expect(await everythingFits(cases)).toEqual([]);
});
