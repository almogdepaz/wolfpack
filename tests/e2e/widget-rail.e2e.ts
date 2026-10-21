import { expect, test, type Locator } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers';
import { mockLayoutWidget } from './widget-fixture';
import { dockPanel } from './workspace-drag-helpers';

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });
const titles = ['Widgets', 'Build output', 'Verification details'];

async function tabGeometry(panel: Locator) {
  return panel.evaluate(panel => {
    const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const style = (el: Element) => { const s = getComputedStyle(el); return { margin: s.margin, padding: s.padding, gap: s.gap, background: s.backgroundColor, color: s.color, radius: s.borderRadius, shadow: s.boxShadow, flex: s.flex, writingMode: s.writingMode, overflow: s.overflow, textOverflow: s.textOverflow, whiteSpace: s.whiteSpace }; };
    const bar = panel.querySelector('[data-extension-tabs]')!;
    return { panel: rect(panel), bar: { ...rect(bar), ...style(bar) }, tabs: Array.from(bar.querySelectorAll('[role=tab]')).map(tab => ({ title: tab.textContent, selected: tab.getAttribute('aria-selected'), ...rect(tab), ...style(tab), clientWidth: tab.clientWidth, scrollWidth: tab.scrollWidth, clientHeight: tab.clientHeight, scrollHeight: tab.scrollHeight })) };
  });
}

