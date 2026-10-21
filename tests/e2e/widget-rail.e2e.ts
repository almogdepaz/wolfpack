import { writeFile } from 'node:fs/promises';
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

async function openWidgetFixture(page: Page, titles: readonly string[], failingTitles: readonly string[] = []) {
  await mockLayoutWidget(page, { 'test-project': '11111111-1111-4111-8111-111111111111' }, titles, failingTitles);
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
  await page.getByRole('tab', { name: 'Widgets', exact: true }).press('Enter');
  const panel = () => page.locator(`.widget-panel[data-widget-area="${area}"][data-collapsed="false"]:visible`);
  const rail = () => page.locator(`.widget-panel[data-widget-area="${area}"][data-collapsed="true"]:visible`);
  const neutralPointer = async () => { const box = (await terminal.boundingBox())!; await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); };
  const capture = async (state: string, target: Locator) => {
    await page.screenshot({ path: info.outputPath(`${area}-${state}.png`), animations: 'disabled', caret: 'hide' });
    const overlay = page.locator('.widget-panel[data-peek=true]');
    const geometry = { ...await tabGeometry(target), main: await terminal.boundingBox(), overlay: await overlay.count() ? await overlay.boundingBox() : null };
    await writeFile(info.outputPath(`${area}-${state}-geometry.json`), JSON.stringify(geometry, null, 2));
    return geometry;
  };
  await neutralPointer();
  const expanded = await capture('expanded', panel());
  expect(expanded.bar.margin).toBe('8px');
  expect(expanded.bar.padding).toBe('3px');
  expect(expanded.bar.radius).toBe('10px');
  for (const title of titles) {
    await page.getByRole('tab', { name: title, exact: true }).press('Enter');
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
  const pinned = await capture('pinned', panel());
  expect(pinned.bar).toEqual(expanded.bar);
  expect(pinned.tabs).toEqual(expanded.tabs);
  await writeFile(info.outputPath(`${area}-state-proof.json`), JSON.stringify({ expanded, collapsed, peek, pinned, collapsedTerminal: terminalBox, pinnedTerminal: await terminal.boundingBox() }, null, 2));
});

for (const count of [1, 2]) for (const state of ['pinned', 'peek', 'collapsed'] as const) test(`${state} tab click toggles pin or collapse without a second action (${count} widgets)`, async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop tab click regression');
  await openWidgetFixture(page, count === 1 ? ['Widgets'] : ['Widgets', 'Build output']);
  const tab = page.getByRole('tab', { name: 'Widgets', exact: true });
  if (count === 2) await tab.press('Enter');
  if (state !== 'pinned') await page.getByRole('button', { name: 'Collapse Widgets', exact: true }).click();
  await page.mouse.move(700, 400);
  if (state === 'peek') {
    await tab.hover();
    await expect(page.locator('.widget-panel[data-peek=true]')).toHaveCount(1);
  }
  await tab.click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('wolfpack-widget-layout:v1')!));
  expect(saved.widgets?.['test-widgets/view']).toBe(state === 'pinned' ? 'collapsed' : undefined);
  await expect(page.locator('.widget-panel[data-peek=true]')).toHaveCount(0);
});

