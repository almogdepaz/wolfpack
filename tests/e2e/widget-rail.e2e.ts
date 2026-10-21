import { expect, test, type Locator, type Page } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers';
import { mockLayoutWidget } from './widget-fixture';
import { dockPanel } from './workspace-drag-helpers';

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });
const titles = ['Widgets', 'Build output', 'Verification details'];

async function labelGeometry(panel: Locator) {
  return panel.locator('[role=tab]').evaluateAll(tabs => tabs.map(tab => {
    const style = getComputedStyle(tab);
    const vertical = style.writingMode === 'vertical-rl';
    const range = document.createRange();
    range.selectNodeContents(tab);
    const text = range.getBoundingClientRect();
    const first = range.cloneRange();
    first.setEnd(tab.firstChild!, 1);
    const glyph = first.getBoundingClientRect();
    const canvas = document.createElement('canvas').getContext('2d')!;
    canvas.font = style.font;
    return {
      title: tab.textContent,
      textBounds: { x: text.x, y: text.y, right: text.right, bottom: text.bottom },
      contentInline: (vertical ? tab.clientHeight : tab.clientWidth) - parseFloat(style.paddingInlineStart) - parseFloat(style.paddingInlineEnd),
      intrinsicInline: vertical ? text.height : text.width,
      firstGlyphInline: vertical ? glyph.height : glyph.width,
      ellipsisInline: canvas.measureText('…').width,
    };
  }));
}

async function openWidgetFixture(page: Page, titles: readonly string[]) {
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
  await expect(page.locator('#desktop-terminal-container')).toHaveAttribute('data-terminal-load-state', 'live');
}

async function tabGeometry(panel: Locator) {
  return panel.evaluate(panel => {
    const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const style = (el: Element) => { const s = getComputedStyle(el); return { margin: s.margin, padding: s.padding, gap: s.gap, background: s.backgroundColor, color: s.color, radius: s.borderRadius, shadow: s.boxShadow, flex: s.flex, writingMode: s.writingMode, overflow: s.overflow, textOverflow: s.textOverflow, whiteSpace: s.whiteSpace }; };
    const bar = panel.querySelector('[data-extension-tabs]')!;
    return { panel: rect(panel), bar: { ...rect(bar), ...style(bar), clientHeight: bar.clientHeight, scrollHeight: bar.scrollHeight, scrollTop: bar.scrollTop }, tabs: Array.from(bar.querySelectorAll('[role=tab]')).map(tab => ({ title: tab.textContent, selected: tab.getAttribute('aria-selected'), ...rect(tab), ...style(tab), clientWidth: tab.clientWidth, scrollWidth: tab.scrollWidth, clientHeight: tab.clientHeight, scrollHeight: tab.scrollHeight })) };
  });
}

