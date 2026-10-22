import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { start, skipIfNoBroker, type BrokerTestOwnership, type BrokerTestServer } from './broker-helpers';
import { createOwnedTestServerHome, removeOwnedTestServerHome, type OwnedTestServerHome } from './test-server-home';
import { mockLayoutWidget } from './widget-fixture';
import { dockPanel } from './workspace-drag-helpers';

// Only extension catalog/assets are fixtures; terminal transport uses a private native broker.
test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
test.beforeEach(async ({}, info) => { test.skip(info.project.name !== 'desktop', 'desktop two-widget area behavior'); });
let server: BrokerTestServer;
let ownership: BrokerTestOwnership | undefined;
let home: OwnedTestServerHome;
const first = 'test-widgets/view';
const second = 'test-widgets/view-1';
const key = 'wolfpack-widget-layout:v1';

test.beforeAll(async ({}, info) => {
  home = createOwnedTestServerHome();
  const dev = join(home.path, 'dev');
  mkdirSync(join(dev, 'panel-pin'), { recursive: true });
  const isolated = { HOME: home.path, ZDOTDIR: home.path, SHELL: '/bin/sh' };
  server = await start({
    brokerEnvOverrides: isolated,
    envOverrides: { ...isolated, WOLFPACK_DEV_DIR: dev, WOLFPACK_TAILSCALE_STATUS_JSON: '{}', WOLFPACK_MACHINE_ID_PATH: join(home.path, 'machine-id') },
    onOwnership: owner => { ownership = owner; },
  });
  const assets: Record<string, string> = {};
  for (const file of ['app.bundle.js', 'styles.css']) {
    const response = await fetch(`${server.baseUrl}/${file}`);
    expect(response.ok).toBe(true);
    const served = Buffer.from(await response.arrayBuffer());
    expect(served.equals(readFileSync(join(import.meta.dirname, '../../public', file)))).toBe(true);
    assets[file] = createHash('sha256').update(served).digest('hex');
  }
  await writeFile(info.outputPath('served-assets.json'), JSON.stringify(assets, null, 2));
  const response = await fetch(`${server.baseUrl}/api/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'panel-pin', cmd: 'shell', sessionName: 'panel-pin-shell' }),
  });
  expect(response.ok).toBe(true);
});

test.afterAll(async () => {
  await ownership?.teardown();
  if (home) removeOwnedTestServerHome(home);
});

async function openPair(page: Page, states: 'mixed' | 'open' | 'collapsed', failingTitles: readonly string[] = []) {
  await mockLayoutWidget(page, {}, ['Panel A', 'Panel B'], failingTitles);
  await page.addInitScript(({ states, key, first, second }) => {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, JSON.stringify({
      placements: { [first]: 'right', [second]: 'right' }, selected: { right: first },
      widgets: states === 'open' ? {} : { ...(states === 'collapsed' ? { [first]: 'collapsed' } : {}), [second]: 'collapsed' },
    }));
  }, { states, key, first, second });
  await page.goto(server.baseUrl);
  await page.locator('.card', { hasText: 'panel-pin-shell' }).first().click();
  await expect(page.locator('#desktop-terminal-container')).toHaveAttribute('data-terminal-load-state', 'live');
  await expect(page.getByRole('tab', { name: 'Panel A', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Panel B', exact: true })).toBeVisible();
  if (states !== 'collapsed') await expect(page.getByRole('tabpanel', { name: 'Panel A', exact: true })).toBeVisible();
  await page.mouse.move(700, 400);
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  // Keep actual attribute transitions, including synchronous changes hidden by the final DOM.
  await page.evaluate(() => {
    const events: object[] = [];
    Object.assign(window, { __panelPinEvents: events });
    new MutationObserver(records => {
      for (const record of records) {
        const element = record.target as HTMLElement;
        if (!element.closest('[data-widget-area="right"]')) continue;
        events.push({ time: Date.now(), attribute: record.attributeName, oldValue: record.oldValue, value: element.getAttribute(record.attributeName!), label: element.getAttribute('aria-label'), tag: element.tagName });
      }
    }).observe(document.querySelector('#workspace-shell')!, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-peek', 'data-collapsed', 'aria-pressed', 'aria-selected'] });
  });
}

async function reloadPair(page: Page) {
  await page.clock.resume();
  await page.reload();
  // Reload returns to the session list; reopen through the real UI before inspecting widget restoration.
  await page.locator('.card', { hasText: 'panel-pin-shell' }).first().click();
  await expect(page.locator('#desktop-terminal-container')).toHaveAttribute('data-terminal-load-state', 'live');
}

async function preferences(page: Page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
}

async function snapshot(page: Page) {
  return page.evaluate(key => ({
    time: Date.now(), preferences: JSON.parse(localStorage.getItem(key)!), focus: document.activeElement?.outerHTML,
    panels: [...document.querySelectorAll<HTMLElement>('[data-widget-area="right"]')].map(node => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { tag: node.tagName, className: node.className, hidden: node.hidden, peek: node.dataset.peek, collapsed: node.dataset.collapsed, geometry: { x, y, width, height } };
    }),
    tabs: [...document.querySelectorAll('[role="tab"]')].map(node => ({ title: node.textContent, selected: node.getAttribute('aria-selected') })),
    pins: [...document.querySelectorAll('[aria-label^="Pin Panel"]')].map(node => ({ label: node.getAttribute('aria-label'), pressed: node.getAttribute('aria-pressed') })),
    events: (window as unknown as { __panelPinEvents?: { attribute: string; oldValue: string | null; label: string | null }[] }).__panelPinEvents,
  }), key);
}

test.afterEach(async ({ page }, info) => {
  if (page.isClosed() || !page.url().startsWith(server?.baseUrl)) return;
  await writeFile(info.outputPath('actual-outcome.json'), JSON.stringify(await snapshot(page), null, 2));
  await page.screenshot({ path: info.outputPath('actual-outcome.png'), caret: 'hide' });
});

test('panel pin baseline 1: mixed pinned area ignores hover on collapsed B', async ({ page }) => {
  await openPair(page, 'mixed');
  const before = await preferences(page);
  await page.getByRole('tab', { name: 'Panel B', exact: true }).hover();
  const probes = [];
  for (const elapsed of [149, 1, 150]) {
    await page.clock.runFor(elapsed);
    probes.push(await snapshot(page));
  }
  await writeFile(test.info().outputPath('hover-timer-probes.json'), JSON.stringify(probes, null, 2));
  await expect(page.locator('.widget-panel[data-peek="true"]')).toHaveCount(0);
  await expect(page.getByRole('tabpanel', { name: 'Panel A', exact: true })).toBeVisible();
  expect(await preferences(page)).toEqual(before);
});

test('panel pin baseline 2: pinned pointer click opens other member without pin transition or peek', async ({ page }) => {
  await openPair(page, 'mixed');
  await page.getByRole('tab', { name: 'Panel B', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Panel B', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Panel B', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Pin Panel B', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await preferences(page)).widgets?.[second] ?? 'open').toBe('open');
  const actual = await snapshot(page);
  expect(actual.events?.filter(event => (event.attribute === 'data-peek' && event.oldValue === 'true') || (event.attribute === 'aria-pressed' && event.label?.startsWith('Pin Panel') && event.oldValue === 'false'))).toEqual([]);
});

test('panel pin baseline 3: minus collapses both open members in one click', async ({ page }) => {
  await openPair(page, 'open');
  await page.getByRole('button', { name: 'Collapse Panel A', exact: true }).click();
  expect((await preferences(page)).widgets).toEqual({ [first]: 'collapsed', [second]: 'collapsed' });
  await expect(page.getByRole('tabpanel', { name: 'Panel A', exact: true })).toBeHidden();
  await expect(page.getByRole('tabpanel', { name: 'Panel B', exact: true })).toBeHidden();
  await expect(page.locator('.widget-panel[data-peek="true"]')).toHaveCount(0);
});

test('panel pin baseline 4: selected pointer tab collapses the whole two-member area', async ({ page }) => {
  await openPair(page, 'open');
  await page.getByRole('tab', { name: 'Panel A', exact: true }).click();
  expect((await preferences(page)).widgets).toEqual({ [first]: 'collapsed', [second]: 'collapsed' });
  await expect(page.getByRole('tabpanel', { name: 'Panel A', exact: true })).toBeHidden();
  await expect(page.getByRole('tabpanel', { name: 'Panel B', exact: true })).toBeHidden();
});

test('panel pin baseline 5: panel pin remains stable across keyboard tab activation', async ({ page }) => {
  await openPair(page, 'mixed');
  await expect(page.getByRole('button', { name: 'Pin Panel A', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tab', { name: 'Panel B', exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: 'Pin Panel B', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Panel B', exact: true })).toBeVisible();
  await expect(page.locator('.widget-panel[data-peek="true"]')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Panel A', exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: 'Pin Panel A', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('panel pin baseline 6: fully collapsed pointer click pins the chosen member', async ({ page }) => {
  await openPair(page, 'collapsed');
  await page.getByRole('tab', { name: 'Panel B', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Panel B', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Panel B', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pin Panel B', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.widget-panel[data-peek="true"]')).toHaveCount(0);
  const after = await preferences(page);
  expect(after.widgets?.[second] ?? 'open').toBe('open');
  expect(after.widgets?.[first]).toBe('collapsed');
  expect(after.selected.right).toBe(second);
});

for (const action of ['pin', 'minus', 'selected tab'] as const) for (const fullView of [false, true]) test(`native terminal and both widget bodies survive whole-area ${action}; fullView=${fullView}`, async ({ page }, info) => {
  let sockets = 0;
  page.on('websocket', socket => { if (socket.url().includes('/ws/pty')) sockets++; });
  await openPair(page, 'open');
  const a = page.locator('[data-context-view="test-widgets/view"]');
  const b = page.locator('[data-context-view="test-widgets/view-1"]');
  await page.getByRole('tab', { name: 'Panel B', exact: true }).press('Enter');
  await page.getByRole('tab', { name: 'Panel A', exact: true }).press('Enter');
  const aNode = await a.elementHandle(), bNode = await b.elementHandle();
  const canvas = page.locator('#desktop-terminal-container canvas');
  const canvasNode = await canvas.elementHandle();
  const canvasParent = await canvas.evaluateHandle(node => node.parentElement);
  expect(sockets).toBe(1);
  if (fullView) await page.getByRole('button', { name: 'Context full view', exact: true }).click();
  await writeFile(info.outputPath('before-collapse.json'), JSON.stringify(await snapshot(page), null, 2));
  await page.screenshot({ path: info.outputPath('before-collapse.png'), caret: 'hide' });
  if (action === 'pin') await page.getByRole('button', { name: 'Pin Panel A', exact: true }).click();
  else if (action === 'minus') await page.getByRole('button', { name: 'Collapse Panel A', exact: true }).click();
  else await page.getByRole('tab', { name: 'Panel A', exact: true }).click();
  expect((await preferences(page)).widgets).toEqual({ [first]: 'collapsed', [second]: 'collapsed' });
  const tab = page.getByRole('tab', { name: 'Panel A', exact: true });
  await expect(tab).toBeFocused();
  await expect(a).toBeHidden(); await expect(b).toBeHidden();
  await expect(page.getByRole('button', { name: 'Restore workspace', exact: true })).toBeHidden();
  await page.clock.runFor(800); // Keep the actual pointer stationary: collapse must not re-open itself.
  await expect(page.locator('.widget-panel[data-peek="true"]')).toHaveCount(0);
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((node, previous) => node === previous, canvasNode)).toBe(true);
  expect(await canvas.evaluate((node, parent) => node.parentElement === parent, canvasParent)).toBe(true);
  await writeFile(info.outputPath('collapsed.json'), JSON.stringify(await snapshot(page), null, 2));
  await page.screenshot({ path: info.outputPath('collapsed.png'), caret: 'hide' });
  await page.getByRole('tab', { name: 'Panel B', exact: true }).click();
  await expect(b).toBeVisible();
  expect(await a.evaluate((node, previous) => node === previous, aNode)).toBe(true);
  expect(await b.evaluate((node, previous) => node === previous, bNode)).toBe(true);
  expect(sockets).toBe(1);
  await writeFile(info.outputPath('native-retention.json'), JSON.stringify({ sockets, canvasRetained: true, parentRetained: true, widgetBodiesRetained: true }, null, 2));
});

for (const fullView of [false, true]) test(`native Main unpin prefers Terminal over Sessions without mounting a throwing peer; fullView=${fullView}`, async ({ page }, info) => {
  await page.addInitScript(({ key, first, second }) => localStorage.setItem(key, JSON.stringify({
    placements: { [first]: 'right', [second]: 'main', ':sessions': 'main' }, selected: { right: first, main: ':terminals' },
  })), { key, first, second });
  let sockets = 0;
  page.on('websocket', socket => { if (socket.url().includes('/ws/pty')) sockets++; });
  await openPair(page, 'open', ['Panel B']);
  const canvas = page.locator('#desktop-terminal-container canvas');
  const node = await canvas.elementHandle();
  const parent = await canvas.evaluateHandle(node => node.parentElement);
  const body = page.getByRole('tabpanel', { name: 'Panel A', exact: true });
  const retained = await body.elementHandle();
  await dockPanel(page, 'Panel A', 'main');
  if (fullView) await page.getByRole('button', { name: 'Context full view', exact: true }).click();
  await page.screenshot({ path: info.outputPath('main-before.png'), caret: 'hide' });
  await page.getByRole('button', { name: 'Pin Panel A', exact: true }).click();
  const samples = [];
  for (const ms of [0, 150, 150, 500]) {
    await page.clock.runFor(ms);
    await expect(canvas).toBeVisible();
    const geometry = await canvas.boundingBox();
    samples.push({ time: await page.evaluate(() => Date.now()), geometry, focus: await page.evaluate(() => document.activeElement?.outerHTML) });
    expect(geometry!.height).toBeGreaterThan(100);
    await expect(page.getByRole('tab', { name: 'Terminal grid', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.widget-panel[data-peek="true"]')).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: 'Restore workspace', exact: true })).toBeHidden();
  await page.screenshot({ path: info.outputPath('main-collapsed.png'), caret: 'hide' });
  const saved = await preferences(page);
  expect(saved.widgets).toEqual({ [first]: 'collapsed', [second]: 'collapsed' });
  expect(saved.placements[':sessions']).toBe('main');
  expect(saved.selected.main).toBe(':terminals');
  expect(await page.evaluate(() => (window as unknown as { __layoutWidgetMountAttempts: Record<string, number> }).__layoutWidgetMountAttempts['Panel B'] ?? 0)).toBe(0);
  // Even collapsed widgets activate as ordinary open tabs beside immutable native Main members.
  await page.getByRole('tab', { name: 'Panel A', exact: true }).hover();
  await page.clock.runFor(500);
  await expect(canvas).toBeVisible();
  await page.getByRole('tab', { name: 'Panel A', exact: true }).press('Enter');
  await expect(body).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pin Panel A', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.widget-panel[data-peek="true"]')).toHaveCount(0);
  expect(await canvas.evaluate((current, previous) => current === previous, node)).toBe(true);
  expect(await canvas.evaluate((current, previous) => current.parentElement === previous, parent)).toBe(true);
  expect(await body.evaluate((current, previous) => current === previous, retained)).toBe(true);
  expect(sockets).toBe(1);
  await writeFile(info.outputPath('main-native-proof.json'), JSON.stringify({ saved, sockets, samples, focus: await page.evaluate(() => document.activeElement?.outerHTML) }, null, 2));
});

for (const savedSelection of [second, 'test-widgets/unavailable', null]) test(`mixed reload selects a visible open member with saved selection ${savedSelection}`, async ({ page }) => {
  await openPair(page, 'mixed');
  const saved = await preferences(page);
  saved.selected = savedSelection ? { right: savedSelection } : {};
  await page.evaluate(({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)), { key, saved });
  await reloadPair(page);
  await expect(page.getByRole('tabpanel', { name: 'Panel A', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Panel A', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Pin Panel A', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tab', { name: 'Panel B', exact: true }).press('Enter');
  await reloadPair(page);
  await expect(page.getByRole('tabpanel', { name: 'Panel B', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pin Panel B', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await preferences(page)).selected.right).toBe(second);
});

test('whole-area collapse leaves closed and dormant preferences untouched', async ({ page }) => {
  await openPair(page, 'open');
  const saved = await preferences(page);
  saved.widgets = { [second]: 'closed', 'other/dormant': 'collapsed', 'other/closed': 'closed' };
  saved.placements['other/dormant'] = 'right';
  saved.placements['other/closed'] = 'bottom';
  await page.evaluate(({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)), { key, saved });
  await reloadPair(page);
  await expect(page.getByRole('tabpanel', { name: 'Panel A', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Panel B', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Collapse Panel A', exact: true }).click();
  expect(await preferences(page)).toEqual({ ...saved, widgets: { ...saved.widgets, [first]: 'collapsed' } });
});

test('failed mixed-area activation preserves the pinned body, preferences and native socket', async ({ page }) => {
  let sockets = 0;
  page.on('websocket', socket => { if (socket.url().includes('/ws/pty')) sockets++; });
  await openPair(page, 'mixed', ['Panel B']);
  const a = page.getByRole('tabpanel', { name: 'Panel A', exact: true });
  const retained = await a.elementHandle();
  const before = await preferences(page);
  const b = page.getByRole('tab', { name: 'Panel B', exact: true });
  for (const activation of ['pointer', 'keyboard']) {
    if (activation === 'pointer') await b.click(); else await b.press('Enter');
    await expect(b).toBeFocused();
    await expect(a).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pin Panel A', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('status').filter({ hasText: 'Fixture mount failed: Panel B' })).toBeVisible();
    await expect(page.locator('.widget-panel[data-peek="true"]')).toHaveCount(0);
    expect(await preferences(page)).toEqual(before);
    expect(await a.evaluate((node, previous) => node === previous, retained)).toBe(true);
  }
  expect(sockets).toBe(1);
});

test('native two-widget touch activation pins the chosen member and selected touch collapses the area', async ({ browser }, info) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 1280, height: 720 } });
  try {
    const page = await context.newPage();
    let sockets = 0;
    page.on('websocket', socket => { if (socket.url().includes('/ws/pty')) sockets++; });
    await openPair(page, 'collapsed');
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    const b = page.getByRole('tab', { name: 'Panel B', exact: true });
    await b.tap();
    await expect(page.getByRole('tabpanel', { name: 'Panel B', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pin Panel B', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await b.tap();
    expect((await preferences(page)).widgets).toEqual({ [first]: 'collapsed', [second]: 'collapsed' });
    await page.getByRole('tab', { name: 'Panel A', exact: true }).tap();
    await expect(page.getByRole('tabpanel', { name: 'Panel A', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pin Panel A', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.widget-panel[data-peek="true"]')).toHaveCount(0);
    expect((await preferences(page)).widgets).toEqual({ [second]: 'collapsed' });
    expect(sockets).toBe(1);
    await writeFile(info.outputPath('touch-proof.json'), JSON.stringify({ sockets, actual: await snapshot(page) }, null, 2));
    await page.screenshot({ path: info.outputPath('touch-pinned.png'), caret: 'hide' });
  } finally { await context.close(); }
});
