import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers";
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
