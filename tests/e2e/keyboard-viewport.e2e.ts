import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { openSessionFromUi, startTestServer, terminalTail, type TestServer } from './helpers.ts';
import { installNativeKeyboard, type NativeKeyboardWindow } from './virtual-keyboard-fixture.ts';

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });

async function openKeyboardFixture(page: Page, query = '', openKeyboard = true, nativeKeyboard = false): Promise<number[]> {
  // These vv models represent platforms without VirtualKeyboard (including
  // Safari). Chromium exposes the API regardless of its emulated user agent.
  if (!nativeKeyboard) await page.addInitScript(() => {
    Object.defineProperty(navigator, 'virtualKeyboard', { configurable: true, value: undefined });
  });
  const typed: number[] = [];
  await page.routeWebSocket(/\/ws\/pty/, socket => socket.onMessage(message => {
    if (typeof message !== 'string') {
      typed.push(...Buffer.from(message)); socket.send(message); return;
    }
    if (JSON.parse(message).type !== 'attach') return;
    socket.send(JSON.stringify({ type: 'attach_ack' }));
    socket.send(Buffer.from('\x1b[2J\x1b[Hprobe> '));
    socket.send(JSON.stringify({ type: 'prefill_done' }));
    socket.send(JSON.stringify({ type: 'pty_ready' }));
  }));
  await page.goto(server.baseUrl + query);
  await page.getByRole('button', { name: 'Open test-project', exact: true }).first().click();
  const terminal = page.locator('#desktop-terminal-container');
  await expect(terminal).toHaveAttribute('data-terminal-load-state', 'live');
  await expect.poll(() => terminalTail(terminal, 40)).toContain('probe>');
  if (openKeyboard) {
    await page.locator('#kb-open-btn').click();
    await expect(terminal.locator('textarea')).toBeFocused();
  }
  return typed;
}

async function viewportModel(page: Page, innerHeight: number | null, height: number, offsetTop: number): Promise<void> {
  await page.evaluate(({ innerHeight, height, offsetTop }) => {
    if (innerHeight !== null) Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
    Object.defineProperties(window.visualViewport!, {
      height: { configurable: true, value: height }, offsetTop: { configurable: true, value: offsetTop },
    });
    // A test-only root range permits real browser keyboard panning. Do not
    // override the app body's height, containing block, or terminal rectangles.
    document.documentElement.style.overflowY = 'auto';
    const spacer = document.getElementById('keyboard-pan-range') ?? document.createElement('div');
    spacer.id = 'keyboard-pan-range';
    spacer.style.cssText = 'position:absolute;top:2000px;width:1px;height:1px;pointer-events:none';
    document.documentElement.appendChild(spacer);
    window.scrollTo(0, offsetTop);
    window.visualViewport!.dispatchEvent(new Event('resize'));
    window.visualViewport!.dispatchEvent(new Event('scroll'));
  }, { innerHeight, height, offsetTop });
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(offsetTop);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const previous of [false, true]) test(`native VK CSS geometry overrides stale vv with prior overlay ${previous}`, async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'mobile native API boundary');
  await page.setViewportSize({ width: 384, height: 596 });
  await installNativeKeyboard(page, previous);
  const typed = await openKeyboardFixture(page, '?kbdebug=1', true, true);
  await page.evaluate(() => (window as NativeKeyboardWindow).__nativeKeyboard.geometry(437, 159));
  await viewportModel(page, 596, 340.98, 0);
  const data = await page.evaluate(() => ({
    accessory: document.querySelector('#kb-accessory')!.getBoundingClientRect().toJSON(),
    terminal: document.querySelector('#terminal-view')!.getBoundingClientRect().toJSON(),
    canvas: document.querySelector('#desktop-terminal-container canvas')!.getBoundingClientRect().toJSON(),
    clip: document.querySelector('#workspace-terminal-region')!.getBoundingClientRect().toJSON(),
    debug: JSON.parse(document.querySelector('#kb-debug')!.textContent || '{}'),
    overlayHistory: (window as NativeKeyboardWindow).__nativeKeyboard.overlayHistory,
    overlay: (window as NativeKeyboardWindow).__nativeKeyboard.overlaysContent,
    listeners: (window as NativeKeyboardWindow).__nativeKeyboard.listeners.size,
  }));
  await writeFile(info.outputPath('native-geometry.json'), JSON.stringify(data, null, 2));
  await page.screenshot({ path: info.outputPath('native-437.png'), animations: 'disabled' });
  expect.soft(data.accessory.bottom).toBeCloseTo(437, 1);
  expect.soft(data.terminal.bottom).toBeCloseTo(437, 1);
  expect.soft(data.overlay).toBe(true);
  expect.soft(data.listeners).toBe(1);
  expect(data.canvas.top).toBeGreaterThanOrEqual(Math.max(data.terminal.top, data.clip.top));
  expect(data.canvas.top + 20).toBeLessThanOrEqual(data.clip.bottom);
  expect(data.debug.path).toBe('vk');
  expect(data.debug.vk).toMatchObject({ supported: true, overlaysContent: true, boundingRect: { top: 437, height: 159 } });
  expect(data.debug).toMatchObject({ screenHeight: await page.evaluate(() => screen.height), outerHeight: await page.evaluate(() => outerHeight), devicePixelRatio: await page.evaluate(() => devicePixelRatio) });
  await page.keyboard.type('native');
  await expect.poll(() => Buffer.from(typed).toString()).toBe('native');
  await page.locator('#back-btn').click();
  expect(await page.evaluate(() => (window as NativeKeyboardWindow).__nativeKeyboard.overlaysContent)).toBe(previous);
  expect(await page.evaluate(() => (window as NativeKeyboardWindow).__nativeKeyboard.listeners.size)).toBe(0);
});

