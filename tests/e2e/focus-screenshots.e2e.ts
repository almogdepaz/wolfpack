import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";
import { v3, withContext } from "./focus-context-fixture";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ focusAssistant: true }); });
test.afterAll(async () => { await server?.close(); });
test("needs-you state header opens the assistant terminal while the tile opens the view", async ({ page }) => {
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.assistant.state = "needs-input";
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  // the dashboard block carries the same amber "needs you · answer ›" control, straight to the terminal
  await expect(page.locator("#dashboard-focus .focus-header").getByRole("button", { name: /needs you · answer/ })).toBeVisible();
  await page.locator("#dashboard-focus").getByRole("button", { name: "Open assistant page", exact: true }).click();
  await expect(page.locator("#assistant-view")).toBeVisible();
  await page.locator("#assistant-content .focus-header").getByRole("button", { name: /needs you · answer/ }).click();
  await expect(page.locator("#terminal-view")).toBeVisible();
  await expect(page.locator("#assistant-terminal-header")).toBeVisible();
});

test("focus screenshot and layout evidence", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  await page.setViewportSize({ width: desktop ? 1440 : 390, height: desktop ? 900 : 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block).toContainText("Ship the focus assistant today");
  await expect(block.getByRole("button", { name: /prompt-project/ })).toBeVisible();
  expect((await new AxeBuilder({ page }).include("#dashboard-focus").analyze()).violations).toEqual([]);
  const screenshots = join(process.cwd(), process.env.WOLFPACK_FOCUS_SHOTS ?? ".plans/screenshots");
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, `focus-dashboard-${desktop ? 1440 : 390}.png`), fullPage: true });
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  await expect(page.locator("#assistant-view")).toBeVisible();
  await expect(page.locator("#assistant-view")).toContainText("1 of 3 done");
  expect((await new AxeBuilder({ page }).include("#assistant-view").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(screenshots, `focus-assistant-${desktop ? 1440 : 390}.png`), fullPage: true });
  await page.getByRole("button", { name: "Talk to assistant" }).click();
  await expect(page.locator("#assistant-terminal-header")).toBeVisible();
  await expect(page.locator("#desktop-terminal-container canvas").first()).toBeVisible();
  if (desktop) {
    await expect(page.locator("#sidebar-assistant")).toBeVisible();
    const measures = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector)!;
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, x: rect.x, y: rect.y };
      };
      return { sidebar: box("#desktop-sidebar"), controls: box("#sidebar-session-controls"), filter: box("#sidebar-session-filter"), tile: box("#sidebar-assistant") };
    });
    writeFileSync(join(screenshots, "focus-layout-measurements.json"), JSON.stringify(measures, null, 2));
    expect(measures.tile.height).toBe(measures.filter.height);
    expect(measures.tile.y).toBe(measures.filter.y);
    expect((await new AxeBuilder({ page }).include("#sidebar-session-controls").include("#assistant-terminal-header").analyze()).violations).toEqual([]);
  }
  await page.screenshot({ path: join(screenshots, `focus-terminal-${desktop ? 1440 : 390}.png`), fullPage: true });
});

test("focus card captures: a session card open with and without the agent's context, an intention card", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  const width = desktop ? 1440 : 390;
  await page.setViewportSize({ width, height: desktop ? 900 : 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  let contextDocument: unknown = v3;
  await withContext(page, () => contextDocument);
  const screenshots = join(process.cwd(), process.env.WOLFPACK_FOCUS_SHOTS ?? ".plans/screenshots");
  mkdirSync(screenshots, { recursive: true });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  const row = block.locator(".focus-next li").filter({ hasText: "prompt-project" });
  await row.locator(".focus-card > summary").click();
  await expect(row.locator(".focus-context")).toBeVisible();
  await expect(row.locator(".focus-context")).toContainText("Ship the focus cards round");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include("#dashboard-focus").analyze()).violations).toEqual([]);
  await page.screenshot({ path: join(screenshots, `focus-card-context-dashboard-${width}.png`), fullPage: true });
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-view");
  // open state is per card, shared by the dashboard block and the page: the card opened above is open here too
  await expect(view.locator(".focus-next li").filter({ hasText: "prompt-project" }).locator("details.focus-card")).toHaveAttribute("open", "");
  await view.locator(".focus-today li").filter({ hasText: "ship the focus assistant" }).locator(".focus-card > summary").click();
  await expect(view.locator(".focus-context")).toBeVisible();
  await expect(view.locator(".focus-context")).toContainText("Wire the context block");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include("#assistant-view").analyze()).violations).toEqual([]);
  await page.screenshot({ path: join(screenshots, `focus-card-context-assistant-${width}.png`), fullPage: true });
  // the same session with no document: the card shows only what the dashboard already knows
  contextDocument = null;
  await expect(view.locator(".focus-context")).toHaveCount(0, { timeout: 15_000 });
  await page.screenshot({ path: join(screenshots, `focus-card-plain-assistant-${width}.png`), fullPage: true });
});
