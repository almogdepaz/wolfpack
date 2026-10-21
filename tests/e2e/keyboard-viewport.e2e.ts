import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { startTestServer, terminalTail, type TestServer } from './helpers.ts';

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });

async function openKeyboardFixture(page: Page, query = ''): Promise<number[]> {
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
  await page.locator('#kb-open-btn').click();
  await expect(terminal.locator('textarea')).toBeFocused();
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
