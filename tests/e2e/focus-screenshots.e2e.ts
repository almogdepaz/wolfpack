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
    // the assistant card has its own full-width row under the filter
    expect(measures.tile.y).toBeGreaterThanOrEqual(measures.filter.y + measures.filter.height);
    expect(Math.round(measures.tile.width)).toBe(Math.round(measures.filter.width));
    expect(measures.tile.height).toBeGreaterThanOrEqual(44);
    expect((await new AxeBuilder({ page }).include("#sidebar-session-controls").include("#assistant-terminal-header").analyze()).violations).toEqual([]);
  }
  await page.screenshot({ path: join(screenshots, `focus-terminal-${desktop ? 1440 : 390}.png`), fullPage: true });
});

test("QA layout: fixed disclosure/action columns, full-width bodies, shared controls and phone targets", async ({ page }, info) => {
  const desktop = info.project.name === "desktop";
  const width = desktop ? 1440 : 390;
  await page.setViewportSize({ width, height: desktop ? 900 : 844 });
  await page.addInitScript(() => localStorage.setItem("wolfpack-sidebar-pinned", "1"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route(url => url.pathname === "/api/focus", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.document.intentions.push({ id: "one-chip", title: "one linked session", createdAt: new Date().toISOString(), done: false, sessions: ["mock:test-project"] });
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const session = body.sessions.find((s: { name: string }) => s.name === "another-project");
    session.runtimeState = { ...session.runtimeState, state: "done", changedAt: new Date().toISOString(), authority: "program", stale: false };
    await route.fulfill({ response, json: body });
  });
  await page.goto(server.baseUrl);
  const block = page.locator("#dashboard-focus");
  await expect(block.locator(".focus-next > li")).toHaveCount(3);
  if (!desktop) {
    const box = (await block.getByRole("button", { name: "Open assistant", exact: true }).boundingBox())!;
    expect.soft(box.height, "QA-8 dashboard assistant target").toBeGreaterThanOrEqual(44);
  }
  const row = block.locator(".focus-next > li").first();
  await row.locator("summary").click();
  const edges = await row.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return { body: el.querySelector(".focus-card-body")!.getBoundingClientRect().right, right: rect.right - parseFloat(getComputedStyle(el).paddingRight) };
  });
  expect.soft(Math.abs(edges.body - edges.right), "QA-9 opened body fills the row inset").toBeLessThanOrEqual(1);
  const shots = join(process.cwd(), process.env.WOLFPACK_FOCUS_SHOTS ?? ".plans/screenshots");
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `qa-layout-dashboard-open-${width}.png`), fullPage: true });
  await row.locator("summary").click();
  await block.getByRole("button", { name: "Open assistant", exact: true }).click();
  const view = page.locator("#assistant-content");
  await expect(view.locator(".focus-today > li")).toHaveCount(3);
  const aligned = (values: number[]) => Math.max(...values) - Math.min(...values);
  const today = await view.locator(".focus-today > li > .focus-card > summary").evaluateAll(els => els.map(el => el.getBoundingClientRect().right));
  expect.soft(aligned(today), "QA-6 today chevrons share a column with 0, 1 and 2 chips").toBeLessThanOrEqual(1);
  const chips = await view.locator(".focus-chips:not(:empty)").evaluateAll(els => els.map(el => el.getBoundingClientRect().right));
  expect.soft(aligned(chips), "QA-6 chip groups share a right edge").toBeLessThanOrEqual(1);
  const next = await view.locator(".focus-next > li > .focus-card > summary").evaluateAll(els => els.map(el => el.getBoundingClientRect().right));
  expect.soft(aligned(next), "QA-7 open and start share a disclosure column").toBeLessThanOrEqual(1);
  if (!desktop) {
    const targets = view.locator("details:not(.focus-card) > summary, .focus-chips button, .focus-done button");
    expect(await targets.count()).toBeGreaterThanOrEqual(5);
    for (const target of await targets.all()) {
      const box = (await target.boundingBox())!;
      expect.soft(box.height, `QA-8 ${await target.textContent()} height`).toBeGreaterThanOrEqual(44);
      expect.soft(box.width, `QA-8 ${await target.textContent()} width`).toBeGreaterThanOrEqual(44);
    }
  }
  if (desktop) {
    const heights = await view.locator(".focus-today > li, .focus-next > li").evaluateAll(els => els.map(el => el.getBoundingClientRect().height));
    for (const height of heights) expect.soft(height, "desktop compact rows stay 44px plus hairline").toBeLessThanOrEqual(45);
  }
  await page.screenshot({ path: join(shots, `qa-layout-assistant-${width}.png`), fullPage: true });
  // Opening one intention must not move its disclosure, and its body may span the chip column.
  await view.locator(".focus-today summary").first().click();
  const openToday = await view.locator(".focus-today > li > .focus-card > summary").evaluateAll(els => els.map(el => el.getBoundingClientRect().right));
  expect.soft(aligned(openToday), "QA-6 open and closed today disclosures align").toBeLessThanOrEqual(1);
  await view.locator(".focus-today summary").first().click();
  await page.getByRole("button", { name: "Talk to assistant" }).click();
  if (desktop) {
    const surfaces = await page.evaluate(() => ["#sidebar-session-filter .seg", "#sidebar-assistant"].map(selector => {
      const style = getComputedStyle(document.querySelector(selector)!);
      return { radius: style.borderRadius, padding: style.padding };
    }));
    expect.soft(surfaces[1], "QA-16 filter and launcher share padding and radius tokens").toEqual(surfaces[0]);
  }
  await page.locator("#assistant-terminal-header").getByRole("button", { name: "Focus", exact: true }).click();
  await view.getByRole("button", { name: "Assistant settings" }).click();
  const form = page.locator("#assistant-timing");
  const save = (await form.getByRole("button", { name: "Save timing", exact: true }).boundingBox())!;
  const formBox = (await form.boundingBox())!;
  if (desktop) expect.soft(save.width, "QA-3 timing secondary button is content width").toBeLessThan(formBox.width / 2);
  else expect.soft(Math.abs(save.width - formBox.width)).toBeLessThanOrEqual(1);
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
