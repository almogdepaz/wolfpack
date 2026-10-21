import { expect, test, type Locator } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start, skipIfNoBroker, type BrokerTestServer } from './broker-helpers';
import { createOwnedTestServerHome, removeOwnedTestServerHome, type OwnedTestServerHome } from './test-server-home';
import { terminalTail } from './helpers';

test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
let server: BrokerTestServer;
let home: OwnedTestServerHome;
let root: string;
test.beforeAll(async () => {
  if (skipIfNoBroker.condition) return;
  home = createOwnedTestServerHome();
  root = mkdtempSync(join(tmpdir(), 'wp-caret-project-')); mkdirSync(join(root, 'project'));
  const isolated = { HOME: home.path, ZDOTDIR: home.path, SHELL: '/bin/sh' };
  server = await start({ brokerEnvOverrides: isolated, envOverrides: { ...isolated, WOLFPACK_DEV_DIR: root, WOLFPACK_MACHINE_ID_PATH: join(home.path, 'machine-id') } });
  for (const sessionName of ['caret-one', 'caret-two']) {
    const response = await fetch(`${server.baseUrl}/api/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'project', cmd: 'shell', sessionName }) });
    expect(response.ok).toBe(true);
  }
});
test.afterAll(async () => { await server?.teardown(); if (home) removeOwnedTestServerHome(home); if (root) rmSync(root, { recursive: true, force: true }); });

async function inputMetrics(root: Locator) {
  return root.evaluate(root => {
    const details = (el: Element | null) => {
      if (!el) return null;
      const box = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return { tag: el.tagName, id: el.id, className: el.className, contenteditable: el.getAttribute('contenteditable'), inputmode: el.getAttribute('inputmode'), readOnly: el instanceof HTMLTextAreaElement ? el.readOnly : null, x: box.x, y: box.y, width: box.width, height: box.height, caretColor: s.caretColor, color: s.color, opacity: s.opacity, visibility: s.visibility, display: s.display, position: s.position, top: s.top, left: s.left, clipPath: s.clipPath };
    };
    const selection = document.getSelection();
    return { active: details(document.activeElement), container: details(root), textarea: details(root.querySelector('textarea')), canvas: details(root.querySelector('canvas')), selection: selection ? { type: selection.type, anchor: selection.anchorNode?.nodeName, anchorParentId: selection.anchorNode?.parentElement?.id, anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset, ranges: selection.rangeCount ? Array.from(selection.getRangeAt(0).getClientRects()).map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height })) : [] } : null };
  });
}

test('single terminal has no browser caret while real PTY input and canvas cursor remain available', async ({ page }, info) => {
  const desktop = info.project.name === 'desktop';
  const width = desktop ? 1440 : 390;
  await page.setViewportSize({ width, height: 900 });
  // Keep Ghostty's painted cursor steady for pixel proof; browser caret
  // rendering/focus stays native and screenshots explicitly retain it.
  await page.addInitScript(() => { localStorage.setItem('wolfpackDebug', '1'); localStorage.setItem('wolfpackCursorBlinkDisabled', '1'); });
  const sent: string[] = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => { if (typeof payload !== 'string') sent.push(Buffer.from(payload).toString('utf8')); }));
  await page.goto(server.baseUrl);
  await page.getByRole('button', { name: 'Open caret-one', exact: true }).first().click();
  const single = page.locator('#desktop-terminal-container');
  await expect(single).toHaveAttribute('data-terminal-load-state', 'live');
  await expect(single.locator('canvas')).toBeVisible();
  await expect(page.locator('#terminal-view')).not.toHaveClass(/swiping/);
  const initial = await inputMetrics(single);
  expect(initial.active?.id).toBe('desktop-terminal-container');
  expect(initial.container?.contenteditable).toBe('true');
  expect.soft(initial.container?.caretColor).toBe('rgba(0, 0, 0, 0)');
  await info.attach('single-initial-metrics', { body: JSON.stringify(initial), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath(`single-initial-${width}.png`), caret: 'initial' });
  if (!desktop) {
    await expect(single.locator('textarea')).toHaveAttribute('inputmode', 'none');
    await page.locator('#kb-open-btn').click();
    await expect(single.locator('textarea')).toBeFocused();
    await expect(single.locator('textarea')).toHaveAttribute('inputmode', 'text');
  }
  const command = "printf '\\033[2J\\033[H\\n\\n\\n\\nCARET_SINGLE_%s\\n' LIVE";
  await page.keyboard.type(command); await page.keyboard.press('Enter');
  await expect.poll(() => sent.join('')).toContain(command + '\r');
  await expect.poll(() => terminalTail(single, 80)).toContain('CARET_SINGLE_LIVE');
  const typed = await inputMetrics(single);
  expect(typed.active?.tag).toBe(desktop ? 'DIV' : 'TEXTAREA');
  expect.soft(typed.container?.caretColor).toBe('rgba(0, 0, 0, 0)');
  await info.attach('single-typed-metrics', { body: JSON.stringify(typed), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath(`single-typed-${width}.png`), caret: 'initial' });

  // Park a real PTY program at an empty screen with only Ghostty's cursor.
  const cursorCommand = "printf '\\033[2J\\033[3J\\033[H\\033[?25h\\033[8;9H'; cat";
  await page.keyboard.type(cursorCommand); await page.keyboard.press('Enter');
  await expect.poll(() => sent.join('')).toContain(cursorCommand + '\r');
  await expect.poll(() => terminalTail(single, 80)).toBe('');
  const pixels = await single.evaluate(root => {
    const canvas = root.querySelector('canvas')!;
    const context = canvas.getContext('2d')!;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let brightPixels = 0;
    for (let at = 0; at < data.length; at += 4) if (data[at]! > 100 && data[at + 1]! > 100 && data[at + 2]! > 100 && data[at + 3]! > 0) brightPixels++;
    const before = canvas.toDataURL();
    const previous = (root as HTMLElement).style.caretColor;
    const activeBefore = document.activeElement;
    (root as HTMLElement).style.caretColor = 'transparent';
    const after = canvas.toDataURL();
    (root as HTMLElement).style.caretColor = previous;
    return { brightPixels, bitmapUnchangedByCaretStyle: before === after, focusUnchanged: activeBefore === document.activeElement, canvasWidth: canvas.width, canvasHeight: canvas.height };
  });
  expect(pixels.brightPixels).toBeGreaterThan(0);
  expect(pixels.bitmapUnchangedByCaretStyle).toBe(true);
  expect(pixels.focusUnchanged).toBe(true);
  await info.attach('canvas-cursor-proof', { body: JSON.stringify(pixels), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath(`single-cursor-${width}.png`), caret: 'initial' });
  await page.keyboard.press('Control+c');
  await expect.poll(() => sent.join('')).toContain('\x03');

  // Use the existing desktop controls to compare the SAME session in a grid,
  // then restore the mobile viewport rather than invent mobile grid controls.
  if (!desktop) {
    await page.locator('#kb-open-btn').click();
    await expect(single.locator('textarea')).toHaveAttribute('inputmode', 'none');
    await expect(single.locator('textarea')).not.toBeFocused();
    await page.setViewportSize({ width: 1440, height: 900 }); await page.reload();
    await page.getByRole('button', { name: 'Open caret-one', exact: true }).first().click();
  }
  await page.locator('#sidebar-session-list [data-action="toggle-grid"][data-session="caret-two"]').click();
  const cell = page.locator('#desktop-grid-container .grid-cell[data-session="caret-one"]');
  await expect(cell.locator('canvas')).toBeVisible();
  await expect(cell).toHaveAttribute('data-terminal-load-state', 'live');
  if (!desktop) await page.setViewportSize({ width: 390, height: 900 });
  await cell.click();
  await page.keyboard.type("printf 'CARET_GRID_%s\\n' LIVE"); await page.keyboard.press('Enter');
  await expect.poll(() => terminalTail(cell, 80)).toContain('CARET_GRID_LIVE');
  const grid = await inputMetrics(cell);
  expect(grid.container?.caretColor).toBe(await page.locator('body').evaluate(el => getComputedStyle(el).color));
  await info.attach('same-session-grid-metrics', { body: JSON.stringify(grid), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath(`same-session-grid-${width}.png`), caret: 'initial' });
});