for (const area of ['bottom', 'right'] as const) test(`failed ${area} candidate mount retains the healthy occupied Preview and lifecycle`, async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop transactional preview mount rollback');
  await page.addInitScript(area => localStorage.setItem('wolfpack-widget-layout:v1', JSON.stringify({ widgets: { 'test-widgets/view': 'collapsed' }, placements: { 'test-widgets/view-3': area, 'test-widgets/view-4': 'bottom' }, selected: { right: 'test-widgets/view-2', bottom: 'test-widgets/view-4' } })), area);
  await openWidgetFixture(page, ['Preview', 'First pinned', 'Selected pinned', 'Broken', 'Bottom healthy'], ['Broken']);
  const selected = page.locator('[data-context-view="test-widgets/view-2"]');
  const preview = page.locator('[data-context-view="test-widgets/view"]');
  const bottom = page.locator('[data-context-view="test-widgets/view-4"]');
  await expect(selected).toBeVisible(); await expect(bottom).toBeVisible();
  const bottomNode = await bottom.elementHandle();
  const selectedNode = await selected.elementHandle();
  const saved = await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1'));
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.getByRole('tab', { name: 'Preview', exact: true }).hover(); await page.clock.runFor(150);
  await expect(preview).toBeVisible();
  const previewNode = await preview.elementHandle();
  const broken = page.getByRole('tab', { name: 'Broken', exact: true });
  await broken.hover(); await broken.press('Enter');
  await expect(page.locator(`.widget-panel[data-widget-area="${area}"]:visible`).getByRole('status').filter({ hasText: 'Fixture mount failed: Broken' })).toBeVisible();
  if (area === 'bottom') await expect(broken).toBeFocused();
  const after = await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1'));
  await writeFile(info.outputPath('rollback.json'), JSON.stringify({ saved, after, previewVisible: await preview.isVisible(), selectedVisible: await selected.isVisible(), bottomVisible: await bottom.isVisible(), right: await tabGeometry(page.locator('.widget-panel[data-widget-area="right"]:visible')) }, null, 2));
  await page.screenshot({ path: info.outputPath('rollback.png'), caret: 'hide' });
  expect(after).toBe(saved);
  await expect(bottom).toBeVisible();
  expect(await bottom.evaluate((node, previous) => node === previous, bottomNode)).toBe(true);
  // A failed speculative mount must retain the CURRENT preview, not substitute any open sibling.
  await expect(preview).toBeVisible();
  await expect(selected).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Preview', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await preview.evaluate((node, previous) => node === previous, previewNode)).toBe(true);
  if (area === 'bottom') {
    // Pointer and focus are outside Preview. Failure must not consume its armed leave timer.
    const focus = await page.evaluateHandle(() => document.activeElement);
    await page.clock.runFor(299); await expect(preview).toBeVisible();
    const at299 = { previewVisible: await preview.isVisible() };
    await page.clock.runFor(1); await expect(preview).toBeHidden();
    await expect(selected).toBeVisible();
    const at300 = { previewVisible: await preview.isVisible(), selectedVisible: await selected.isVisible() };
    await page.clock.runFor(200); await expect(selected).toBeVisible();
    const focusRetained = await focus.evaluate(node => node === document.activeElement);
    expect(focusRetained).toBe(true);
    await focus.dispose();
    await expect(bottom).toBeVisible();
    expect(await bottom.evaluate((node, previous) => node === previous, bottomNode)).toBe(true);
    expect(await selected.evaluate((node, previous) => node === previous, selectedNode)).toBe(true);
    await writeFile(info.outputPath('after-leave.json'), JSON.stringify({ saved, after: await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1')), at299, at300, at500: { previewVisible: await preview.isVisible(), selectedVisible: await selected.isVisible(), bottomVisible: await bottom.isVisible(), focusRetained }, right: await tabGeometry(page.locator('.widget-panel[data-widget-area="right"]:visible')) }, null, 2));
    await page.screenshot({ path: info.outputPath('after-leave.png'), caret: 'hide' });
  } else {
    await page.getByRole('button', { name: 'Pin Preview', exact: true }).press('Escape');
    await expect(page.getByRole('tab', { name: 'Selected pinned', exact: true })).toBeFocused();
    await expect(selected).toBeVisible();
  }
  expect(await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1'))).toBe(saved);
});

for (const dismissal of ['Escape', 'leave'] as const) test(`temporary preview restores the selected non-first pinned sibling after ${dismissal}`, async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop sibling retention');
  await page.addInitScript(() => localStorage.setItem('wolfpack-widget-layout:v1', JSON.stringify({ widgets: { 'test-widgets/view': 'collapsed' }, selected: { right: 'test-widgets/view-2' } })));
  await openWidgetFixture(page, ['Preview', 'First pinned', 'Selected pinned']);
  const selected = page.getByRole('tab', { name: 'Selected pinned', exact: true });
  const content = page.locator('[data-context-view="test-widgets/view-2"]');
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  const retained = await content.elementHandle();
  const saved = await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1'));
  await page.mouse.move(700, 400);
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.getByRole('tab', { name: 'Preview', exact: true }).hover();
  await page.clock.runFor(150);
  await expect(page.getByRole('button', { name: 'Pin Preview', exact: true })).toHaveAttribute('aria-pressed', 'false');
  if (dismissal === 'Escape') await page.getByRole('button', { name: 'Pin Preview', exact: true }).press('Escape');
  else {
    await page.locator('#desktop-terminal-container canvas').click();
    await page.clock.runFor(299); await expect(page.locator('.widget-panel[data-peek=true]')).toHaveCount(1);
    const focus = await page.evaluateHandle(() => document.activeElement);
    await page.clock.runFor(1);
    expect(await focus.evaluate(node => node === document.activeElement)).toBe(true);
    await focus.dispose();
  }
  await expect(page.locator('.widget-panel[data-peek=true]')).toHaveCount(0);
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await expect(content).toBeVisible();
  expect(await content.evaluate((node, previous) => node === previous, retained)).toBe(true);
  if (dismissal === 'Escape') await expect(selected).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1'))).toBe(saved);
  await writeFile(info.outputPath('restored.json'), JSON.stringify({ saved, after: await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1')), geometry: await tabGeometry(page.locator('.widget-panel[data-widget-area="right"]:visible')) }, null, 2));
  await page.screenshot({ path: info.outputPath('restored.png'), caret: 'hide' });
});

for (const savedSelection of ['test-widgets/view', 'test-widgets/unavailable']) test(`preview dismissal falls back to an open sibling when saved selection is ${savedSelection}`, async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop saved-selection fallback');
  await page.addInitScript(saved => localStorage.setItem('wolfpack-widget-layout:v1', JSON.stringify({ widgets: { 'test-widgets/view': 'collapsed' }, selected: { right: saved } })), savedSelection);
  await openWidgetFixture(page, ['Preview', 'First pinned', 'Other pinned']);
  const saved = await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1'));
  await page.getByRole('tab', { name: 'Preview', exact: true }).hover();
  await expect(page.getByRole('button', { name: 'Pin Preview', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pin Preview', exact: true }).press('Escape');
  await expect(page.getByRole('tab', { name: 'First pinned', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-context-view="test-widgets/view-1"]')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1'))).toBe(saved);
});

for (const action of ['activate', 'pin', 'unpin'] as const) test(`rapid other-area ${action} restores the displaced pinned sibling before the leave deadline`, async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop cross-area retention');
  await page.addInitScript(action => localStorage.setItem('wolfpack-widget-layout:v1', JSON.stringify({ placements: { 'test-widgets/view-3': 'bottom' }, selected: { right: 'test-widgets/view-2', bottom: 'test-widgets/view-3' }, widgets: { 'test-widgets/view': 'collapsed', ...(action === 'pin' ? { 'test-widgets/view-3': 'collapsed' } : {}) } })), action);
  await openWidgetFixture(page, ['Preview', 'First pinned', 'Selected pinned', 'Other area']);
  const selected = page.getByRole('tab', { name: 'Selected pinned', exact: true });
  const content = page.locator('[data-context-view="test-widgets/view-2"]');
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  const retained = await content.elementHandle();
  const saved = await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1'));
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.getByRole('tab', { name: 'Preview', exact: true }).hover(); await page.clock.runFor(150);
  await expect(page.getByRole('button', { name: 'Pin Preview', exact: true })).toBeVisible();
  if (action === 'activate') {
    // Move to the real destination before activation, still inside the 300ms leave deadline.
    // Do not leave the pointer over Preview, which would legitimately re-hover it after restore.
    const destination = page.getByRole('tab', { name: 'Other area', exact: true });
    await destination.hover(); await destination.press('Enter');
    await expect(destination).toBeFocused();
  } else if (action === 'pin') await page.getByRole('tab', { name: 'Other area', exact: true }).click();
  else await page.getByRole('button', { name: 'Unpin Other area', exact: true }).click();
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await expect(content).toBeVisible();
  expect(await content.evaluate((node, previous) => node === previous, retained)).toBe(true);
  const after = await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1'));
  if (action === 'activate') expect(after).toBe(saved);
  else expect(JSON.parse(after!).selected).toEqual(JSON.parse(saved!).selected);
  await page.clock.runFor(500);
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await writeFile(info.outputPath('restored.json'), JSON.stringify({ saved, after, geometry: await tabGeometry(page.locator('.widget-panel[data-widget-area="right"]:visible')) }, null, 2));
  await page.screenshot({ path: info.outputPath('restored.png'), caret: 'hide' });
});

test('mixed widget and native areas keep temporary state honest and failed mounts transactional', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop mixed docks');
  await page.addInitScript(() => localStorage.setItem('wolfpack-widget-layout:v1', JSON.stringify({ widgets: { 'test-widgets/view-2': 'collapsed' } })));
  await openWidgetFixture(page, ['Widgets', 'Build output', 'Broken'], ['Broken']);
  const tab = page.getByRole('tab', { name: 'Widgets', exact: true });
  const build = page.getByRole('tab', { name: 'Build output', exact: true });
  const content = page.locator('[data-context-view="test-widgets/view"]');
  await tab.click();
  await page.getByRole('button', { name: 'Collapse Widgets', exact: true }).click();
  await expect(build).toHaveAttribute('aria-selected', 'true');
  const saved = await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1'));
  await tab.press('Enter');
  await expect(page.locator('.widget-panel[data-peek=true]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Pin Widgets', exact: true })).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1'))).toBe(saved);
  await page.getByRole('button', { name: 'Pin Widgets', exact: true }).press('Escape');
  await expect(build).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Broken', exact: true }).click();
  await expect(build).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-context-view="test-widgets/view-1"]')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Broken', exact: true })).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Fixture mount failed' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1'))).toBe(saved);
  await tab.click();
  await page.getByRole('button', { name: 'Unpin Widgets', exact: true }).click();
  await expect(content).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pin Widgets', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Pin Widgets', exact: true }).click();
  await dockPanel(page, 'Widgets', 'main');
  await page.getByRole('button', { name: 'Unpin Widgets', exact: true }).click();
  await expect(content).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pin Widgets', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Pin Widgets', exact: true }).press('Escape');
  await expect(page.locator('#workspace-terminal-region')).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Unpin|Pin) Terminal grid$/ })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Widgets', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unpin Widgets', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('hover intent waits 150ms and cancels when the pointer leaves', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop hover intent');
  await openWidgetFixture(page, ['Widgets']);
  await page.getByRole('button', { name: 'Collapse Widgets', exact: true }).click();
  await page.mouse.move(700, 400);
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.getByRole('tab', { name: 'Widgets', exact: true }).hover();
  await page.clock.runFor(149);
  await expect(page.locator('.widget-panel[data-peek=true]')).toHaveCount(0);
  await page.mouse.move(700, 400);
  await page.clock.runFor(500);
  await expect(page.locator('.widget-panel[data-peek=true]')).toHaveCount(0);
});

