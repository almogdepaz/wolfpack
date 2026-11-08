import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
const noHorizontalScroll = () => document.documentElement.scrollWidth <= innerWidth;

test("a next row expands to its session details; the action acts without toggling; open survives a re-render", async ({ page }) => {
  // the mock backend reports no project path; give prompt-project one so the card shows it
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.sessions.find((s: { name: string }) => s.name === "prompt-project").identity.projectPath = "/home/dev/demo-app";
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  const row = block.locator(".focus-next li").filter({ hasText: "prompt-project" });
  const card = row.locator("details.focus-card");
  await expect(card).not.toHaveAttribute("open", /.*/);
  await row.locator("summary").click();
  await expect(card).toHaveAttribute("open", "");
  const body = card.locator(".focus-card-body");
  await expect(body.locator("[title='/home/dev/demo-app']")).toHaveText("demo-app");
  await expect(body).toContainText(/needs you · since \d+[mhd]|needs you · since now/);
  await expect(body).toContainText("Do you want to continue? (y/n)");
  await expect(body).toContainText("Needs you for this intention");
  await expect(body).toContainText("ship the focus assistant");
  expect((await new AxeBuilder({ page }).include("#dashboard-focus").analyze()).violations).toEqual([]);
  expect(await page.evaluate(noHorizontalScroll)).toBe(true);
  // a focus write bumps the revision; the next poll re-renders the block and the card stays open
  const current = await (await page.request.get(`${server.baseUrl}/api/focus`)).json();
  expect((await page.request.post(`${server.baseUrl}/api/focus`, { data: { expectedRevision: current.revision, ops: [{ type: "nudge", text: "Answer prompt-project, then ship.", author: "assistant" }] } })).ok()).toBe(true);
  await expect(block).toContainText("Answer prompt-project, then ship.", { timeout: 15_000 });
  await expect(card).toHaveAttribute("open", "");
  // keyboard: the summary toggles natively; the action follows it in the tab order
  await row.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(card).not.toHaveAttribute("open", /.*/);
  await page.keyboard.press("Space");
  await expect(card).toHaveAttribute("open", "");
  await page.keyboard.press("Tab");
  await expect(row.getByRole("button", { name: /prompt-project/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
});

test("today intentions expand to their details; the checkbox and chips work without toggling the card", async ({ page }) => {
  await page.goto(server.baseUrl);
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-view");
  const item = view.locator(".focus-today li").filter({ hasText: "fix broker leak" });
  const card = item.locator("details.focus-card");
  await view.getByRole("checkbox", { name: "Done: fix broker leak" }).check();
  await expect(view).toContainText("2 of 3 done");
  await expect(view.locator(".focus-today details.focus-card[open]")).toHaveCount(0);
  await view.locator(".focus-done").getByRole("button", { name: "Undo done: fix broker leak" }).click();
  await expect(view).toContainText("1 of 3 done");
  await item.locator("summary").click();
  await expect(card).toHaveAttribute("open", "");
  await expect(card.locator(".focus-card-body")).toContainText(/sessions\s*none yet/);
  await expect(card.locator(".focus-card-body")).toContainText(/added\s*\w+ \d+, \d\d:\d\d/);
  const linked = view.locator(".focus-today li").filter({ hasText: "ship the focus assistant" });
  await linked.locator("summary").click();
  await expect(linked.locator(".focus-card-body")).toContainText("prompt-project");
  await expect(linked.locator(".focus-card-body")).toContainText("another-project");
  // the next-row card for the same session is a separate card on this page; both stay open across a poll
  await view.locator(".focus-next li").filter({ hasText: "prompt-project" }).locator("summary").click();
  await expect(view.locator("details.focus-card[open]")).toHaveCount(3);
  expect((await new AxeBuilder({ page }).include("#assistant-view").analyze()).violations).toEqual([]);
  expect(await page.evaluate(noHorizontalScroll)).toBe(true);
  await page.waitForTimeout(6000);
  await expect(view.locator("details.focus-card[open]")).toHaveCount(3);
  await linked.locator(".focus-chips").getByRole("button", { name: "another-project" }).click();
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
});
