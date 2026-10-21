import { test, expect, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let srv: TestServer;

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  await srv?.close();
});

async function openAccessory(page: Page): Promise<number[][]> {
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
  await expect(page.locator('#terminal-view')).not.toHaveClass(/swiping/);
  return sentBytes;
}

for (const width of [375, 390]) test(`mobile accessory has two even rows of five at ${width}px`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only accessory layout");
  await page.setViewportSize({ width, height: 844 });
  const bytes = await openAccessory(page);
  await page.locator('#kb-open-btn').click();
  await expect(page.locator('#desktop-terminal-container textarea')).toBeFocused();
  const keys = page.locator('#kb-accessory > .kb-key, #kb-accessory > .kb-control > summary');
  await expect(keys).toHaveCount(10);
  const geometry = await keys.evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return { key: node.getAttribute('data-key') || (node.id === 'kb-open-btn' ? 'keyboard' : 'ctrl'), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }));
  const bar = await page.locator('#kb-accessory').evaluate(element => ({ x: element.getBoundingClientRect().x, width: element.getBoundingClientRect().width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  expect(bar.width).toBe(width);
  expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
  const rows = new Map<number, string[]>();
  for (const key of geometry) {
    const y = Math.round(key.y);
    rows.set(y, [...(rows.get(y) ?? []), key.key]);
    expect(key.height).toBeGreaterThanOrEqual(42);
    expect(key.x).toBeGreaterThanOrEqual(bar.x);
    expect(key.x + key.width).toBeLessThanOrEqual(bar.x + bar.width);
  }
  expect([...rows.values()]).toEqual([['Enter', 'Escape', 'ctrl', 'BTab', 'C-c'], ['Up', 'Down', 'Left', 'Right', 'keyboard']]);
  expect(Math.max(...geometry.map(key => key.width)) - Math.min(...geometry.map(key => key.width))).toBeLessThan(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  const summary = page.locator('#kb-accessory .kb-control summary');
  await summary.tap();
  const menu = page.locator('#kb-accessory .kb-control-menu');
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  await menu.locator('[data-key="C-a"]').tap();
  await expect.poll(() => bytes).toEqual([[1]]);
  await expect(page.locator('#desktop-terminal-container textarea')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  await page.screenshot({ path: testInfo.outputPath(`accessory-${width}.png`) });
});

test("mobile accessory Enter inserts line-feed while native Enter still sends carriage-return", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only accessory keyboard behavior");
  const sentBytes = await openAccessory(page);
  await page.locator("#kb-open-btn").click();
  await expect(page.locator("#desktop-terminal-container textarea")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect.poll(() => sentBytes).toEqual([[13]]);

  sentBytes.length = 0;
  await page.locator("#kb-accessory .kb-enter").click();
  await expect.poll(() => sentBytes).toEqual([[10]]);

  for (const [key, bytes] of [["Escape", [27]], ["BTab", [27, 91, 90]], ["C-c", [3]], ["Up", [27, 91, 65]], ["Down", [27, 91, 66]], ["Left", [27, 91, 68]], ["Right", [27, 91, 67]]] as const) {
    sentBytes.length = 0;
    await page.locator(`#kb-accessory [data-key="${key}"]`).click();
    await expect.poll(() => sentBytes).toEqual([Array.from(bytes)]);
  }
});