test('pin toggle and tab clicks preserve persistent and temporary widget states', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop pin and rail behavior');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWidgetFixture(page, ['Widgets']);
  const tab = page.getByRole('tab', { name: 'Widgets', exact: true });
  const peek = page.locator('.widget-panel[data-peek=true]');
  const terminal = page.locator('#desktop-terminal-container');
  const pin = page.getByRole('button', { name: 'Pin Widgets', exact: true });
  const unpin = page.getByRole('button', { name: 'Unpin Widgets', exact: true });
  await expect(unpin).toBeVisible();
  await expect(unpin).toHaveAttribute('aria-pressed', 'true');
  await expect(unpin.locator('svg')).toHaveAttribute('fill', 'currentColor');
  await page.screenshot({ path: info.outputPath('desktop-AFTER-pinned.png'), caret: 'hide' });
  await unpin.click();
  await expect(peek).toHaveCount(1);
  await expect(pin).toBeFocused();
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await expect(pin.locator('svg')).toHaveAttribute('fill', 'none');
  await expect(peek.getByRole('status')).toHaveText(/click.*pin/i);
  await expect(peek).not.toHaveCSS('box-shadow', 'none');
  const saved = await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1'));
  expect(JSON.parse(saved!).widgets['test-widgets/view']).toBe('collapsed');
  await page.mouse.move(700, 400);
  await pin.press('Escape');
  await expect(peek).toHaveCount(0);
  await expect(tab).toBeFocused();
  const collapsedBox = await terminal.boundingBox();
  await page.screenshot({ path: info.outputPath('desktop-collapsed.png'), caret: 'hide' });
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await tab.hover();
  await page.clock.runFor(149);
  await expect(peek).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(peek).toHaveCount(1);
  expect(await terminal.boundingBox()).toEqual(collapsedBox);
  expect(await page.evaluate(() => localStorage.getItem('wolfpack-widget-layout:v1'))).toBe(saved);
  await page.screenshot({ path: info.outputPath('desktop-peek.png'), caret: 'hide' });
  const geometry = await peek.evaluate(el => {
    const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, shadow: getComputedStyle(el).boxShadow };
  });
  // The rail stays stationary while the overlay is visible. Clicking it pins,
  // rather than merely reselecting the same temporary view.
  await tab.click();
  await expect(peek).toHaveCount(0);
  await expect(unpin).toBeVisible();
  await page.mouse.move(700, 400);
  await page.clock.runFor(500);
  await expect(unpin).toBeVisible();
  await page.screenshot({ path: info.outputPath('desktop-pinned.png'), caret: 'hide' });
  await page.getByRole('button', { name: 'Collapse Widgets', exact: true }).click();
  // Click directly before hover intent fires: touch/no-hover and quick clicks
  // must not require a separate Pin action.
  await tab.click();
  await expect(unpin).toBeVisible();
  await page.getByRole('button', { name: 'Collapse Widgets', exact: true }).click();
  await tab.hover();
  await page.clock.runFor(100);
  await page.mouse.move(700, 400);
  await page.clock.runFor(500);
  await expect(peek).toHaveCount(0);
  await tab.press('Enter');
  await expect(pin).toBeVisible(); // keyboard activation retains temporary peek
  await pin.press('Enter');
  await expect(unpin).toBeVisible();
  await page.getByRole('button', { name: 'Context full view', exact: true }).click();
  await unpin.click();
  await page.clock.runFor(500);
  await expect(peek).toHaveCount(1);
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await pin.click();
  await writeFile(info.outputPath('desktop-state-geometry.json'), JSON.stringify({ collapsedTerminal: collapsedBox, peek: geometry, pinnedTerminal: await terminal.boundingBox() }, null, 2));
});

