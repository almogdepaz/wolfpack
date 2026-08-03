import { expect, test } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(() => {
  server?.close();
});

test("unsupported push does not leave the notification preference enabled", async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "PushManager");
  });
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Settings" }).first().click();

  const toggle = page.locator("#setting-notifications");
  await toggle.click();

  await expect(toggle).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("wp-effects") ?? "{}");
    return stored.notifications;
  })).toBe(false);
});