test('native VK zero/open pending, close/reopen, repeated mounts and route cleanup never open stdin implicitly', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'mobile native API lifecycle');
  await page.setViewportSize({ width: 384, height: 596 });
  await installNativeKeyboard(page, false);
  const typed = await openKeyboardFixture(page, '?kbdebug=1', false, true);
  const input = page.locator('#desktop-terminal-container textarea');
  const button = page.locator('#kb-open-btn');
  const emit = async (top: number, height: number) => page.evaluate(({ top, height }) => (window as NativeKeyboardWindow).__nativeKeyboard.geometry(top, height), { top, height });
  await expect(input).toHaveAttribute('inputmode', 'none');
  await page.locator('#desktop-terminal-container canvas').tap();
  await emit(437, 159);
  await expect(input).toHaveAttribute('inputmode', 'none');
  await emit(0, 0);
  await button.click();
  await emit(0, 0); // initial zero cannot cancel the explicit pending open
  await viewportModel(page, 596, 596, 0);
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('inputmode', 'text');
  await emit(437, 159);
  await viewportModel(page, 596, 340.98, 0);
  await expect(input).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => typed).toEqual([13]);
  await emit(0, 0); // real native close wins even when vv still looks occluded
  await expect(input).toHaveAttribute('inputmode', 'none');
  await expect(page.locator('#terminal-view')).not.toHaveClass(/keyboard-occluded/);
  await button.click();
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await expect(input).toBeFocused();
  await emit(437, 159);
  await expect(input).toHaveAttribute('inputmode', 'text');
  await button.click();
  await page.evaluate(() => visualViewport!.dispatchEvent(new Event('resize')));
  await expect(input).toHaveAttribute('inputmode', 'none');
  await emit(0, 0);
  await page.evaluate(() => { (window as NativeKeyboardWindow).__nativeCanvas = document.querySelector('#desktop-terminal-container canvas'); });
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.locator('#back-btn').click();
    await expect(page.locator('#kb-debug')).toHaveCount(0);
    expect(await page.evaluate(() => (window as NativeKeyboardWindow).__nativeKeyboard.overlaysContent)).toBe(false);
    expect(await page.evaluate(() => (window as NativeKeyboardWindow).__nativeKeyboard.listeners.size)).toBe(0);
    await emit(437, 159); // disposed listener cannot affect route or restore stdin
    await expect(page.locator('#terminal-view')).toHaveCSS('position', 'absolute');
    await emit(0, 0);
    await page.getByRole('button', { name: 'Open test-project', exact: true }).first().click();
    await expect(page.locator('#desktop-terminal-container')).toHaveAttribute('data-terminal-load-state', 'live');
    expect(await page.evaluate(() => (window as NativeKeyboardWindow).__nativeKeyboard.listeners.size)).toBe(1);
    expect(await page.evaluate(() => (window as NativeKeyboardWindow).__nativeKeyboard.overlaysContent)).toBe(true);
    // Back destroys the single-entry mobile terminal, unlike desktop pooling.
    expect(await page.evaluate(() => (window as NativeKeyboardWindow).__nativeCanvas === document.querySelector('#desktop-terminal-container canvas'))).toBe(false);
    await expect(input).toHaveAttribute('inputmode', 'none');
  }
  await writeFile(info.outputPath('overlay-history.json'), JSON.stringify(await page.evaluate(() => (window as NativeKeyboardWindow).__nativeKeyboard.overlayHistory)));
});

