import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";
import { FOCUS_UI_ACTION as A, FOCUS_UI_CARD as C, FOCUS_UI_INTENTION as I, FOCUS_UI_ASSISTANT as AS, FOCUS_UI_SETTINGS as S, type FocusUiRow } from "../../src/focus-ui-log";
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
  expect(rows.find(r => r.action === A.VIEW)).toMatchObject({ docked: page.viewportSize()!.width >= 1280 });
  expect(rows.some(r => r.action === A.CARD && r.control === C.OPEN)).toBe(true);
  expect(rows.some(r => r.action === A.INTENTION && r.control === I.DONE)).toBe(true);
  expect(rows.find(r => r.action === A.LEFT)).toMatchObject({ visibleMs: expect.any(Number) });
  expect(rows.map(r => r.seq)).toEqual(rows.map((_, index) => index + 1));
  for (const secret of [secretTitle, secretReply, secretPreview, "ship the focus assistant", "Do you want to continue?"]) expect(text).not.toContain(secret);
});

test("shown kind matches the rendered reply-ready card, not its underlying attention classification", async ({ page }) => {
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  const sessions = await (await page.request.get(`${server.baseUrl}/api/sessions`)).json();
  const session = sessions.sessions.find((s: { name: string }) => s.name === "prompt-project");
  const updated = await page.request.post(`${server.baseUrl}/api/focus`, { data: { expectedRevision: current.revision, ops: [{ type: "next", author: "assistant", rows: [{ ref: { machine: current.installationId, sessionId: "mock:prompt-project" }, stoppedAt: session.runtimeState.stoppedAt ?? session.runtimeState.changedAt, verdict: "suggest", reason: "PRIVATE_REASON_CANARY", suggestion: "PRIVATE_SUGGESTION_CANARY" }] }] } });
  expect(updated.ok(), await updated.text()).toBe(true);
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  const row = page.locator("#assistant-content .focus-next > li").filter({ hasText: "prompt-project" });
  await expect(row).toHaveAttribute("data-kind", "suggest");
  await expect.poll(() => journal().rows.flatMap(r => r.action === A.SHOWN ? r.cards : []).find(c => c.session === "prompt-project")?.kind).toBe("suggest");
  expect(journal().text).not.toContain("PRIVATE_REASON_CANARY");
  expect(journal().text).not.toContain("PRIVATE_SUGGESTION_CANARY");
});

test("assistant pane, reply-to-chat, settings and visibility segments are journaled without terminal/take content", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "embedded pane controls require desktop");
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  expect((await page.request.post(`${server.baseUrl}/api/focus`, { data: { expectedRevision: current.revision, ops: [{ type: "next", rows: [], author: "assistant", take: { text: "PRIVATE_TAKE_CANARY", about: [] } }] } })).ok()).toBe(true);
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await page.getByRole("button", { name: "Talk to assistant", exact: true }).click();
  await expect(page.locator("#assistant-pty")).toHaveClass(/hydrated/);
  await page.getByRole("button", { name: "Focus terminal", exact: true }).click();
  await page.getByRole("button", { name: "Hide assistant terminal", exact: true }).click();
  await page.locator("#assistant-content .focus-take").getByRole("button", { name: "Reply to assistant", exact: true }).click();
  await page.locator("#assistant-content").getByRole("button", { name: "Assistant settings", exact: true }).click();
  await page.getByRole("button", { name: "Inspect background terminal", exact: true }).click();
  await expect(page.locator("#assistant-pane-role")).toHaveText("background");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => journal().rows.filter(r => r.action === A.LEFT).length).toBe(2);
  const { rows, text } = journal();
  for (const control of [AS.TALK, AS.REPLY, AS.SHOW, AS.HIDE, AS.FOCUS]) expect(rows.some(r => r.action === A.ASSISTANT && r.control === control), control).toBe(true);
  for (const control of [S.OPEN, S.BACKGROUND]) expect(rows.some(r => r.action === A.SETTINGS && r.control === control), control).toBe(true);
  expect(rows.filter(r => r.action === A.OPEN)).toHaveLength(2);
  expect(text).not.toContain("PRIVATE_TAKE_CANARY");
  expect(text).not.toContain("mock-terminal-ready");
});
