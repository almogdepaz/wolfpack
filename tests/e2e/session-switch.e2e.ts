/**
 * Session switch — open drawer, switch between sessions, verify terminal updates.
 *
 * Uses mobile viewport which routes through /ws/pty unified terminal path.
 */
import { test, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let srv: TestServer;

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  srv?.close();
});

test("open session drawer from terminal view", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only viewport tests");
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  // Navigate into a session first (drawer chip only shows in terminal view)
  const card = page.locator(".card", { hasText: "test-project" }).first();
  await card.click();
  await expect(page.locator("#terminal-view")).toBeVisible();

  // Chip should display current session name
  const chip = page.locator("#session-chip");
  await expect(chip).toBeVisible();
  await expect(page.locator("#chip-label")).toHaveText("test-project");

  // Click chip to open drawer
  await chip.click();

  const drawer = page.locator("#session-drawer");
  await expect(drawer).toHaveClass(/open/);
});

test("desktop switchSession renders cached snapshot placeholder immediately", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only switch path");

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.evaluate(() => {
    localStorage.setItem(
      "wp-snap||another-project",
      JSON.stringify({ d: "cached-another-session", ts: Date.now() }),
    );
  });

  await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    openSession("test-project", "");
  });
  await expect(page.locator("#terminal-view")).toBeVisible();

  const immediateState = await page.evaluate(() => {
    // @ts-ignore exposed by the browser bundle
    switchSession("another-project");
    const container = document.getElementById("desktop-terminal-container");
    return {
      hasCachedClass: container?.classList.contains("cached-visible") ?? false,
      placeholder: container?.querySelector(".cached-terminal-placeholder")?.textContent ?? "",
    };
  });

  expect(immediateState).toEqual({
    hasCachedClass: true,
    placeholder: "cached-another-session",
  });
});

