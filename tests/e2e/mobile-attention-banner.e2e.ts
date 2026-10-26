import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers.ts';

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });

for (const device of ['iPhone', 'Android']) test.describe(`${device} attention banner`, () => {
  if (device === 'Android') test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' });
  test('needs-input banner is desktop-only across same-session viewport mode changes', async ({ page }, info) => {
    const desktop = info.project.name === 'desktop';
    test.skip(desktop && device === 'Android', 'desktop positive control uses its real configured browser context');
    await page.setViewportSize({ width: desktop ? 1280 : 390, height: 844 });
    await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [{
      name: 'test-project', lastLine: 'Allow this operation?', identity: { wolfpackSessionId: 'attention-session', agentKind: 'pi' },
      runtimeState: { state: 'needs-input', authority: 'manifest', source: 'local-manifest', freshness: 'fresh', stale: false, unseen: false },
    }] } }));
    const bytes: number[] = [];
    let attaches = 0;
    await page.routeWebSocket(/\/ws\/pty/, socket => socket.onMessage(message => {
      if (typeof message !== 'string') { bytes.push(...Buffer.from(message)); return; }
      if (JSON.parse(message).type !== 'attach') return;
      attaches++;
      socket.send(JSON.stringify({ type: 'attach_ack' }));
      socket.send(Buffer.from('attention terminal\r\n'));
      socket.send(JSON.stringify({ type: 'prefill_done' }));
      socket.send(JSON.stringify({ type: 'pty_ready' }));
    }));
    await page.goto(server.baseUrl);
    await page.getByRole('button', { name: 'Open test-project', exact: true }).first().click();
    const terminal = page.locator('#desktop-terminal-container');
    await expect(terminal).toHaveAttribute('data-terminal-load-state', 'live');
    const canvas = await terminal.locator('canvas').elementHandle();
    const banner = page.locator('#needs-input-banner');
    const samples: unknown[] = [];
    for (const width of [desktop ? 1280 : 390, 1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      // Observe the actual resize handler; no reload/poll/session update is
      // injected to manufacture the mode transition.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      samples.push(await page.evaluate(() => ({ width: innerWidth, bannerHidden: (document.querySelector('#needs-input-banner') as HTMLElement).hidden, banner: document.querySelector('#needs-input-banner')!.getBoundingClientRect().toJSON(), terminal: document.querySelector('#desktop-terminal-container')!.getBoundingClientRect().toJSON() })));
      await writeFile(info.outputPath('attention-modes.json'), JSON.stringify({ device, samples, attaches, bytes }, null, 2));
      await page.screenshot({ path: info.outputPath(`attention-${samples.length}-${width}.png`), animations: 'disabled' });
      await expect.soft(banner).toHaveJSProperty('hidden', width <= 768);
      await expect(terminal.locator('canvas')).toBeVisible();
      if (width > 768) {
        await expect(banner).toBeVisible();
        await banner.locator('[data-reply-key="y"]').click();
        await expect.poll(() => bytes.at(-1)).toBe(121);
      }
      expect(await terminal.locator('canvas').evaluate((node, original) => node === original, canvas)).toBe(true);
    }
    expect(attaches).toBe(1);
  });
});