test('hover timers cancel across leave, pin, navigation, scope disposal and breakpoint changes', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop hover lifecycle');
  await openWidgetFixture(page, ['Widgets']);
  const tab = page.getByRole('tab', { name: 'Widgets', exact: true });
  const peek = page.locator('.widget-panel[data-peek=true]');
  const terminal = page.locator('#desktop-terminal-container');
  await page.getByRole('button', { name: 'Collapse Widgets', exact: true }).click();
  await page.mouse.move(700, 400);
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await tab.hover(); await page.clock.runFor(150); await expect(peek).toHaveCount(1);
  await terminal.locator('canvas').click();
  await page.clock.runFor(299); await expect(peek).toHaveCount(1);
  await page.clock.runFor(1); await expect(peek).toHaveCount(0);
  await tab.hover(); await page.clock.runFor(100);
  await page.locator('#sidebar-settings-btn').click();
  await page.clock.runFor(500); await expect(peek).toHaveCount(0);
  await page.locator('#settings-back-btn').click();
  await page.clock.runFor(1000);
  await expect(terminal).toHaveAttribute('data-terminal-load-state', 'live');
  await expect(peek).toHaveCount(0);
  await tab.hover(); await page.clock.runFor(100);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.runFor(500); await expect(peek).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(peek).toHaveCount(0);
  await page.mouse.move(700, 400); await tab.hover(); await page.clock.runFor(100);
  await page.getByRole('button', { name: 'Open another-project', exact: true }).filter({ visible: true }).first().click();
  await page.clock.runFor(500); await expect(peek).toHaveCount(0);
  await page.getByRole('button', { name: 'Open test-project', exact: true }).filter({ visible: true }).first().click();
  await expect(tab).toBeVisible(); await expect(peek).toHaveCount(0);
  await tab.click(); await page.clock.runFor(500);
  await expect(page.getByRole('button', { name: 'Unpin Widgets', exact: true })).toBeVisible();
});

