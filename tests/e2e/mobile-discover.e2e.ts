import { writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers.ts';

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });

async function capture(page: Page, info: TestInfo, state: string) {
  await page.screenshot({ path: info.outputPath(`${state}.png`), animations: 'disabled' });
  await writeFile(info.outputPath(`${state}.json`), JSON.stringify(await page.evaluate(() => ({
    buttons: Array.from(document.querySelectorAll('#mobile-tab-bar > *')).map(el => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { text: el.textContent, x, y, width, height, busy: el.getAttribute('aria-busy') };
    }),
    status: document.getElementById('mobile-discover-status')?.textContent,
    focus: document.activeElement?.outerHTML,
  })), null, 2));
}

test('mobile and repeated Settings scans share the existing queued refresh and busy lifetime', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'simultaneous mobile and Settings actions');
  let requests = 0;
  const releases = new Map<number, () => void>();
  await page.route('**/api/tailnet/v1/candidates', async route => {
    const request = ++requests;
    if (request > 1) await new Promise<void>(resolve => releases.set(request, resolve));
    await route.fulfill(request === 2 ? { status: 503, json: { error: 'older scan failed' } } : { json: { candidates: [] } });
  });
  await page.goto(server.baseUrl);
  await expect(page.locator('#session-list .card').first()).toBeVisible();
  await expect.poll(() => requests).toBe(1);
  const discover = page.locator('#mobile-discover');
  await discover.tap();
  await expect.poll(() => requests).toBe(2);
  await expect(discover).toBeDisabled();
  await page.locator('#mobile-settings').tap();
  const settingsScan = page.locator('#settings-machines').getByRole('button', { name: 'Discover Tailnet', exact: true });
  await settingsScan.click();
  await settingsScan.click();
  expect(requests).toBe(2);
  releases.get(2)!();
  await expect.poll(() => requests).toBe(3);
  await expect(discover).toBeDisabled();
  await expect(discover).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#mobile-discover-status')).toContainText('Scanning');
  releases.get(3)!();
  await expect(discover).toBeEnabled();
  await expect(discover).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#discover-status')).toContainText('No ready Wolfpack machines found on Tailnet');
  await expect(page.locator('#discover-status')).toContainText('Last successful discovery:');
  await expect(page.locator('#mobile-discover-status')).toHaveText('No ready Wolfpack machines found on Tailnet');
  expect(requests).toBe(3);
  await capture(page, info, 'coalesced');
});

for (const width of [320, 375, 390]) test(`mobile Discover shows pending, ready, empty and retry feedback in place at ${width}`, async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'mobile action and responsive geometry');
  await page.setViewportSize({ width, height: 844 });
  let mode: 'empty' | 'ready' | 'error' = 'empty';
  let requests = 0;
  let release: (() => void) | undefined;
  let hold = false;
  await page.route('**/api/tailnet/v1/candidates', async route => {
    requests++;
    if (hold) await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill(mode === 'error' ? { status: 503, json: { error: 'scan unavailable <retry>' } } : { json: { candidates: mode === 'ready' ? [
      { hostname: 'discover.example.ts.net', tailnetNodeId: 'n-discover', origin: 'https://discover.example.ts.net', online: true },
    ] : [] } });
  });
  await page.route('https://discover.example.ts.net/api/machine', route => route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: {
    protocol: { name: 'wolfpack-machine', major: 1, minor: 0 },
    machine: { tailnetNodeId: 'n-discover', installationId: '22222222-2222-4222-8222-222222222222', displayName: 'discovered peer', origin: 'https://discover.example.ts.net' },
    wolfpack: { version: '1.7.0' }, capabilities: ['sessions', 'terminal-websocket', 'push-subscription'],
  } }));
  await page.route('https://discover.example.ts.net/api/sessions', route => route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { sessions: [] } }));
  const startup = page.waitForResponse('**/api/tailnet/v1/candidates');
  await page.goto(server.baseUrl);
  await startup;
  await expect(page.locator('#session-list .card').first()).toBeVisible();
  await capture(page, info, 'before');
  const nav = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  expect(await nav.locator(':scope > *').allTextContents()).toEqual(['Sessions', 'Discover', 'Settings']);
  const discover = nav.getByRole('button', { name: 'Discover Tailnet', exact: true });
  const status = page.locator('#mobile-discover-status');
  await expect(discover.locator('svg')).toHaveCSS('width', '24px');
  const boxes = await nav.locator(':scope > *').evaluateAll(els => els.map(el => { const { x, width, height } = el.getBoundingClientRect(); return { x, width, height }; }));
  for (let i = 0; i < boxes.length; i++) {
    expect(boxes[i]!.width).toBeGreaterThanOrEqual(44);
    expect(boxes[i]!.height).toBeGreaterThanOrEqual(44);
    expect(Math.abs(boxes[i]!.x + boxes[i]!.width / 2 - width * (i + 0.5) / 3)).toBeLessThan(1);
  }
  const before = requests;
  mode = 'ready'; hold = true;
  await discover.tap();
  await expect.poll(() => requests).toBe(before + 1);
  await expect(discover).toBeDisabled();
  await expect(discover).toHaveAttribute('aria-busy', 'true');
  await expect(status).toBeVisible();
  await expect(status).toContainText(/scanning/i);
  await expect(status).not.toHaveCSS('color', 'rgb(85, 85, 85)');
  await capture(page, info, 'busy');
  const focus = await page.evaluateHandle(() => document.activeElement);
  hold = false; release!();
  await expect(status).toContainText('Found 1 ready Tailnet machine');
  await expect(discover).toBeEnabled();
  await expect(discover).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#sessions-view')).toHaveClass(/visible/);
  expect(await focus.evaluate(node => node === document.activeElement)).toBe(true);
  await focus.dispose();
  await capture(page, info, 'success');
  mode = 'empty';
  await discover.tap();
  await expect(status).toContainText('No ready Wolfpack machines found on Tailnet');
  await capture(page, info, 'empty');
  mode = 'error';
  await discover.tap();
  await expect(status).toContainText('scan unavailable <retry>');
  await expect(status.locator('retry')).toHaveCount(0);
  await expect(discover).toBeEnabled();
  await expect(discover).toHaveAttribute('aria-busy', 'false');
  await capture(page, info, 'error');
  mode = 'ready';
  await discover.tap();
  await expect(status).toContainText('Found 1 ready Tailnet machine');
  await expect(discover).toBeEnabled();
  await capture(page, info, 'after');
  await page.getByRole('button', { name: 'Open test-project', exact: true }).first().click();
  await expect(page.locator('#mobile-tab-bar')).toBeHidden();
  await expect(status).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(status).toBeHidden();
});
