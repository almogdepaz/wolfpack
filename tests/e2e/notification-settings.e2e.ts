import { expect, test } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(() => {
  server?.close();
});

test("serves the canonical phone and notification help link in Settings", async ({ page }) => {
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Settings" }).first().click();

  const helpLink = page.getByRole("link", {
    name: "Phone, PWA, and notification help",
  });
  await expect(helpLink).toBeVisible();
  await expect(helpLink).toHaveAttribute(
    "href",
    "https://github.com/almogdepaz/wolfpack/blob/main/docs/phone-pwa-notifications.md",
  );
  await expect(helpLink).toHaveAttribute("target", "_blank");
  await expect(helpLink).toHaveAttribute("rel", /\bnoopener\b/);
  await expect(helpLink).toHaveAttribute("rel", /\bnoreferrer\b/);
});

test("startup clears a persisted notification preference when push is unsupported", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("wp-effects", JSON.stringify({ notifications: true }));
    Reflect.deleteProperty(window, "PushManager");
  });
  await page.goto(server.baseUrl);

  await expect.poll(() => page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("wp-effects") ?? "{}");
    return stored.notifications;
  })).toBe(false);
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
  await expect(page.locator("#notification-setting-status")).toContainText("not supported");
  await expect.poll(() => page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("wp-effects") ?? "{}");
    return stored.notifications;
  })).toBe(false);
});

test("blocked browser permission explains how to unblock notifications", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Notification, "requestPermission", {
      configurable: true,
      value: async () => "denied",
    });
  });
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Settings" }).first().click();

  const toggle = page.locator("#setting-notifications");
  await toggle.click();

  await expect(toggle).not.toBeChecked();
  await expect(page.locator("#notification-setting-status")).toContainText("blocked in browser settings");
});

test("notification setup exposes progress while the permission request is pending", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      get: () => "default",
    });
    Object.defineProperty(Notification, "requestPermission", {
      configurable: true,
      value: async () => new Promise(() => {}),
    });
  });
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Settings" }).first().click();

  const toggle = page.locator("#setting-notifications");
  await toggle.click();

  await expect(toggle).toBeDisabled();
  await expect(page.locator("#notification-setting-status")).toHaveText("Enabling notifications…");
});

test("focus refresh removes stale blocked guidance after permission changes", async ({ page }) => {
  await page.addInitScript(() => {
    let permission: NotificationPermission = "denied";
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      get: () => permission,
    });
    Object.defineProperty(window, "__allowNotificationPermission", {
      value: () => { permission = "default"; },
    });
  });
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Settings" }).first().click();

  const status = page.locator("#notification-setting-status");
  await expect(status).toContainText("blocked in browser settings");

  await page.evaluate(() => {
    const allow = Reflect.get(window, "__allowNotificationPermission");
    if (typeof allow === "function") allow();
    window.dispatchEvent(new Event("focus"));
  });

  await expect(status).toContainText("Notifications are off");
});
