import { expect, test } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(() => {
  server?.close();
});

test.beforeEach(async ({ page }) => {
  await page.goto(server.baseUrl);
  await expect(page.locator("#session-list .card").first()).toBeVisible();
});

test("desktop session shell uses named controls and bounded content", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop shell contract");

  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Collapse sessions" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Start a session on/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop another-project" })).toBeVisible();

  const sessionGroup = page.locator("#session-list .machine-group").first();
  await expect(sessionGroup).toBeVisible();
  expect((await sessionGroup.boundingBox())?.width).toBeLessThanOrEqual(960);
});

test("desktop collapsed sidebar has a visible keyboard-accessible handle", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop sidebar contract");

  await page.getByRole("button", { name: "Collapse sessions" }).click();
  await page.getByRole("button", { name: "Unpin sidebar" }).click();
  const handle = page.getByRole("button", { name: "Open sessions sidebar" });
  await expect(handle).toBeVisible();
  await handle.focus();
  await expect(handle).toBeFocused();
  await handle.press("Enter");
  await expect(page.locator("#desktop-sidebar")).not.toHaveClass(/collapsed/);
});

test("desktop grid actions expose intent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop grid contract");

  await page.getByRole("button", { name: "Collapse sessions" }).click();
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
