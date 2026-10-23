import { test, expect, type Page } from '@playwright/test';
import { startTestServer, terminalTail, type TestServer } from './helpers.ts';
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });

async function forceTerminalSafeArea(page: Page): Promise<void> {
  const count = await page.evaluate(() => {
    // Chromium reports env(safe-area-inset-bottom)=0. Supply the environment
    // value at the real consuming rule, leaving keyboard-state rules intact.
    document.documentElement.style.setProperty('--test-safe-area-bottom', '34px');
    let count = 0;
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule && rule.selectorText === '#terminal-view' && rule.style.paddingBottom.includes('env(safe-area-inset-bottom)')) {
          rule.style.setProperty('padding-bottom', 'var(--test-safe-area-bottom, env(safe-area-inset-bottom))');
          count++;
        }
        if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) visit(sheet.cssRules);
    return count;
  });
  expect(count).toBe(1);
}

async function emulateKeyboardViewport(page: Page, height: number, offsetTop: number, event = 'resize'): Promise<void> {
  await page.evaluate(({ height, offsetTop, event }) => {
    const vv = window.visualViewport!;
    Object.defineProperties(vv, { height: { configurable: true, value: height }, offsetTop: { configurable: true, value: offsetTop } });
    vv.dispatchEvent(new Event(event));
  }, { height, offsetTop, event });
}

async function expectMainSafeArea(page: Page): Promise<void> {
  await expect.poll(() => page.locator('#kb-accessory').evaluate(el => {
    const viewport = window.visualViewport!;
    return Math.abs(viewport.height + viewport.offsetTop - el.getBoundingClientRect().bottom);
  })).toBe(34);
}

for (const needsInput of [false, true]) test(`accessory retains main safe-area padding and mobile banner stays hidden (banner ${needsInput})`, async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'mobile visual viewport and safe-area contract');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [{
    name: 'test-project', lastLine: 'Keyboard geometry fixture', identity: { wolfpackSessionId: 'keyboard-session' },
    runtimeState: { state: needsInput ? 'needs-input' : 'idle', authority: 'manifest', source: 'local-manifest', freshness: 'fresh', stale: false, unseen: false },
  }] } }));
  await page.routeWebSocket(/\/ws\/pty/, socket => socket.onMessage(message => {
    if (typeof message !== 'string') return;
    const frame = JSON.parse(message);
    if (frame.type !== 'attach') return;
    socket.send(JSON.stringify({ type: 'attach_ack' }));
    if (frame.prefillMode === 'viewport') socket.send(JSON.stringify({ type: 'prefill_viewport' }));
    socket.send(JSON.stringify({ type: 'prefill_done' }));
    socket.send(JSON.stringify({ type: 'pty_ready' }));
  }));
  await page.goto(server.baseUrl);
  await page.getByRole('button', { name: 'Open test-project', exact: true }).first().click();
  await expect(page.locator('#desktop-terminal-container canvas')).toBeVisible();
  const view = page.locator('#terminal-view');
  const input = page.locator('#desktop-terminal-container textarea');
  const banner = page.locator('#needs-input-banner');
  await expect(view).not.toHaveClass(/swiping/);
  await forceTerminalSafeArea(page);
  await expect(view).toHaveCSS('padding-bottom', '34px');
  await expect(input).toHaveAttribute('inputmode', 'none');
  await expect(banner).toHaveJSProperty('hidden', true);
  await expect(page.locator('#input-bar')).toBeHidden();

  await emulateKeyboardViewport(page, 524, 0);
  await expect(view).toHaveCSS('bottom', '320px');
  await expect(input).toHaveAttribute('inputmode', 'none'); // viewport cannot enable stdin
  await page.locator('#kb-open-btn').click();
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('inputmode', 'text');
  await expectMainSafeArea(page);
  await expect(view).toHaveCSS('padding-bottom', '34px');
  await expect(page.locator('#input-bar')).toBeHidden();
  await expect(banner).toHaveJSProperty('hidden', true);

  await emulateKeyboardViewport(page, 484, 40, 'scroll');
  await expect(view).toHaveCSS('bottom', '320px');
  await expectMainSafeArea(page);
  await expect(input).toHaveAttribute('inputmode', 'text');

  await emulateKeyboardViewport(page, 844, 0);
  await expect(view).toHaveCSS('bottom', '0px');
  await expect(view).toHaveCSS('padding-bottom', '34px');
  await expect(input).toHaveAttribute('inputmode', 'none');
  expect(await input.evaluate(el => (el as HTMLTextAreaElement).readOnly)).toBe(true);

  // A later viewport-only keyboard exposure still cannot reopen stdin.
  await emulateKeyboardViewport(page, 504, 20);
  await expectMainSafeArea(page);
  await expect(input).toHaveAttribute('inputmode', 'none');
  await emulateKeyboardViewport(page, 844, 0);
  await expect(view).toHaveCSS('padding-bottom', '34px');
  await expect(banner).toHaveJSProperty('hidden', true);
  await expect(page.locator('#input-bar')).toBeHidden();
});
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
