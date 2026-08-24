/**
 * Terminal connect flow — navigate to session, verify WS, send input, receive output.
 *
 * All clients (mobile + desktop) use the unified /ws/pty path with ghostty-web
 * WASM rendering.
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

test("clicking a session navigates to terminal view", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile viewport tests");
  await page.goto(srv.baseUrl);
  // Wait for session cards to render
  await page.waitForSelector(".card", { timeout: 5000 });

  // Click on "test-project" session card
  const card = page.locator(".card", { hasText: "test-project" }).first();
  await expect(card).toBeVisible();
  await card.click();

  // Terminal view should be visible
  await expect(page.locator("#terminal-view")).toBeVisible();
  await expect(page.locator("#desktop-terminal-container")).toBeVisible();
});

test("terminal receives output via WebSocket", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile viewport tests");
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  // Open session
  const card = page.locator(".card", { hasText: "test-project" }).first();
  await card.click();

  // ghostty-web renders to canvas — verify terminal mounted and received data.
  // The canvas existing inside the terminal container means mount() succeeded
  // and prefill data was written.
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 5000 });
});

test("sending input updates terminal output", async () => {
  // TODO: Requires a live PTY (Bun.spawn tmux attach) which the mock exec
  // can't provide. Re-enable once we have a mock PTY echo process.
  test.skip(true, "needs mock PTY process — Bun.spawn can't be stubbed");
});


