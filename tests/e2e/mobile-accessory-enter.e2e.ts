import { test, expect } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let srv: TestServer;

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  await srv?.close();
});

test("mobile accessory Enter inserts line-feed while native Enter still sends carriage-return", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only accessory keyboard behavior");

  const sentBytes: number[][] = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") {
        sentBytes.push(Array.from(Buffer.from(message)));
        return;
      }
      let parsed: { readonly type?: string; readonly prefillMode?: string };
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed.type !== "attach") return;
      ws.send(JSON.stringify({ type: "attach_ack" }));
      if (parsed.prefillMode === "viewport") ws.send(JSON.stringify({ type: "prefill_viewport" }));
      ws.send(JSON.stringify({ type: "prefill_done" }));
      ws.send(JSON.stringify({ type: "pty_ready" }));
    });
  });

  await page.goto(srv.baseUrl);
  await page.waitForSelector(".card", { timeout: 5000 });

  await page.locator(".card", { hasText: "test-project" }).first().click();
  await expect(page.locator("#terminal-view")).toBeVisible();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 5000 });

  await page.locator("#kb-open-btn").click();
  await expect(page.locator("#desktop-terminal-container textarea")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect.poll(() => sentBytes).toEqual([[13]]);

  sentBytes.length = 0;
  await page.locator("#kb-accessory .kb-enter").click();
  await expect.poll(() => sentBytes).toEqual([[10]]);
});
