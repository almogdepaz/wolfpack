import { writeFile } from "node:fs/promises";
import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let srv: TestServer;

test.beforeAll(async () => {
  srv = await startTestServer();
});

test.afterAll(async () => {
  await srv?.close();
});

async function openAccessory(page: Page, onSocket?: (socket: WebSocketRoute) => void): Promise<number[][]> {
  const sentBytes: number[][] = [];
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    onSocket?.(ws);
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

for (const width of [375, 390]) test(`mobile accessory has nine keys in even five-control and four-arrow rows at ${width}px`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only accessory layout");
  await page.setViewportSize({ width, height: 844 });
  const bytes = await openAccessory(page);
  await page.locator('#kb-open-btn').click();
  await expect(page.locator('#desktop-terminal-container textarea')).toBeFocused();
  const keys = page.locator('#kb-accessory > .kb-key, #kb-accessory > .kb-control > summary');
  await expect(page.locator('#kb-accessory [data-key="BTab"]')).toHaveCount(0);
  await expect(keys).toHaveCount(9);
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
  expect([...rows.values()]).toEqual([['Enter', 'Escape', 'ctrl', 'C-c', 'keyboard'], ['Up', 'Down', 'Left', 'Right']]);
  const rowGeometry = [...rows.keys()].map(y => geometry.filter(key => Math.round(key.y) === y));
  for (const row of rowGeometry) {
    expect(Math.max(...row.map(key => key.width)) - Math.min(...row.map(key => key.width))).toBeLessThan(1);
    expect(row[0]!.x).toBeCloseTo(geometry[0]!.x, 0);
    const last = row[row.length - 1]!;
    expect(last.x + last.width).toBeCloseTo(geometry[4]!.x + geometry[4]!.width, 0);
  }
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

test("native hardware Tab and Shift+Tab each encode once while terminal focus stays active", async ({ page }, testInfo) => {
  const sentBytes = await openAccessory(page);
  const terminal = page.locator('#desktop-terminal-container');
  await expect(terminal).toHaveAttribute('data-terminal-load-state', 'live');
  const input = testInfo.project.name === 'desktop' ? terminal : terminal.locator('textarea');
  if (testInfo.project.name !== 'desktop') await page.locator('#kb-open-btn').click();
  else await input.focus();
  await expect(input).toBeFocused();
  await page.keyboard.press('Tab');
  await expect.poll(() => sentBytes).toEqual([[9]]);
  await expect(input).toBeFocused();
  const tabFrames = sentBytes.map(frame => [...frame]);
  sentBytes.length = 0;
  await page.keyboard.down('Shift');
  await page.keyboard.down('Tab');
  await page.keyboard.up('Tab');
  await page.keyboard.up('Shift');
  await expect.poll(() => sentBytes).toEqual([[27, 91, 90]]);
  await expect(input).toBeFocused();
  await page.keyboard.press('Enter'); // ordering barrier also exposes duplicate tab/key-up sends
  await expect.poll(() => sentBytes).toEqual([[27, 91, 90], [13]]);
  await expect(input).toBeFocused();
  await writeFile(testInfo.outputPath('native-key-bytes.json'), JSON.stringify({
    project: testInfo.project.name, tabFrames, backtabThenEnterFrames: sentBytes,
    focusedElement: await input.evaluate(el => el === document.activeElement),
  }, null, 2));
});

test('native back-tab respects input gates, composition and nonterminal focus', async ({ page }, testInfo) => {
  const transport: { socket: WebSocketRoute | null; blockReconnect: boolean } = { socket: null, blockReconnect: false };
  const sentBytes = await openAccessory(page, ws => {
    transport.socket = ws;
    if (transport.blockReconnect) ws.close({ code: 1001, reason: 'backtab disconnected fixture' });
  });
  const terminal = page.locator('#desktop-terminal-container');
  await expect(terminal).toHaveAttribute('data-terminal-load-state', 'live');
  const mobile = testInfo.project.name !== 'desktop';
  const input = mobile ? terminal.locator('textarea') : terminal;
  if (mobile) {
    await expect(input).toHaveAttribute('inputmode', 'none');
    await input.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(input).toHaveAttribute('inputmode', 'none');
    expect(await input.evaluate(el => (el as HTMLTextAreaElement).readOnly)).toBe(true);
    expect(sentBytes).toEqual([]);
    await page.locator('#kb-open-btn').click(); // only this action can enable stdin
  } else await input.focus();
  await expect(input).toBeFocused();
  await page.keyboard.press('Tab');
  await expect.poll(() => sentBytes).toEqual([[9]]); // no latent disabled-stdin backtab
  sentBytes.length = 0;
  await input.dispatchEvent('compositionstart', { data: '' });
  await page.keyboard.press('Shift+Tab');
  await input.dispatchEvent('compositionend', { data: '' });
  await input.focus();
  await page.keyboard.press('Tab');
  await expect.poll(() => sentBytes).toEqual([[9]]); // composition did not emit backtab
  sentBytes.length = 0;
  await page.keyboard.press('Control+c');
  await expect.poll(() => sentBytes).toEqual([[3]]); // no-selection Ctrl+C stays native
  sentBytes.length = 0;
  const control = page.locator(mobile ? '#kb-open-btn' : '#sidebar-expand-btn');
  const previous = page.locator(mobile ? '#kb-accessory [data-key="C-c"]' : '#sidebar-settings-btn');
  await control.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(previous).toBeFocused(); // ordinary browser focus traversal, not terminal bytes
  expect(sentBytes).toEqual([]);
  await input.focus();
  transport.blockReconnect = true;
  if (!transport.socket) throw new Error('missing connected fixture socket');
  transport.socket.close({ code: 1001, reason: 'backtab disconnected fixture' });
  await expect(page.locator('#conn-status')).toHaveAttribute('data-conn-state', 'reconnecting');
  await page.keyboard.press('Shift+Tab');
  expect(sentBytes).toEqual([]);
  transport.blockReconnect = false;
  await expect(terminal).toHaveAttribute('data-terminal-load-state', 'live');
  expect(sentBytes).toEqual([]); // no queued input leaks on reconnect
  await input.focus();
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => sentBytes).toEqual([[27, 91, 90]]);
  await expect(input).toBeFocused();
  await writeFile(testInfo.outputPath('native-input-gates.json'), JSON.stringify({
    project: testInfo.project.name, finalFrames: sentBytes, reconnectHasNoQueuedInput: true,
    compositionSentNoBacktab: true, nonterminalShiftTabMovedFocus: true,
  }, null, 2));
});

test("mobile accessory Enter inserts line-feed while native Enter still sends carriage-return", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "mobile-only accessory keyboard behavior");
  const sentBytes = await openAccessory(page);
  const keyboard = page.locator("#kb-open-btn");
  const input = page.locator("#desktop-terminal-container textarea");
  await expect(input).toHaveAttribute("inputmode", "none");
  await keyboard.click();
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("inputmode", "text");
  expect(await input.evaluate(el => (el as HTMLTextAreaElement).readOnly)).toBe(false);
  await expect.poll(() => sentBytes).toEqual([]);
  await keyboard.click();
  await expect(input).toHaveAttribute("inputmode", "none");
  await expect(input).toHaveAttribute("tabindex", "-1");
  expect(await input.evaluate(el => (el as HTMLTextAreaElement).readOnly)).toBe(true);
  await expect.poll(() => sentBytes).toEqual([]);
  await keyboard.click();
  await expect(input).toBeFocused();

  await page.keyboard.press("Enter");
  await expect.poll(() => sentBytes).toEqual([[13]]);

  sentBytes.length = 0;
  await page.keyboard.press("Shift+Tab");
  // Native hardware back-tab remains available without an accessory BTab key.
  await expect.poll(() => sentBytes).toEqual([[27, 91, 90]]);
  await expect(input).toBeFocused();

  sentBytes.length = 0;
  await page.locator("#kb-accessory .kb-enter").click();
  await expect.poll(() => sentBytes).toEqual([[10]]);

  for (const [key, bytes] of [["Escape", [27]], ["C-c", [3]], ["Up", [27, 91, 65]], ["Down", [27, 91, 66]], ["Left", [27, 91, 68]], ["Right", [27, 91, 67]]] as const) {
    sentBytes.length = 0;
    await page.locator(`#kb-accessory [data-key="${key}"]`).click();
    await expect.poll(() => sentBytes).toEqual([Array.from(bytes)]);
  }
});
