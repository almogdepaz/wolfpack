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
  await expect(page.locator(".card").first()).toBeVisible();
});

test("only the active view participates in keyboard focus", async ({ page }) => {
  await expect(page.locator("#sessions-view")).not.toHaveAttribute("inert", "");
  for (const id of ["projects-view", "agent-view", "settings-view", "terminal-view"]) {
    await expect(page.locator(`#${id}`)).toHaveAttribute("inert", "");
    await expect(page.locator(`#${id}`)).toHaveAttribute("aria-hidden", "true");
  }

  await expect(page.getByRole("button", { name: "Open another-project" })).toBeVisible();
  await page.getByRole("button", { name: /Start a session on/ }).first().click();

  await expect(page.locator("#projects-view")).not.toHaveAttribute("inert", "");
  await expect(page.locator("#sessions-view")).toHaveAttribute("inert", "");
  await expect(page.locator("#new-project-name")).toBeFocused();
  await expect(page.getByRole("button", { name: /^Open project / }).first()).toBeVisible();
});

test("mobile settings moves focus into the view and restores its trigger", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile header focus contract");

  const settings = page.locator("#gear-btn");
  await settings.focus();
  await settings.press("Enter");

  await expect(page.locator("#settings-view")).toHaveClass(/visible/);
  await expect(page.locator("#back-btn")).toBeFocused();
  await page.locator("#back-btn").press("Enter");
  await expect(settings).toBeFocused();
});

test("mobile magnification and larger terminal type remain available", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile accessibility contract");

  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewport).not.toContain("user-scalable=no");
  expect(viewport).not.toContain("maximum-scale=1");

  await page.locator("#gear-btn").click();
  await expect(page.getByRole("button", { name: "Extra large 18px" })).toBeVisible();
});

test("connection and asynchronous settings feedback expose status semantics", async ({ page }) => {
  await expect(page.locator("#conn-status")).toHaveAttribute("role", "status");
  await expect(page.locator("#conn-status")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator("#discover-status")).toHaveAttribute("role", "status");
  await expect(page.locator("#agent-add-error")).toHaveAttribute("role", "alert");
});

test("terminal transcript exposes authoritative plain text without a second parser", async ({ page }) => {
  await page.getByRole("button", { name: "Open test-project" }).click();
  await expect(page.locator("#terminal-view")).toHaveClass(/visible/);

  await page.getByRole("button", { name: "Read session transcript" }).click();
  const dialog = page.getByRole("dialog", { name: "Session transcript" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("log")).toContainText("mock-terminal-ready");

  await dialog.getByRole("button", { name: "Close transcript" }).click();
  await expect(dialog).toBeHidden();
});