for (const previous of [false, true]) test(`native VK stays untouched across desktop pooled sessions with prior overlay ${previous}`, async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop owns the retained multi-entry pool');
  await installNativeKeyboard(page, previous);
  const typed = await openKeyboardFixture(page, '', false, true);
  await page.evaluate(() => { window.__nativeCanvas = document.querySelector('#desktop-terminal-container canvas'); });
  await openSessionFromUi(page, 'another-project', '');
  await expect(page.locator('#desktop-terminal-container')).toHaveAttribute('data-terminal-load-state', 'live');
  await openSessionFromUi(page, 'test-project', '');
  await expect(page.locator('#desktop-terminal-container')).toHaveAttribute('data-terminal-load-state', 'live');
  expect(await page.evaluate(() => window.__nativeCanvas === document.querySelector('#desktop-terminal-container canvas'))).toBe(true);
  await page.evaluate(() => window.__nativeKeyboard.geometry(437, 159));
  expect(await page.evaluate(() => ({ history: window.__nativeKeyboard.overlayHistory, listeners: window.__nativeKeyboard.listeners.size, overlay: window.__nativeKeyboard.overlaysContent })))
    .toEqual({ history: [], listeners: 0, overlay: previous });
  await expect(page.locator('#terminal-view')).not.toHaveClass(/keyboard-occluded/);
  await page.locator('#desktop-terminal-container').click();
  await page.keyboard.type('pooled');
  await expect.poll(() => Buffer.from(typed).toString()).toBe('pooled');
});

for (const policy of ['ignore', 'throw'] as const) test(`native VK policy ${policy} stays honestly on vv fallback`, async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'mobile native API policy');
  await page.setViewportSize({ width: 384, height: 596 });
  await installNativeKeyboard(page, false, policy);
  const warnings: string[] = [];
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
  await openKeyboardFixture(page, '?kbdebug=1', true, true);
  await viewportModel(page, 596, 340.98, 0);
  const debug = JSON.parse(await page.locator('#kb-debug').textContent() || '{}');
  expect(debug.path).toBe('vv');
  expect(debug.vk).toMatchObject({ supported: true, overlaysContent: false });
  expect(warnings.some(message => /virtual keyboard/i.test(message))).toBe(true);
  expect(warnings).toHaveLength(1);
  if (policy === 'throw') expect(warnings[0]).toContain('NotSupportedError: fixture policy refused overlay');
  else expect(warnings[0]).toBe('Virtual keyboard overlay unavailable; using visual viewport');
  await writeFile(info.outputPath('policy.json'), JSON.stringify({ debug, warnings }, null, 2));
});

const cases = [
  { name: 'Android Brave tab', width: 412, actualHeight: 859, innerHeight: 915, height: 520, offsetTop: 0 },
  { name: 'Android Brave tab native fixed915 body859', width: 412, actualHeight: 915, bodyHeight: 859, innerHeight: null, height: 520, offsetTop: 0 },
  ...['Safari-like tab', 'standalone-like'].flatMap(name => [0, 120, 300].map(offsetTop =>
    ({ name, width: 390, actualHeight: 844, innerHeight: 844, height: 500, offsetTop }))),
];
for (const model of cases) test.describe(`${model.name} pan ${model.offsetTop}`, () => {
  if (model.name.startsWith('Android Brave tab')) test.use({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    deviceScaleFactor: 2.3,
  });
  test('keyboard actual geometry', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'mobile visual viewport models, not physical-device evidence');
  await page.setViewportSize({ width: model.width, height: model.actualHeight });
  if (model.name === 'standalone-like') await page.addInitScript(() => {
    const native = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const result = native(query);
      if (query === '(display-mode: standalone)') Object.defineProperty(result, 'matches', { value: true });
      return result;
    };
  });
  const typed = await openKeyboardFixture(page);
  if ('bodyHeight' in model) await page.evaluate(height => { document.body.style.height = `${height}px`; }, model.bodyHeight);
  await viewportModel(page, model.innerHeight, model.height, model.offsetTop);
  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => {
      const { top, bottom, height } = document.querySelector(selector)!.getBoundingClientRect();
      return { top, bottom, height };
    };
    return { innerHeight, clientHeight: document.documentElement.clientHeight, scrollY,
      vv: { height: visualViewport!.height, offsetTop: visualViewport!.offsetTop },
      body: rect('body'), cb: rect('#view-container'), terminal: rect('#terminal-view'), accessory: rect('#kb-accessory'),
      position: getComputedStyle(document.querySelector('#terminal-view')!).position,
      inset: getComputedStyle(document.querySelector('#terminal-view')!).bottom,
      canvas: rect('#desktop-terminal-container canvas'), clip: rect('#workspace-terminal-region'),
      inputmode: document.querySelector('#desktop-terminal-container textarea')!.getAttribute('inputmode'),
    };
  });
  await writeFile(info.outputPath('geometry.json'), JSON.stringify({ model, geometry }, null, 2));
  await page.screenshot({ path: info.outputPath(`keyboard-${model.width}-pan-${model.offsetTop}.png`), animations: 'disabled' });
  expect(geometry.clientHeight, 'native fixed positioning frame').toBe(model.actualHeight);
  expect(geometry.innerHeight).toBe(model.innerHeight ?? model.actualHeight);
  if ('bodyHeight' in model) expect(geometry.body.bottom).toBe(model.bodyHeight);
  expect.soft(Math.abs(geometry.accessory.bottom - model.height - model.offsetTop), 'accessory meets visual keyboard edge').toBeLessThanOrEqual(1);
  expect.soft(geometry.inputmode, 'large keyboard loss stays open even when residual inset is below 150px').toBe('text');
  expect.soft(geometry.canvas.top, 'first row is not clipped by workspace').toBeGreaterThanOrEqual(Math.max(model.offsetTop, geometry.clip.top));
  expect.soft(geometry.canvas.top + 20).toBeLessThanOrEqual(Math.min(model.height + model.offsetTop, geometry.clip.bottom));
  await page.keyboard.type('hello');
  await expect.poll(() => Buffer.from(typed).toString()).toBe('hello');
  });
});