for (const area of ['left', 'right', 'bottom'] as const) test(`${area} widget rail fills its dock and preserves expanded and peek behavior`, async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop dock rails; mobile uses its existing Widgets screen');
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockLayoutWidget(page, { 'test-project': '11111111-1111-4111-8111-111111111111' }, titles);
  await page.routeWebSocket(/\/ws\/pty/, socket => socket.onMessage(message => {
    if (typeof message !== 'string') return;
    const frame = JSON.parse(message);
    if (frame.type === 'resize') { socket.send(JSON.stringify({ ...frame, type: 'resize_ack' })); return; }
    if (frame.type !== 'attach') return;
    socket.send(JSON.stringify({ type: 'attach_ack' }));
    socket.send(Buffer.from('Widget rail layout fixture\r\n'));
    if (frame.prefillMode === 'viewport') socket.send(JSON.stringify({ type: 'prefill_viewport' }));
    socket.send(JSON.stringify({ type: 'prefill_done' }));
    socket.send(JSON.stringify({ type: 'pty_ready' }));
  }));
  await page.goto(server.baseUrl);
  await page.getByRole('button', { name: 'Open test-project', exact: true }).first().click();
  const terminal = page.locator('#desktop-terminal-container');
  await expect(terminal).toHaveAttribute('data-terminal-load-state', 'live');
  await expect(page.getByRole('tab', { name: 'Widgets', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Widgets', exact: true }).click();
  if (area === 'left') await dockPanel(page, 'Sessions', 'right');
  if (area !== 'right') for (const title of titles) await dockPanel(page, title, area);
  await page.getByRole('tab', { name: 'Widgets', exact: true }).click();
  const panel = () => page.locator(`.widget-panel[data-widget-area="${area}"][data-collapsed="false"]:visible`);
  const rail = () => page.locator(`.widget-panel[data-widget-area="${area}"][data-collapsed="true"]:visible`);
  const neutralPointer = async () => { const box = (await terminal.boundingBox())!; await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); };
  const capture = async (state: string, target: Locator) => {
    await page.screenshot({ path: info.outputPath(`${area}-${state}.png`), animations: 'disabled', caret: 'hide' });
    const geometry = await tabGeometry(target);
    await info.attach(`${area}-${state}-geometry`, { body: JSON.stringify(geometry), contentType: 'application/json' });
    return geometry;
  };
  await neutralPointer();
  const expanded = await capture('expanded', panel());
  expect(expanded.bar.margin).toBe('8px');
  expect(expanded.bar.padding).toBe('3px');
  expect(expanded.bar.radius).toBe('10px');
  for (const title of titles) {
    await page.getByRole('tab', { name: title, exact: true }).click();
    await page.getByRole('button', { name: `Collapse ${title}`, exact: true }).click();
  }
  await neutralPointer();
  await expect(rail()).toHaveCount(1);
  const collapsed = await capture('collapsed', rail());
  // Fill the dock's content box, not an inset segmented pill. The existing
  // widget panel has a one-pixel border on every edge.
  expect.soft(collapsed.bar.x).toBeCloseTo(collapsed.panel.x + 1, 0);
  expect.soft(collapsed.bar.y).toBeCloseTo(collapsed.panel.y + 1, 0);
  expect.soft(collapsed.bar.width).toBeCloseTo(collapsed.panel.width - 2, 0);
  expect.soft(collapsed.bar.height).toBeCloseTo(collapsed.panel.height - 2, 0);
  expect.soft(collapsed.bar.margin).toBe('0px');
  expect.soft(collapsed.bar.radius).toBe('0px');
  expect.soft(collapsed.bar.background).toBe('rgba(0, 0, 0, 0)');
  for (const tab of collapsed.tabs) {
    expect.soft(tab.x).toBeGreaterThanOrEqual(collapsed.bar.x);
    expect.soft(tab.right).toBeLessThanOrEqual(collapsed.bar.right + 1);
    expect.soft(tab.y).toBeGreaterThanOrEqual(collapsed.bar.y);
    expect.soft(tab.bottom).toBeLessThanOrEqual(collapsed.bar.bottom + 1);
    expect.soft(tab.whiteSpace).toBe('nowrap');
    expect.soft(tab.textOverflow).toBe('ellipsis');
    if (area !== 'bottom') {
      expect.soft(tab.width).toBeCloseTo(collapsed.bar.width, 0);
      expect.soft(tab.writingMode).toBe('vertical-rl');
      expect.soft(tab.scrollWidth).toBeLessThanOrEqual(tab.clientWidth + 1);
    } else {
      expect.soft(tab.height).toBeCloseTo(collapsed.bar.height, 0);
      expect.soft(tab.scrollHeight).toBeLessThanOrEqual(tab.clientHeight + 1);
    }
  }
  const terminalBox = await terminal.boundingBox();
  const saved = await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1'));
  await rail().getByRole('tab', { name: 'Widgets', exact: true }).hover();
  await expect(page.getByRole('button', { name: 'Pin Widgets', exact: true })).toBeVisible();
  await expect(page.locator('.widget-panel[data-peek=true]')).toHaveCount(1);
  const peek = await capture('peek', rail());
  expect(await terminal.boundingBox()).toEqual(terminalBox);
  expect(await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1'))).toBe(saved);
  const selected = peek.tabs.find(tab => tab.title === 'Widgets')!;
  const unselected = peek.tabs.find(tab => tab.title === 'Build output')!;
  expect(selected.selected).toBe('true');
  expect.soft(selected.color).toBe('rgb(69, 237, 126)');
  expect.soft(selected.background).not.toBe(unselected.background);
  const pin = page.getByRole('button', { name: 'Pin Widgets', exact: true });
  await pin.focus();
  await page.locator('.widget-panel[data-peek=true]').hover();
  await pin.press('Escape');
  await expect(page.locator('.widget-panel[data-peek=true]')).toHaveCount(0);
  const restore = rail().getByRole('tab', { name: 'Widgets', exact: true });
  await expect(restore).toBeFocused();
  expect.soft(await restore.evaluate(el => getComputedStyle(el).outlineOffset)).toBe('-2px');
  await restore.press('Enter');
  await expect(page.getByRole('button', { name: 'Pin Widgets', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pin Widgets', exact: true }).click();
  await expect(page.locator('.widget-panel[data-peek=true]')).toHaveCount(0);
  await neutralPointer();
  const pinned = await tabGeometry(panel());
  expect(pinned.bar).toEqual(expanded.bar);
  expect(pinned.tabs).toEqual(expanded.tabs);
  await info.attach(`${area}-state-proof`, { body: JSON.stringify({ expanded, collapsed, peek, pinned }), contentType: 'application/json' });
});
