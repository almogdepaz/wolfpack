import { expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { start, skipIfNoBroker, type BrokerTestOwnership, type BrokerTestServer } from './broker-helpers.ts';
import { createOwnedTestServerHome, removeOwnedTestServerHome, type OwnedTestServerHome } from './test-server-home.ts';
import { terminalTail } from './helpers.ts';
import { installNativeKeyboard } from './virtual-keyboard-fixture.ts';

test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
let server: BrokerTestServer;
let ownership: BrokerTestOwnership | undefined;
let home: OwnedTestServerHome | undefined;
let root: string | undefined;
let cleanupPath: string | undefined;
let sessionId: string | undefined;
const name = 'vk-native';

test.beforeAll(async () => {
  if (skipIfNoBroker.condition) return;
  home = createOwnedTestServerHome();
  root = mkdtempSync(join(tmpdir(), 'wp-vk-project-'));
  mkdirSync(join(root, 'project'));
  const isolated = { HOME: home.path, ZDOTDIR: home.path, SHELL: '/bin/sh' };
  server = await start({ brokerEnvOverrides: isolated, envOverrides: { ...isolated, WOLFPACK_DEV_DIR: root, WOLFPACK_MACHINE_ID_PATH: join(home.path, 'machine-id') }, onOwnership: owner => { ownership = owner; } });
  const response = await fetch(`${server.baseUrl}/api/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'project', cmd: 'shell', sessionName: name }) });
  expect(response.ok).toBe(true);
});
test.afterAll(async () => {
  try {
    if (server && sessionId) {
      const response = await fetch(`${server.baseUrl}/api/kill`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: name }) });
      expect(response.ok).toBe(true);
    }
  } finally {
    await ownership?.teardown();
    if (cleanupPath) await writeFile(cleanupPath, JSON.stringify({ socketPath: ownership?.socketPath, ownedChildrenExited: ownership?.childrenExited(), sessionId, brokerStderr: server?.brokerStderr() }, null, 2));
    if (home) removeOwnedTestServerHome(home);
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test('native VK frame resize retains the first native PTY row, exact session and one attach', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'mobile native keyboard frame');
  cleanupPath = info.outputPath('owned-broker-cleanup.json');
  await page.setViewportSize({ width: 384, height: 596 });
  await installNativeKeyboard(page, false);
  await page.addInitScript(() => { localStorage.setItem('wolfpackCursorBlinkDisabled', '1'); });
  const sockets: { session: string | null; origin: string; path: string; closed: boolean }[] = [];
  const resizes: { cols: number; rows: number }[] = [];
  const inputFrames: number[][] = [];
  page.on('websocket', socket => {
    const url = new URL(socket.url());
    if (url.pathname !== '/ws/pty') return;
    const record = { session: url.searchParams.get('session'), origin: url.origin, path: url.pathname, closed: false };
    sockets.push(record);
    socket.on('close', () => { record.closed = true; });
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') { inputFrames.push([...Buffer.from(payload)]); return; }
      const frame = JSON.parse(payload);
      if (frame.type === 'resize') resizes.push({ cols: frame.cols, rows: frame.rows });
    });
  });
  await page.goto(server.baseUrl + '?kbdebug=1');
  await page.getByRole('button', { name: `Open ${name}`, exact: true }).first().click();
  const terminal = page.locator('#desktop-terminal-container');
  await expect(terminal).toHaveAttribute('data-terminal-load-state', 'live');
  const canvas = await terminal.locator('canvas').elementHandle();
  const input = terminal.locator('textarea');
  await expect(input).toHaveAttribute('inputmode', 'none');
  await expect(input).not.toBeFocused();
  await page.locator('#kb-open-btn').click();
  await expect(input).toBeFocused();
  const command = "printf '\\033[2J\\033[3J\\033[H'; printf 'VKNATIVE_%s\\r\\n' FIRST_ROW; cat";
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalTail(terminal, 40)).toBe('VKNATIVE_FIRST_ROW');
  const before = await (await fetch(server.baseUrl + '/api/sessions')).json() as { sessions: { name: string; identity?: { wolfpackSessionId?: string } }[] };
  sessionId = before.sessions.find(session => session.name === name)?.identity?.wolfpackSessionId;
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(statSync(server.socketPath).isSocket()).toBe(true);
  expect(statSync(dirname(server.socketPath)).mode & 0o777).toBe(0o700);
  await expect.poll(() => resizes.length).toBeGreaterThan(0);
  const initialRows = resizes.at(-1)!.rows;
  await page.evaluate(() => {
    Object.defineProperty(visualViewport!, 'height', { configurable: true, value: 340.98 });
    window.__nativeKeyboard.geometry(437, 159);
    visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => JSON.parse(await page.locator('#kb-debug').textContent() || '{}').accessory?.bottom).toBe(437);
  await expect.poll(() => resizes.at(-1)!.rows).toBeLessThan(initialRows);
  await expect.poll(() => terminalTail(terminal, 40)).toBe('VKNATIVE_FIRST_ROW');
  expect(await terminal.locator('canvas').evaluate((node, original) => node === original, canvas)).toBe(true);
  const geometry = await page.evaluate(() => ({
    debug: JSON.parse(document.querySelector('#kb-debug')!.textContent || '{}'),
    canvas: document.querySelector('#desktop-terminal-container canvas')!.getBoundingClientRect().toJSON(),
    clip: document.querySelector('#workspace-terminal-region')!.getBoundingClientRect().toJSON(),
  }));
  expect(geometry.debug.path).toBe('vk');
  expect(geometry.debug.vk.overlaysContent).toBe(true);
  expect(geometry.debug.vk.boundingRect.top).toBe(437);
  expect(geometry.debug.terminal.bottom).toBe(437);
  expect(geometry.canvas.top).toBeGreaterThanOrEqual(geometry.clip.top);
  expect(geometry.canvas.top + 20).toBeLessThanOrEqual(geometry.clip.bottom);
  await page.screenshot({ path: info.outputPath('native-pty-437.png') });
  await page.evaluate(() => window.__nativeKeyboard.geometry(0, 0));
  await expect(input).toHaveAttribute('inputmode', 'none');
  await expect(page.locator('#terminal-view')).not.toHaveClass(/keyboard-occluded/);
  await page.evaluate(() => window.__nativeKeyboard.geometry(437, 159));
  await expect(input).toHaveAttribute('inputmode', 'none'); // native geometry cannot reopen stdin
  await page.locator('#kb-open-btn').click();
  await expect(input).toBeFocused();
  await page.keyboard.type('native-input');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalTail(terminal, 40)).toContain('native-input');
  const after = await (await fetch(server.baseUrl + '/api/sessions')).json() as typeof before;
  expect(after.sessions.find(session => session.name === name)?.identity?.wolfpackSessionId).toBe(sessionId);
  expect(sockets).toHaveLength(1);
  await page.locator('#back-btn').click();
  await expect.poll(() => sockets[0].closed).toBe(true);
  expect(await page.evaluate(() => ({ overlay: window.__nativeKeyboard.overlaysContent, listeners: window.__nativeKeyboard.listeners.size }))).toEqual({ overlay: false, listeners: 0 });
  await expect(page.locator('#kb-debug')).toHaveCount(0);
  await writeFile(info.outputPath('native-pty-evidence.json'), JSON.stringify({ socketPath: server.socketPath, sessionId, before, after, sockets, resizes, inputFrames, geometry, overlayHistory: await page.evaluate(() => window.__nativeKeyboard.overlayHistory) }, null, 2));
});