for (const model of cases.filter(model => model.name.startsWith('Android Brave tab'))) {
for (const query of ['', '?kbdebug=0', '?kbdebug=1']) test(`keyboard diagnostics query ${query || 'absent'} ${model.name}`, async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'mobile terminal diagnostic lifecycle');
  await page.setViewportSize({ width: 412, height: model.actualHeight });
  const typed = await openKeyboardFixture(page, query);
  if ('bodyHeight' in model) await page.evaluate(height => { document.body.style.height = `${height}px`; }, model.bodyHeight);
  await viewportModel(page, model.innerHeight, 520, 0);
  const debug = page.locator('#kb-debug');
  if (query !== '?kbdebug=1') {
    await expect(debug).toHaveCount(0);
  } else {
    await expect(debug).toHaveCount(1);
    await expect(debug).toHaveCSS('pointer-events', 'none');
    await expect(debug).not.toBeFocused();
    const sample = async () => JSON.parse(await debug.textContent() || '{}');
    await expect.poll(async () => (await sample()).accessory?.bottom).toBe(520);
    let data = await sample();
    expect(data.innerHeight).toBe(915);
    expect(data.clientHeight).toBe(model.actualHeight);
    expect(data.vv).toEqual({ height: 520, offsetTop: 0 });
    expect(data.inset).toBe(model.actualHeight === 915 ? 395 : 339);
    expect(data.mode).toBe('tab');
    expect(data.cb.bottom).toBe(859);
    expect(data.terminal.bottom).toBe(520);
    for (const pan of [120, 300]) {
      await viewportModel(page, model.innerHeight, 500, pan);
      await expect.poll(async () => (await sample()).accessory?.bottom).toBe(500 + pan);
      data = await sample();
      expect(data.scrollY).toBe(pan);
      expect(data.vv.offsetTop).toBe(pan);
      expect(data.cb.top).toBeLessThan(0);
      expect(data.terminal.bottom).toBe(500 + pan);
      const debugBounds = await debug.evaluate(el => {
        const { top, bottom, left, right, height } = el.getBoundingClientRect();
        return { top, bottom, left, right, height };
      });
      await writeFile(info.outputPath(`diagnostic-${pan}.json`), JSON.stringify({ data, debugBounds }, null, 2));
      await page.screenshot({ path: info.outputPath(`kbdebug-412-pan-${pan}.png`), animations: 'disabled' });
      expect.soft(debugBounds.top, `readout top is inside the panned visual viewport ${pan}`).toBeGreaterThanOrEqual(pan);
      expect.soft(debugBounds.bottom).toBeLessThanOrEqual(pan + 500);
      expect(debugBounds.left).toBeGreaterThanOrEqual(0);
      expect(debugBounds.right).toBeLessThanOrEqual(412);
    }
  }
  await expect(page.locator('#desktop-terminal-container textarea')).toBeFocused();
  await page.keyboard.type('hello');
  await expect.poll(() => Buffer.from(typed).toString()).toBe('hello');
  await viewportModel(page, model.innerHeight, model.actualHeight, 0);
  await expect(page.locator('#desktop-terminal-container textarea')).toHaveAttribute('inputmode', 'none');
  await page.locator('#back-btn').click();
  await expect(page.locator('#sessions-view')).toBeVisible();
  await expect(debug).toHaveCount(0);
  await viewportModel(page, model.innerHeight, 520, 0);
  await expect(debug).toHaveCount(0);
  await expect(page.locator('#terminal-view')).toHaveCSS('position', 'absolute');
  await expect(page.locator('#terminal-view')).not.toHaveClass(/keyboard-occluded/);
});
}
