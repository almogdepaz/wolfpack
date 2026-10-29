import { expect, test, type Page } from "@playwright/test";
import { openSettingsFromUi, startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(() => server?.close());

async function fixture(page: Page) {
  const session = (name: string, state: string, parent?: string) => ({ name, lastLine: name === 'waiting' ? 'Allow write?' : 'Last agent line', identity: { wolfpackSessionId: name, agentKind: 'pi', ...(parent ? { parentSession: { wolfpackSessionId: parent, wolfpackSessionName: parent } } : {}) }, runtimeState: { state, authority: 'manifest', source: 'local-manifest', freshness: 'fresh', stale: false } });
  await page.route('**/api/tailnet/v1/candidates', route => route.fulfill({ json: { candidates: [] } }));
  await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [session('waiting', 'needs-input'), session('solo', 'working'), session('parent', 'idle'), session('child', 'working', 'parent'), session('outside', 'idle')] } }));
  await page.routeWebSocket(/\/ws\/pty/, socket => socket.onMessage(message => {
    if (typeof message !== 'string') return;
    const data = JSON.parse(message);
    if (data.type !== 'attach') return;
    socket.send(JSON.stringify({ type: 'attach_ack' }));
    if (data.prefillMode === 'viewport') socket.send(JSON.stringify({ type: 'prefill_viewport' }));
    socket.send(JSON.stringify({ type: 'prefill_done' }));
    socket.send(JSON.stringify({ type: 'pty_ready' }));
  }));
}

test('sidebar marks grid membership without hover, including waiting duplicates, children and suspended grids', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop sidebar');
  await fixture(page);
  await page.goto(server.baseUrl);
  await page.locator('#session-list .needs-you').getByRole('button', { name: 'Open waiting', exact: true }).click();
  const row = (id: string) => page.locator(`#sidebar-session-list [data-session-order-id="${id}"]`);
  await row('solo').getByRole('button', { name: 'Add to grid: solo', exact: true }).click();
  await expect(page.locator('#desktop-grid-container .grid-cell')).toHaveCount(2);
  await row('parent').getByRole('button', { name: 'Expand 1 child agent', exact: true }).click();
  await row('child').getByRole('button', { name: 'Add to grid: child', exact: true }).click();
  await expect(page.locator('#desktop-grid-container .grid-cell')).toHaveCount(3);
  await expect(row('child')).toHaveClass(/sub-session-card/);

  async function checkMarkers() {
    await page.locator('#sidebar-search').focus();
    await page.mouse.move(1200, 700);
    for (const id of ['waiting', 'solo', 'child']) {
      const card = row(id);
      const button = card.locator('.grid-btn');
      await expect(button).toHaveText('⊠');
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect.soft(button).toHaveCSS('opacity', '1', { timeout: 1000 });
      await expect.soft(button).toHaveCSS('color', 'rgb(69, 237, 126)');
      if ((await card.getAttribute('class'))?.includes('sidebar-active')) {
        await expect.soft(card).toHaveCSS('background-color', 'rgba(69, 237, 126, 0.14)');
      } else {
        await expect(card).toHaveClass(/sidebar-grid/);
        await expect.soft(card).toHaveCSS('background-color', 'rgba(69, 237, 126, 0.07)', { timeout: 1000 });
        await expect.soft(card).toHaveCSS('box-shadow', 'rgba(69, 237, 126, 0.4) 2px 0px 0px 0px inset', { timeout: 1000 });
      }
      await expect(card).toHaveCSS('opacity', '1');
    }
    const outside = row('outside');
    await expect(outside).not.toHaveClass(/sidebar-grid|sidebar-active/);
    await expect(outside).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(outside).toHaveCSS('box-shadow', 'none');
    await expect(outside.locator('.grid-btn')).not.toHaveClass(/in-grid/);
    await expect(outside.locator('.grid-btn')).toHaveCSS('opacity', '0');
  }
  await checkMarkers();
  const pinned = page.locator('#session-list .needs-you .card');
  await expect(pinned).toHaveCount(1);
  await expect(pinned).not.toHaveClass(/sidebar-grid|pinned-duplicate/);
  await expect(pinned.locator('.grid-btn')).toHaveCount(0);
  await expect(page.locator('#session-list .machine-group:not(.needs-you) [data-session-order-id="waiting"]')).toHaveCSS('opacity', '0.6');
  await page.screenshot({ path: info.outputPath('grid-markers.png') });
  await openSettingsFromUi(page);
  await expect(page.locator('#settings-view')).toHaveClass(/visible/);
  await expect(page.locator('#desktop-grid-container .grid-cell')).toHaveCount(0);
  await checkMarkers();
});
