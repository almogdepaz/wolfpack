import { expect, test } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server?.close();
});

test.beforeEach(async ({ page }) => {
  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Open another-project" }).first()).toBeVisible();
});

test("desktop session shell uses named controls and bounded content", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop shell contract");

  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Expand sessions" }).click();
  await expect(page.getByRole("button", { name: "Collapse sessions" })).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/sessions-expanded/);
  await expect(page.locator("#desktop-sidebar")).toHaveClass(/collapsed/);
  await expect(page.getByRole("button", { name: /Start a session on/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop another-project" })).toBeVisible();

  const sessionGroup = page.locator("#session-list .machine-group").first();
  await expect(sessionGroup).toBeVisible();
  expect((await sessionGroup.boundingBox())?.width).toBeLessThanOrEqual(960);
});

test("desktop first load shows the sessions overview beside a default-pinned sidebar", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop sidebar contract");

  expect(await page.evaluate(() => localStorage.getItem("wolfpack-sidebar-pinned"))).toBeNull();
  const sidebar = page.locator("#desktop-sidebar");
  const sessionsView = page.locator("#sessions-view");
  await expect(page.locator("body")).not.toHaveClass(/sessions-expanded/);
  await expect(sidebar).toBeVisible();
  await expect(sidebar).not.toHaveClass(/collapsed/);
  await expect(sidebar).toHaveAttribute("aria-hidden", "false");
  await expect(page.getByRole("button", { name: "Unpin sidebar" })).toBeVisible();
  await expect(sessionsView).toBeVisible();
  await expect(page.getByRole("button", { name: "Open another-project" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Start a session on/ })).toHaveCount(1);
  await expect(page.locator("#session-list .card").first()).toBeHidden();
  await expect(page.locator("#sidebar-session-list .card").first()).toBeVisible();

  const layout = await page.evaluate(() => {
    const sidebarElement = document.getElementById("desktop-sidebar");
    const sessionsElement = document.getElementById("sessions-view");
    if (!sidebarElement || !sessionsElement) throw new Error("desktop sessions layout is incomplete");
    const sidebarBox = sidebarElement.getBoundingClientRect();
    const sessionsBox = sessionsElement.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      sidebarRight: sidebarBox.right,
      sessionsLeft: sessionsBox.left,
      sessionsRight: sessionsBox.right,
      viewportWidth: window.innerWidth,
    };
  });
  expect(layout.sidebarRight).toBeLessThanOrEqual(layout.sessionsLeft);
  expect(layout.sessionsRight).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.scrollWidth).toBe(layout.viewportWidth);
});

test("desktop sidebar restores saved unpin and pin choices after reload", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop sidebar contract");

  const sidebar = page.locator("#desktop-sidebar");
  await expect(page.getByRole("button", { name: "Unpin sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Unpin sidebar" }).click();
  await expect(sidebar).toHaveClass(/collapsed/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("wolfpack-sidebar-pinned"))).toBe("0");

  const hoverEdge = page.locator("#sidebar-hover-edge");
  expect(await hoverEdge.evaluate((element) => element.childElementCount)).toBe(0);
  expect((await hoverEdge.boundingBox())?.width).toBeLessThanOrEqual(8);

  await page.reload();
  await expect(page.locator("#session-list .card").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Open another-project" })).toHaveCount(1);
  await expect(page.locator("body")).not.toHaveClass(/sessions-expanded/);
  await expect(sidebar).toHaveClass(/collapsed/);
  await page.mouse.move(1, 100);
  await expect(page.getByRole("button", { name: "Pin sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Pin sidebar" }).click();
  await expect(sidebar).not.toHaveClass(/collapsed/);
  await expect(page.getByRole("button", { name: "Open another-project" })).toHaveCount(1);
  await expect(page.locator("#session-list .card").first()).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("wolfpack-sidebar-pinned"))).toBe("1");

  await page.reload();
  await expect(page.getByRole("button", { name: "Open another-project" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Open another-project" })).toHaveCount(1);
  await expect(page.locator("#session-list .card").first()).toBeHidden();
  await expect(page.locator("body")).not.toHaveClass(/sessions-expanded/);
  await expect(sidebar).not.toHaveClass(/collapsed/);
  await expect(page.getByRole("button", { name: "Unpin sidebar" })).toBeVisible();
});

test("desktop grid actions expose intent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop grid contract");

  await page.getByRole("button", { name: "Add to grid: another-project" }).click();
  await page.getByRole("button", { name: "Add to grid: error-project" }).click();
  await expect(page.getByRole("button", { name: "Remove another-project from grid" })).toBeVisible();
});

test("mobile session and terminal controls fit and expose intent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile shell contract");

  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Start a session on/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop another-project" })).toBeVisible();

  const settingsBox = await page.getByRole("button", { name: "Settings" }).boundingBox();
  expect(settingsBox?.width).toBeGreaterThanOrEqual(44);
  expect(settingsBox?.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));

  await page.locator(".card", { hasText: "another-project" }).click();
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);
  await expect(page.getByRole("button", { name: "Enter" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Escape" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Arrow up" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy session" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show keyboard" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));
});
