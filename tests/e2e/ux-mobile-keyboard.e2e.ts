import { test, expect } from '@playwright/test';
import { startTestServer, terminalTail, type TestServer } from './helpers.ts';
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });
test('first input line remains visible above a simulated software keyboard', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'responsive mobile keyboard geometry contract');
  const typed: number[] = [];
  await page.routeWebSocket(/\/ws\/pty/, socket => {
    socket.onMessage(message => {
      if (typeof message !== 'string') {
        const bytes = Buffer.from(message); typed.push(...bytes); socket.send(bytes); return;
      }
      let value: { type?: string }; try { value = JSON.parse(message); } catch { return; }
      if (value.type !== 'attach') return;
      socket.send(JSON.stringify({ type: 'attach_ack' }));
      socket.send(Buffer.from('\x1b[2J\x1b[Hprobe> '));
      socket.send(JSON.stringify({ type: 'prefill_done' }));
      socket.send(JSON.stringify({ type: 'pty_ready' }));
    });
  });
  await page.goto(server.baseUrl);
  await page.locator('.card', { hasText: 'test-project' }).first().click();
  const terminal = page.locator('#desktop-terminal-container');
  await expect(terminal).toHaveAttribute('data-terminal-load-state', 'live');
  await expect.poll(() => terminalTail(terminal, 40)).toContain('probe>');
  const canvas = terminal.locator('canvas');
  const clip = page.locator('#workspace-terminal-region');
  expect((await canvas.boundingBox())!.y).toBeGreaterThanOrEqual((await clip.boundingBox())!.y);
  await page.locator('#kb-open-btn').click();
  await expect(terminal.locator('textarea')).toBeFocused();
  await page.evaluate(() => {
    const vv = window.visualViewport!;
    Object.defineProperties(vv, { height: { configurable: true, value: window.innerHeight - 320 }, offsetTop: { configurable: true, value: 0 } });
    vv.dispatchEvent(new Event('resize'));
  });
  await page.keyboard.type('hello');
  await expect.poll(() => Buffer.from(typed).toString()).toBe('hello');
  await expect.poll(() => terminalTail(terminal, 40)).toContain('probe> hello');
  const box = (await canvas.boundingBox())!; const clipping = (await clip.boundingBox())!;
  const visibleHeight = await page.evaluate(() => window.visualViewport!.height);
  await info.attach('keyboard-geometry', { body: JSON.stringify({ canvas: box, clipping, visibleHeight, typed: Buffer.from(typed).toString() }), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('keyboard-open.png') });
  // The fixture deliberately keeps the cursor on row zero: successfully sent
  // input is not sufficient when that first rendered line is above the clip.
  expect(box.y).toBeGreaterThanOrEqual(Math.max(0, clipping.y));
  expect(box.y + 20).toBeLessThanOrEqual(Math.min(visibleHeight, clipping.y + clipping.height));
  await page.evaluate(() => {
    const vv = window.visualViewport!;
    Object.defineProperties(vv, { height: { configurable: true, value: window.innerHeight - 340 }, offsetTop: { configurable: true, value: 20 } });
    vv.dispatchEvent(new Event('scroll'));
  });
  expect((await canvas.boundingBox())!.y).toBeGreaterThanOrEqual((await clip.boundingBox())!.y);
  await page.evaluate(() => {
    const vv = window.visualViewport!;
    Object.defineProperties(vv, { height: { configurable: true, value: window.innerHeight }, offsetTop: { configurable: true, value: 0 } });
    vv.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('#terminal-view')).toHaveCSS('bottom', '0px');
  expect((await canvas.boundingBox())!.y).toBeGreaterThanOrEqual((await clip.boundingBox())!.y);
});
