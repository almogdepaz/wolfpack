import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { startTestServer, openSessionFromUi, toggleSessionGridFromUi, gridSessionNames } from './helpers';

for (const key of ['Enter', 'Space', 'Pointer']) test(`current grid close activates with ${key}`, async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop manual-grid keyboard contract');
  const server = await startTestServer();
  try {
    const sent: string[] = [];
    await page.routeWebSocket(/\/ws\/pty/, ws => ws.onMessage(message => {
      if (typeof message !== 'string') { sent.push(Buffer.from(message).toString()); return; }
      const frame = JSON.parse(message);
      if (frame.type === 'resize') return ws.send(JSON.stringify({ ...frame, type: 'resize_ack' }));
      if (frame.type !== 'attach') return;
      ws.send(JSON.stringify({ type: 'attach_ack', capabilities: ['ordered-resize-ack'] }));
      ws.send(Buffer.from('CURRENT\r\n'));
      if (frame.prefillMode === 'viewport') ws.send(JSON.stringify({ type: 'prefill_viewport' }));
      ws.send(JSON.stringify({ type: 'prefill_done' })); ws.send(JSON.stringify({ type: 'pty_ready' }));
    }));
    await page.goto(server.baseUrl); await openSessionFromUi(page, 'test-project', '');
    await expect(page.locator('#desktop-terminal-container')).toHaveAttribute('data-terminal-load-state', 'live');
    await toggleSessionGridFromUi(page, 'another-project', '');
    await expect(page.locator('#desktop-grid-container .grid-cell.hydrated')).toHaveCount(2);
    await page.evaluate(() => document.addEventListener('keydown', event => { (window as any).__key = { key: event.key, prevented: event.defaultPrevented, target: (event.target as HTMLElement).tagName }; }));
    const button = page.getByRole('button', { name: 'Remove another-project from grid', exact: true });
    await button.focus(); await expect(button).toBeFocused();
    if (key === 'Pointer') await button.click(); else await button.press(key);
    await info.attach('key-result', { body: JSON.stringify({ key: await page.evaluate(() => (window as any).__key), sent, names: await gridSessionNames(page) }), contentType: 'application/json' });
    await expect(button).toHaveCount(0);
  } finally { await page.screenshot({ path: info.outputPath('grid-close.png') }); await page.close(); await server.close(); }
});

test('current startup preserves an explicitly focused widget control', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop terminal startup focus contract');
  const server = await startTestServer();
  try {
    let release: (() => void) | undefined;
    await page.routeWebSocket(/\/ws\/pty/, ws => ws.onMessage(message => {
      if (typeof message !== 'string') return;
      const frame = JSON.parse(message);
      if (frame.type === 'resize') return ws.send(JSON.stringify({ ...frame, type: 'resize_ack' }));
      if (frame.type !== 'attach') return;
      release = () => {
        ws.send(JSON.stringify({ type: 'attach_ack', capabilities: ['ordered-resize-ack'] }));
        ws.send(Buffer.from('CURRENT\r\n'));
        if (frame.prefillMode === 'viewport') ws.send(JSON.stringify({ type: 'prefill_viewport' }));
        ws.send(JSON.stringify({ type: 'prefill_done' })); ws.send(JSON.stringify({ type: 'pty_ready' }));
      };
    }));
    await page.goto(server.baseUrl);
    await page.getByRole('button', { name: 'Open test-project', exact: true }).click();
    const full = page.getByRole('button', { name: 'Context full view', exact: true });
    await expect.poll(() => typeof release).toBe('function');
    await full.focus(); await expect(full).toBeFocused();
    release!();
    await expect(page.locator('#desktop-terminal-container')).toHaveAttribute('data-terminal-load-state', 'live');
    await info.attach('active-element', { body: await page.evaluate(() => document.activeElement?.outerHTML ?? 'none'), contentType: 'text/plain' });
    await expect(full).toBeFocused();
  } finally { await page.screenshot({ path: info.outputPath('startup-focus.png') }); await page.close(); await server.close(); }
});

test('desktop startup still focuses the terminal when the user has not chosen another control', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop terminal startup focus contract');
  const server = await startTestServer();
  try {
    let release: (() => void) | undefined;
    await page.routeWebSocket(/\/ws\/pty/, ws => ws.onMessage(message => {
      if (typeof message !== 'string') return;
      const frame = JSON.parse(message);
      if (frame.type === 'resize') return ws.send(JSON.stringify({ ...frame, type: 'resize_ack' }));
      if (frame.type !== 'attach') return;
      release = () => {
        ws.send(JSON.stringify({ type: 'attach_ack', capabilities: ['ordered-resize-ack'] }));
        ws.send(Buffer.from('CURRENT\r\n'));
        if (frame.prefillMode === 'viewport') ws.send(JSON.stringify({ type: 'prefill_viewport' }));
        ws.send(JSON.stringify({ type: 'prefill_done' })); ws.send(JSON.stringify({ type: 'pty_ready' }));
      };
    }));
    await page.goto(server.baseUrl);
    await page.getByRole('button', { name: 'Open test-project', exact: true }).click();
    await expect.poll(() => typeof release).toBe('function');
    release!();
    await expect(page.locator('#desktop-terminal-container')).toHaveAttribute('data-terminal-load-state', 'live');
    await info.attach('startup-active', { body: await page.evaluate(() => document.activeElement?.outerHTML ?? 'none'), contentType: 'text/plain' });
    await expect(page.locator('#desktop-terminal-container')).toBeFocused();
  } finally { await page.close(); await server.close(); }
});

for (const serialized of [false, true]) test(`current rapid navigation cleanup preserves newest view (${serialized ? 'serialized control' : 'late older transition'})`, async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'controlled desktop transition fixture');
  await page.clock.install();
  const source = readFileSync(new URL('../../public/app.ts', import.meta.url), 'utf8');
  const functionText = source.slice(source.indexOf('let cancelViewTransition:'), source.indexOf('function applyDesktopViewNavigation('));
  await page.setContent('<div id="terminal" class="view visible"></div><div id="sessions" class="view"></div><div id="settings" class="view"></div>');
  await page.addScriptTag({ content: ts.transpileModule(functionText, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText });
  await page.evaluate(serial => {
    const terminal = document.getElementById('terminal')!, sessions = document.getElementById('sessions')!, settings = document.getElementById('settings')!;
    const apply = (window as any).applyViewVisibility;
    apply(terminal, sessions, true, false);
    if (serial) terminal.dispatchEvent(new Event('transitionend'));
    apply(sessions, settings, true, true);
    settings.dispatchEvent(new Event('transitionend'));
    if (!serial) terminal.dispatchEvent(new Event('transitionend'));
  }, serialized);
  await expect(page.locator('#settings')).toHaveClass('view visible');
  await expect(page.locator('#sessions')).toHaveClass('view');
  // The cancelled timeout cannot undo the newer view either.
  await page.clock.runFor(351);
  await info.attach('transition-state', { body: JSON.stringify(await page.locator('.view').evaluateAll(nodes => nodes.map(n => ({ id: n.id, classes: n.className })))), contentType: 'application/json' });
  await expect(page.locator('#settings')).toHaveClass('view visible');
  await expect(page.locator('#sessions')).toHaveClass('view');
});