for (const area of ['left', 'right', 'bottom'] as const) test(`${area} widget rail fills its dock and preserves expanded and peek behavior`, async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop dock rails; mobile uses its existing Widgets screen');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWidgetFixture(page, titles);
  const terminal = page.locator('#desktop-terminal-container');
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

test('short collapsed rail scrolls later widgets into pointer reach', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop collapsed rail scroll fallback');
  await page.setViewportSize({ width: 1440, height: 400 });
  const manyTitles = Array.from({ length: 20 }, (_, index) => `Widget ${String(index + 1).padStart(2, '0')}`);
  await openWidgetFixture(page, manyTitles);
  for (const title of manyTitles) {
    await page.getByRole('tab', { name: title, exact: true }).click();
    await page.getByRole('button', { name: `Collapse ${title}`, exact: true }).click();
  }
  const rail = page.locator('.widget-panel[data-widget-area="right"][data-collapsed="true"]:visible');
  await expect(rail).toHaveCount(1);
  const bar = rail.locator('[data-extension-tabs]');
  const last = rail.getByRole('tab', { name: 'Widget 20', exact: true });
  await page.mouse.move(500, 100);
  const before = await tabGeometry(rail);
  await info.attach('short-rail-before-wheel', { body: JSON.stringify(before), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('short-many-before-wheel.png'), caret: 'hide' });
  const labels = await labelGeometry(rail);
  await info.attach('short-rail-label-metrics', { body: JSON.stringify(labels), contentType: 'application/json' });
  for (const label of labels) {
    // Native Range measures these short Latin fixture titles in their writing
    // axis; client dimensions round to integers, hence the one-pixel tolerance.
    expect(label.contentInline, `${label.title} has room to paint its name`).toBeGreaterThanOrEqual(label.intrinsicInline - 1);
  }
  const box = (await rail.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Hover opens a peek asynchronously; its selected/bold label changes the
  // intrinsic scroll extent. Wait for that real state before scrolling to end.
  await expect(rail.locator('[role=tab][aria-selected=true]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^Pin Widget / })).toBeVisible();
  await page.mouse.wheel(0, 10000);
  // Do not use locator.click/hover here: Playwright could auto-scroll the last
  // tab and hide a broken wheel fallback. Prove physical reach before clicking.
  const wheelPositions: object[] = [];
  try {
    await expect.poll(async () => {
      const target = (await last.boundingBox())!;
      const bounds = (await rail.boundingBox())!;
      const scroll = await bar.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
      wheelPositions.push({ target, bounds, scroll });
      const reached = target.y >= bounds.y && target.y + target.height <= bounds.y + bounds.height;
      // Scrolling also moves hover/selection between intrinsic-sized labels.
      // Continue actual wheel input across that reflow; never auto-scroll a locator.
      if (!reached) await page.mouse.wheel(0, 10000);
      return reached;
    }).toBe(true);
  } finally {
    await info.attach('short-wheel-positions', { body: JSON.stringify(wheelPositions), contentType: 'application/json' });
  }
  const scrollTop = await bar.evaluate(el => el.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  const target = (await last.boundingBox())!;
  await page.screenshot({ path: info.outputPath('short-many-scrolled.png'), caret: 'hide' });
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
  await expect(page.getByRole('button', { name: 'Pin Widget 20', exact: true })).toBeVisible();
  await expect(page.locator('[data-context-view="test-widgets/view-19"]')).toBeVisible();
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await expect(last).toHaveCSS('color', 'rgb(69, 237, 126)');
  const selectedLabel = (await labelGeometry(rail)).find(label => label.title === 'Widget 20')!;
  const visibleRail = (await rail.boundingBox())!;
  expect(selectedLabel.contentInline).toBeGreaterThanOrEqual(selectedLabel.intrinsicInline - 1);
  expect(selectedLabel.textBounds.x).toBeGreaterThanOrEqual(visibleRail.x);
  expect(selectedLabel.textBounds.right).toBeLessThanOrEqual(visibleRail.x + visibleRail.width);
  expect(selectedLabel.textBounds.y).toBeGreaterThanOrEqual(visibleRail.y);
  expect(selectedLabel.textBounds.bottom).toBeLessThanOrEqual(visibleRail.y + visibleRail.height);
  await info.attach('short-rail-pointer-proof', { body: JSON.stringify({ scrollTop, before, selectedLabel, after: await tabGeometry(rail) }), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('short-many-peek.png'), caret: 'hide' });
});

for (const area of ['left', 'right', 'bottom'] as const) test(`${area} rail truncates an oversized label within its scroll viewport`, async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop dock rail labels');
  await page.setViewportSize({ width: 1440, height: 900 });
  const longTitle = 'W'.repeat(120);
  const longTitles = ['Widgets', 'Build output', longTitle];
  await openWidgetFixture(page, longTitles);
  await page.getByRole('tab', { name: 'Widgets', exact: true }).click();
  if (area === 'left') await dockPanel(page, 'Sessions', 'right');
  if (area !== 'right') for (const title of longTitles) await dockPanel(page, title, area);
  for (const title of longTitles) {
    await page.getByRole('tab', { name: title, exact: true }).click();
    await page.getByRole('button', { name: `Collapse ${title}`, exact: true }).click();
  }
  const rail = page.locator(`.widget-panel[data-widget-area="${area}"][data-collapsed="true"]:visible`);
  const last = rail.getByRole('tab', { name: longTitle, exact: true });
  // Leave the collapse control/rail first: existing peek suppression lasts
  // until pointerleave, so moving within that same rail cannot open a peek.
  await page.mouse.move(500, 100);
  const box = (await rail.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: `Pin ${longTitle}`, exact: true })).toBeVisible();
  await expect(page.locator('[data-context-view="test-widgets/view-2"]')).toBeVisible();
  await page.mouse.wheel(area === 'bottom' ? 10000 : 0, area === 'bottom' ? 0 : 10000);
  await expect.poll(async () => {
    const target = (await last.boundingBox())!;
    const bounds = (await rail.boundingBox())!;
    return target.x >= bounds.x && target.x + target.width <= bounds.x + bounds.width
      && target.y >= bounds.y && target.y + target.height <= bounds.y + bounds.height;
  }).toBe(true);
  const label = (await labelGeometry(rail)).find(label => label.title === longTitle)!;
  expect(label.intrinsicInline).toBeGreaterThan(label.contentInline);
  expect(label.contentInline).toBeGreaterThanOrEqual(label.firstGlyphInline + label.ellipsisInline);
  await expect(last).toHaveCSS('text-overflow', 'ellipsis');
  await info.attach(`${area}-long-label-proof`, { body: JSON.stringify({ label, geometry: await tabGeometry(rail) }), contentType: 'application/json' });
  const target = (await last.boundingBox())!;
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
  await expect(page.getByRole('button', { name: `Pin ${longTitle}`, exact: true })).toBeVisible();
  await expect(page.locator('[data-context-view="test-widgets/view-2"]')).toBeVisible();
  const selectedTarget = (await last.boundingBox())!;
  const visibleRail = (await rail.boundingBox())!;
  expect(selectedTarget.x).toBeGreaterThanOrEqual(visibleRail.x);
  expect(selectedTarget.x + selectedTarget.width).toBeLessThanOrEqual(visibleRail.x + visibleRail.width);
  expect(selectedTarget.y).toBeGreaterThanOrEqual(visibleRail.y);
  expect(selectedTarget.y + selectedTarget.height).toBeLessThanOrEqual(visibleRail.y + visibleRail.height);
  await page.screenshot({ path: info.outputPath(`${area}-long-label-peek.png`), caret: 'hide' });
});
