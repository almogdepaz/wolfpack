/**
 * Session switch — open drawer, switch between sessions, verify terminal updates.
 *
 * Uses mobile viewport which routes through /ws/terminal capture-pane polling.
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
  test.skip(testInfo.project.name === "desktop", "mobile-only /ws/terminal flow");
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

test("drawer lists all available sessions", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only /ws/terminal flow");
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  // Enter terminal view
  await page.locator(".card", { hasText: "test-project" }).first().click();
  await expect(page.locator("#terminal-view")).toBeVisible();

  // Open drawer, switch to "All" tab to see every session
  await page.locator("#session-chip").click();
  await expect(page.locator("#session-drawer")).toHaveClass(/open/);

  await page.locator('.drawer-tab[data-tab="all"]').click();

  // All mock sessions should appear
  const items = page.locator(".drawer-item");
  await expect(items).toHaveCount(4);
  await expect(items.filter({ hasText: "test-project" })).toHaveCount(1);
  await expect(items.filter({ hasText: "another-project" })).toHaveCount(1);
  await expect(items.filter({ hasText: "prompt-project" })).toHaveCount(1);
  await expect(items.filter({ hasText: "error-project" })).toHaveCount(1);
});

test("current session is highlighted in drawer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only /ws/terminal flow");
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.locator(".card", { hasText: "test-project" }).first().click();
  await expect(page.locator("#terminal-view")).toBeVisible();

  // Open drawer → All tab
  await page.locator("#session-chip").click();
  await page.locator('.drawer-tab[data-tab="all"]').click();

  // Current session should have .current class
  const currentItem = page.locator('.drawer-item.current');
  await expect(currentItem).toHaveCount(1);
  await expect(currentItem.locator(".drawer-item-name")).toHaveText("test-project");
});

test("switch session via drawer updates terminal content", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only /ws/terminal flow");
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  // Open test-project, verify its terminal content
  await page.locator(".card", { hasText: "test-project" }).first().click();
  const terminal = page.locator("#terminal");
  await expect(terminal).toContainText("mock-terminal-ready", { timeout: 5000 });

  // Open drawer → All tab → click another-project
  await page.locator("#session-chip").click();
  await page.locator('.drawer-tab[data-tab="all"]').click();

  const otherItem = page.locator(".drawer-item", { hasText: "another-project" });
  await expect(otherItem).toBeVisible();
  await otherItem.click();

  // Drawer should close
  await expect(page.locator("#session-drawer")).not.toHaveClass(/open/);

  // Terminal should now show another-project's pane content
  await expect(terminal).toContainText("idle", { timeout: 5000 });

  // Chip label should update
  await expect(page.locator("#chip-label")).toHaveText("another-project");
});

test("switch session then send input targets new session", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only /ws/terminal flow");
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  // Start in test-project
  await page.locator(".card", { hasText: "test-project" }).first().click();
  await expect(page.locator("#terminal")).toContainText("mock-terminal-ready", { timeout: 5000 });

  // Switch to another-project via drawer
  await page.locator("#session-chip").click();
  await page.locator('.drawer-tab[data-tab="all"]').click();
  await page.locator(".drawer-item", { hasText: "another-project" }).click();
  await expect(page.locator("#terminal")).toContainText("idle", { timeout: 5000 });

  // Send a command — should go to another-project, not test-project
  await page.locator("#msg-input").fill("whoami");
  await page.locator("#send-btn").click();

  // Mock tmux appends "$ whoami\ncommand-output\n" to another-project's pane
  await expect(page.locator("#terminal")).toContainText("command-output", { timeout: 5000 });

  // Verify test-project's content was NOT mutated (no "whoami" in it)
  // Switch back to test-project to confirm
  await page.locator("#session-chip").click();
  await page.locator('.drawer-tab[data-tab="all"]').click();
  await page.locator(".drawer-item", { hasText: "test-project" }).click();
  await expect(page.locator("#terminal")).toContainText("mock-terminal-ready", { timeout: 5000 });
  // test-project should NOT contain the whoami command output
  await expect(page.locator("#terminal")).not.toContainText("whoami", { timeout: 2000 });
});
