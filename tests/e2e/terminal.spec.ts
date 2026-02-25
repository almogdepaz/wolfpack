/**
 * Terminal connect flow — navigate to session, verify WS, send input, receive output.
 *
 * Uses mobile viewport (iphone-se / iphone-14) which routes through /ws/terminal
 * capture-pane polling. Desktop uses /ws/pty (separate handler, not tested here).
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
  test.skip(testInfo.project.name === "desktop", "mobile-only /ws/terminal flow");
  await page.goto(srv.baseUrl);
  // Wait for session cards to render
  await page.waitForSelector(".card", { timeout: 5000 });

  // Click on "test-project" session card
  const card = page.locator(".card", { hasText: "test-project" }).first();
  await expect(card).toBeVisible();
  await card.click();

  // Terminal view should be visible
  await expect(page.locator("#terminal-view")).toBeVisible();
  await expect(page.locator("#terminal")).toBeVisible();
});

test("terminal receives output via WebSocket", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only /ws/terminal flow");
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  // Open session
  const card = page.locator(".card", { hasText: "test-project" }).first();
  await card.click();

  // Wait for mock pane content to appear in terminal div
  const terminal = page.locator("#terminal");
  await expect(terminal).toContainText("mock-terminal-ready", { timeout: 5000 });
});

test("sending input updates terminal output", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only /ws/terminal flow");
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  // Open session
  const card = page.locator(".card", { hasText: "test-project" }).first();
  await card.click();

  // Wait for initial output
  const terminal = page.locator("#terminal");
  await expect(terminal).toContainText("mock-terminal-ready", { timeout: 5000 });

  // Type a command in the input bar
  const input = page.locator("#msg-input");
  await input.fill("echo hello");

  // Submit via the send button
  const sendBtn = page.locator("#send-btn");
  await sendBtn.click();

  // The mock tmuxSend appends "$ echo hello\ncommand-output\n" to pane content.
  // WS poll picks it up within ~100ms and pushes to client.
  await expect(terminal).toContainText("command-output", { timeout: 5000 });
});

test("action bar keys are visible in terminal view", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only /ws/terminal flow");
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  const card = page.locator(".card", { hasText: "test-project" }).first();
  await card.click();

  // Action bar with Enter, Esc, arrows, Ctrl+C should be visible on mobile
  const actionBar = page.locator("#action-bar");
  await expect(actionBar).toBeVisible();
  await expect(page.locator("#action-bar .primary")).toContainText("Enter");
});