test('touch contexts pin collapsed desktop tabs and retain the mobile Widgets screen', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'explicit touch-enabled contexts, not mouse emulation');
  for (const desktop of [true, false]) {
    const context = await browser.newContext({ hasTouch: true, isMobile: !desktop, viewport: desktop ? { width: 1440, height: 900 } : { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await openWidgetFixture(page, ['Widgets']);
      expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
      if (desktop) {
        await page.getByRole('button', { name: 'Collapse Widgets', exact: true }).tap();
        await page.getByRole('tab', { name: 'Widgets', exact: true }).tap();
        await expect(page.getByRole('button', { name: 'Unpin Widgets', exact: true })).toBeVisible();
        await expect(page.locator('.widget-panel[data-peek=true]')).toHaveCount(0);
        await page.getByRole('tab', { name: 'Widgets', exact: true }).tap();
        await expect(page.getByRole('button', { name: 'Unpin Widgets', exact: true })).toBeHidden();
        await page.getByRole('tab', { name: 'Widgets', exact: true }).tap();
        await expect(page.getByRole('button', { name: 'Unpin Widgets', exact: true })).toBeVisible();
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('wolfpack-widget-layout:v1')!).widgets?.['test-widgets/view'])).toBeUndefined();
      } else {
        await page.locator('#workspace-restore').tap();
        await expect(page.locator('#workspace-shell')).toHaveAttribute('data-full-view', 'context');
        await expect(page.getByRole('button', { name: /^(Unpin|Pin) Widgets$/ })).toBeHidden();
        await page.getByRole('button', { name: 'Back to terminal', exact: true }).tap();
        await expect(page.locator('#desktop-terminal-container')).toBeVisible();
      }
      await page.screenshot({ path: info.outputPath(desktop ? 'desktop-touch-pinned.png' : 'mobile-touch-terminal.png'), caret: 'hide' });
    } finally { await context.close(); }
  }
});

