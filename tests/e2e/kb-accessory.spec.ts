/**
 * Keyboard accessory row — verify sticky row renders on focus,
 * tap special keys (Tab, Esc, ^C, arrows) dispatches /api/key,
 * tap insert keys (|, /, ~, -) inserts text into textarea.
 *
 * Mobile-only: kb-accessory is hidden on desktop via CSS !important.
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

/** Navigate to terminal view for test-project and wait for WS output. */
async function openTerminal(page: import("@playwright/test").Page) {
  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });
  const card = page.locator(".card", { hasText: "test-project" }).first();
  await card.click();
  await expect(page.locator("#terminal")).toContainText("mock-terminal-ready", { timeout: 5000 });
}

test("kb-accessory appears when textarea is focused", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only kb-accessory");
  await openTerminal(page);

  const acc = page.locator("#kb-accessory");
  // Initially hidden (no .visible class until focus)
  await expect(acc).not.toHaveClass(/visible/);

  // Focus the textarea → accessory should appear
  await page.locator("#msg-input").focus();
  await expect(acc).toHaveClass(/visible/, { timeout: 2000 });

  // Verify expected keys are present
  await expect(acc.locator('[data-key="Tab"]')).toBeVisible();
  await expect(acc.locator('[data-key="Escape"]')).toBeVisible();
  await expect(acc.locator('[data-key="C-c"]')).toBeVisible();
  await expect(acc.locator('[data-key="Up"]')).toBeVisible();
  await expect(acc.locator('[data-key="Down"]')).toBeVisible();
  await expect(acc.locator('[data-key="Left"]')).toBeVisible();
  await expect(acc.locator('[data-key="Right"]')).toBeVisible();
});

test("tapping special keys dispatches POST /api/key", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only kb-accessory");
  await openTerminal(page);

  // Focus textarea to show accessory
  await page.locator("#msg-input").focus();
  await expect(page.locator("#kb-accessory")).toHaveClass(/visible/, { timeout: 2000 });

  // Keys to test: data-key value → expected key in POST body
  const keysToTest = ["Tab", "Escape", "C-c", "Up", "Down", "Left", "Right"];

  for (const key of keysToTest) {
    // Intercept the /api/key request
    const reqPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/api/key") &&
        req.method() === "POST" &&
        req.postDataJSON()?.key === key,
      { timeout: 3000 },
    );

    // Tap the button
    const btn = page.locator(`#kb-accessory [data-key="${key}"]`);
    await btn.click();

    // Verify the correct key was dispatched
    const req = await reqPromise;
    const body = req.postDataJSON();
    expect(body.session).toBe("test-project");
    expect(body.key).toBe(key);
  }
});

test("tapping insert keys types characters into textarea", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only kb-accessory");
  await openTerminal(page);

  const input = page.locator("#msg-input");
  await input.focus();
  await expect(page.locator("#kb-accessory")).toHaveClass(/visible/, { timeout: 2000 });

  // Tap insert keys in sequence: |, /, ~, -
  const insertChars = ["|", "/", "~", "-"];
  for (const char of insertChars) {
    await page.locator(`#kb-accessory [data-insert="${char}"]`).click();
  }

  // Textarea should contain all inserted characters
  await expect(input).toHaveValue("|/~-");
});

test("kb-accessory hides on textarea blur", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only kb-accessory");
  await openTerminal(page);

  const acc = page.locator("#kb-accessory");
  const input = page.locator("#msg-input");

  // Focus → visible
  await input.focus();
  await expect(acc).toHaveClass(/visible/, { timeout: 2000 });

  // Blur by clicking elsewhere (terminal div)
  await page.locator("#terminal").click();

  // Wait for the 150ms blur delay + class removal
  await expect(acc).not.toHaveClass(/visible/, { timeout: 2000 });
});

test("textarea retains focus after tapping accessory keys", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only kb-accessory");
  await openTerminal(page);

  const input = page.locator("#msg-input");
  await input.focus();
  await expect(page.locator("#kb-accessory")).toHaveClass(/visible/, { timeout: 2000 });

  // Tap Tab key — textarea should stay focused (mousedown preventDefault)
  await page.locator('#kb-accessory [data-key="Tab"]').click();

  // Accessory should still be visible (textarea didn't blur)
  await expect(page.locator("#kb-accessory")).toHaveClass(/visible/);

  // Tap an insert key — same behavior
  await page.locator('#kb-accessory [data-insert="|"]').click();
  await expect(page.locator("#kb-accessory")).toHaveClass(/visible/);
});
