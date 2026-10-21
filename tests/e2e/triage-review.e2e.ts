import { expect, test, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(() => server?.close());
const at = { old: "2026-10-20T10:00:00Z", recent: "2026-10-20T11:00:00Z" };
function session(name: string, state: string, time: string, parent?: string) {
  return { name, identity: { wolfpackSessionId: name, ...(parent ? { parentSession: { wolfpackSessionId: parent, wolfpackSessionName: parent } } : {}) }, runtimeState: { state, authority: "manifest", source: "local-manifest", freshness: "fresh", stale: false, changedAt: time }, activity: { lastRenderedActivityAt: time } };
}
async function fixture(page: Page, sessions: ReturnType<typeof session>[]) {
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [] } }));
  await page.route("**/api/sessions", route => route.fulfill({ json: { sessions } }));
}
const machineRows = (page: Page) => page.locator('#session-list .machine-group:not(.needs-you) .card');

test("A1 unequal timestamps permit manual keyboard ordering within a tier and survive reload", async ({ page }) => {
  await fixture(page, [session("alpha", "working", at.recent), session("beta", "working", at.old), session("need", "needs-input", at.old)]);
  await page.goto(server.baseUrl);
  await expect(machineRows(page).locator('.card-name-text')).toHaveText(['need', 'alpha', 'beta']);
  const alpha = machineRows(page).filter({ has: page.locator('[data-session="alpha"].card-open') }).locator('.card-open');
  await alpha.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(machineRows(page).locator('.card-name-text')).toHaveText(['need', 'beta', 'alpha']);
  await expect(page.locator('#session-order-status')).toContainText('alpha moved to position 2');
  await expect(page.locator('#session-order-instructions')).toContainText('within its attention tier');
  await page.reload();
  await expect(machineRows(page).locator('.card-name-text')).toHaveText(['need', 'beta', 'alpha']);
});

test("A1 unpositioned rows keep sorting by recency after manual rows across refreshes", async ({ page }) => {
  const sessions = [session('manual', 'working', at.old), session('beta', 'working', at.old), session('gamma', 'working', at.recent)];
  await page.addInitScript(() => localStorage.setItem('wolfpack-session-order', JSON.stringify({ version: 1, sessions: [{ machineUrl: '', sessionId: 'manual' }] })));
  await fixture(page, sessions);
  await page.goto(server.baseUrl);
  await expect(machineRows(page).locator('.card-name-text')).toHaveText(['manual', 'gamma', 'beta']);
  sessions[1] = session('beta', 'working', at.recent);
  sessions[2] = session('gamma', 'working', at.old);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(machineRows(page).locator('.card-name-text')).toHaveText(['manual', 'beta', 'gamma']);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('wolfpack-session-order')!).sessions)).toEqual([{ machineUrl: '', sessionId: 'manual' }]);
});

test("per-row UI placement leaves untouched work and need rows automatic", async ({ page }) => {
  const sessions = [
    session('need-old', 'needs-input', at.old), session('need-new', 'needs-input', at.recent),
    session('alpha', 'working', at.recent), session('beta', 'working', '2026-10-20T10:59:00Z'),
    session('gamma', 'working', at.old), session('delta', 'working', '2026-10-20T09:00:00Z'),
  ];
  await fixture(page, sessions);
  await page.goto(server.baseUrl);
  const names = machineRows(page).locator('.card-name-text');
  await expect(names).toHaveText(['need-old', 'need-new', 'alpha', 'beta', 'gamma', 'delta']);
  await machineRows(page).locator('.card-open[data-session="alpha"]').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(names).toHaveText(['need-old', 'need-new', 'beta', 'alpha', 'gamma', 'delta']);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('wolfpack-session-order')!).sessions);
  await expect.poll(stored).toEqual([{ machineUrl: '', sessionId: 'alpha', position: 1 }]);
  sessions[0] = session('need-old', 'needs-input', at.recent);
  sessions[1] = session('need-new', 'needs-input', at.old);
  sessions[3] = session('beta', 'working', '2026-10-20T09:00:00Z');
  sessions[4] = session('gamma', 'working', at.recent);
  sessions[5] = session('delta', 'working', '2026-10-20T12:00:00Z');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(names).toHaveText(['need-new', 'need-old', 'delta', 'alpha', 'gamma', 'beta']);
  await page.reload();
  await expect(names).toHaveText(['need-new', 'need-old', 'delta', 'alpha', 'gamma', 'beta']);
  await machineRows(page).locator('.card-open[data-session="beta"]').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(names).toHaveText(['need-new', 'need-old', 'delta', 'alpha', 'beta', 'gamma']);
  await expect.poll(stored).toEqual([{ machineUrl: '', sessionId: 'alpha', position: 1 }, { machineUrl: '', sessionId: 'beta', position: 2 }]);
});

test("A1 drag visibly reorders rows with distinct output timestamps", async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop pointer; mobile keyboard and existing touch drag specs cover the shared move path');
  await fixture(page, [session('alpha', 'working', at.recent), session('beta', 'working', at.old)]);
  await page.goto(server.baseUrl);
  const alpha = machineRows(page).filter({ has: page.locator('[data-session="alpha"].card-open') });
  const beta = machineRows(page).filter({ has: page.locator('[data-session="beta"].card-open') });
  const a = await alpha.boundingBox(); const b = await beta.boundingBox();
  expect(a).not.toBeNull(); expect(b).not.toBeNull();
  await page.mouse.move(b!.x + 20, b!.y + b!.height / 2);
  await page.mouse.down();
  await page.mouse.move(a!.x + 20, a!.y + a!.height / 4, { steps: 8 });
  await expect(page.locator('.session-order-floating')).toBeVisible();
  await page.mouse.up();
  await expect(machineRows(page).locator('.card-name-text')).toHaveText(['beta', 'alpha']);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('wolfpack-session-order')!).sessions)).toEqual([{ machineUrl: '', sessionId: 'beta', position: 0 }]);
});

test("A2 dashboard Cmd+Arrow skips pinned duplicates of the current session", async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop shortcut');
  await fixture(page, [session('n1', 'needs-input', at.old), session('w1', 'working', at.recent)]);
  const attaches: string[] = [];
  await page.routeWebSocket(/\/ws\/pty/, socket => socket.onMessage(message => {
    if (typeof message !== 'string') return;
    const data = JSON.parse(message);
    if (data.type !== 'attach') return;
    attaches.push(new URL(socket.url()).searchParams.get('session')!);
    for (const type of ['attach_ack', 'prefill_done', 'pty_ready']) socket.send(JSON.stringify({ type }));
  }));
  await page.goto(server.baseUrl);
  await page.locator('#session-list .needs-you .card-open').click();
  await expect.poll(() => attaches).toEqual(['n1']);
  await page.locator('#sidebar-expand-btn').click();
  await expect(page.locator('body')).toHaveClass(/sessions-expanded/);
  await page.keyboard.press('Meta+ArrowDown');
  await expect.poll(() => attaches).toEqual(['n1', 'w1']);
});

test("A3 a waiting descendant pulls its idle parent tree ahead of working roots", async ({ page }, info) => {
  await fixture(page, [session('worker', 'working', at.recent), session('parent', 'idle', at.old), session('child', 'needs-input', at.old, 'parent')]);
  await page.goto(server.baseUrl);
  if (info.project.name !== 'desktop') await machineRows(page).getByRole('button', { name: 'Expand 1 child agent', exact: true }).click();
  await expect(machineRows(page).locator('.card-name-text')).toHaveText(['parent', 'child', 'worker']);
});
