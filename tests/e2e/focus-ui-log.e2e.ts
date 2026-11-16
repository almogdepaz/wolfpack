import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";
import { FOCUS_UI_ACTION as A, FOCUS_UI_CARD as C, FOCUS_UI_INTENTION as I, type FocusUiRow } from "../../src/focus-ui-log";
let server: TestServer;
test.beforeEach(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterEach(async () => { await server?.close(); });
function journal(): { text: string; rows: FocusUiRow[] } {
  const dir = join(server.home, ".wolfpack", "focus-ui");
  let text = "";
  try { text = readdirSync(dir).filter(n => n.endsWith(".jsonl")).sort().map(n => readFileSync(join(dir, n), "utf8")).join(""); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { text, rows: text.trim() ? text.trim().split("\n").map(s => JSON.parse(s)) : [] };
}
test("real focus controls write ordered content-free rows, deduplicate refreshes, and flush leave", async ({ page }) => {
  const secretTitle = "PRIVATE_INTENTION_CANARY";
  const secretReply = "PRIVATE_REPLY_CANARY";
  const secretPreview = "PRIVATE_PREVIEW_CANARY";
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(); const body = await response.json();
    body.sessions.find((s: { name: string }) => s.name === "prompt-project").lastLine = secretPreview;
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const content = page.locator("#assistant-content");
  const row = content.locator(".focus-next > li").filter({ hasText: "prompt-project" });
  await row.locator(".focus-card > summary").click();
  await expect(row.locator(".focus-card")).toHaveAttribute("open", "");
  await expect.poll(() => journal().rows.some(r => r.action === A.CARD && r.control === C.EXPAND && r.session === "prompt-project")).toBe(true);
  const shownBefore = journal().rows.filter(r => r.action === A.SHOWN).length;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(content.locator(".focus-header")).toBeVisible();
  // The next real click batches after that refresh, proving refresh did not add an exposure.
  await content.getByRole("textbox", { name: "Add an intention", exact: true }).fill(secretTitle);
  await content.getByRole("button", { name: "Add", exact: true }).click();
  await expect(content.getByRole("checkbox", { name: `Done: ${secretTitle}` })).toBeVisible();
  await expect.poll(() => journal().rows.some(r => r.action === A.INTENTION && r.control === I.ADD)).toBe(true);
  expect(journal().rows.filter(r => r.action === A.SHOWN)).toHaveLength(shownBefore);
  await content.getByRole("checkbox", { name: `Done: ${secretTitle}` }).click();
  await expect(content.locator(".focus-done")).toContainText(secretTitle);
  await row.getByRole("textbox", { name: "reply to prompt-project", exact: true }).fill(secretReply);
  await row.getByRole("button", { name: "Send to prompt-project", exact: true }).click();
  await expect.poll(() => journal().rows.some(r => r.action === A.CARD && r.control === C.REPLY)).toBe(true);
  await row.getByRole("button", { name: "Open prompt-project", exact: true }).click();
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
  await expect.poll(() => journal().rows.some(r => r.action === A.LEFT)).toBe(true);
  const { rows, text } = journal();
  const shown = rows.find(r => r.action === A.SHOWN);
  expect(shown?.action === A.SHOWN && shown.cards.some(c => c.session === "prompt-project" && c.rank > 0)).toBe(true);
  expect(rows.some(r => r.action === A.OPEN)).toBe(true);
  expect(rows.some(r => r.action === A.VIEW && r.docked)).toBe(true);
  expect(rows.some(r => r.action === A.CARD && r.control === C.OPEN)).toBe(true);
  expect(rows.some(r => r.action === A.INTENTION && r.control === I.DONE)).toBe(true);
  expect(rows.find(r => r.action === A.LEFT)).toMatchObject({ visibleMs: expect.any(Number) });
  expect(rows.map(r => r.seq)).toEqual(rows.map((_, index) => index + 1));
  for (const secret of [secretTitle, secretReply, secretPreview, "ship the focus assistant", "Do you want to continue?"]) expect(text).not.toContain(secret);
});