test('short collapsed rail scrolls later widgets into pointer reach', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop collapsed rail scroll fallback');
  await page.setViewportSize({ width: 1440, height: 400 });
  const manyTitles = Array.from({ length: 20 }, (_, index) => `Widget ${String(index + 1).padStart(2, '0')}`);
  await openWidgetFixture(page, manyTitles);
  for (const title of manyTitles) {
    await page.getByRole('tab', { name: title, exact: true }).press('Enter');
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
  await last.hover();
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
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
  await expect(page.getByRole('button', { name: 'Unpin Widget 20', exact: true })).toBeVisible();
  await expect(page.locator('[data-context-view="test-widgets/view-19"]')).toBeVisible();
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
    await page.getByRole('tab', { name: title, exact: true }).press('Enter');
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
  const selectedTarget = (await last.boundingBox())!;
  const visibleRail = (await rail.boundingBox())!;
  expect(selectedTarget.x).toBeGreaterThanOrEqual(visibleRail.x);
  expect(selectedTarget.x + selectedTarget.width).toBeLessThanOrEqual(visibleRail.x + visibleRail.width);
  expect(selectedTarget.y).toBeGreaterThanOrEqual(visibleRail.y);
  expect(selectedTarget.y + selectedTarget.height).toBeLessThanOrEqual(visibleRail.y + visibleRail.height);
  await page.screenshot({ path: info.outputPath(`${area}-long-label-peek.png`), caret: 'hide' });
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
  await expect(page.getByRole('button', { name: `Unpin ${longTitle}`, exact: true })).toBeVisible();
  await expect(page.locator('[data-context-view="test-widgets/view-2"]')).toBeVisible();
});
