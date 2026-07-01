import { test, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let srv: TestServer;

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  srv?.close();
});

test("mobile accessory Enter inserts line-feed while native Enter still sends carriage-return", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only accessory keyboard behavior");

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.locator(".card", { hasText: "test-project" }).first().click();
  await expect(page.locator("#terminal-view")).toBeVisible();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 5000 });

  await page.evaluate(() => {
    const win = window as unknown as {
      __sentBytes: number[][];
      state: { terminalController: { send: (bytes: Uint8Array) => void; isConnected: boolean } };
    };
    win.__sentBytes = [];
    win.state.terminalController.send = (bytes: Uint8Array) => {
      win.__sentBytes.push(Array.from(bytes));
    };
    Object.defineProperty(win.state.terminalController, "isConnected", {
      configurable: true,
      value: true,
    });
  });

  await page.locator("#kb-open-btn").click();
  await expect(page.locator("#mobile-kb-proxy")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __sentBytes: number[][] }).__sentBytes)).toEqual([[13]]);

  await page.evaluate(() => {
    (window as unknown as { __sentBytes: number[][] }).__sentBytes = [];
  });

  await page.locator("#kb-accessory .kb-enter").click();
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __sentBytes: number[][] }).__sentBytes)).toEqual([[10]]);
});
