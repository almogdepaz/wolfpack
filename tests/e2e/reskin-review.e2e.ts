import { expect, test, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(() => server?.close());

async function fixture(page: Page) {
  let changed = false;
  let requests = 0;
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [] } }));
  await page.route("**/api/sessions", route => {
    requests++;
    return route.fulfill({ json: { sessions: [
      { name: "test-project", lastLine: "Allow write?", identity: { wolfpackSessionId: "test-id", agentKind: "pi" }, runtimeState: { state: "needs-input", authority: "manifest", source: "local-manifest", freshness: "fresh", stale: false } },
      { name: "another-project", lastLine: changed ? "Updated preview" : "Working", identity: { wolfpackSessionId: "another-id" }, runtimeState: { state: changed ? "needs-input" : "working", authority: "manifest", source: "local-manifest", freshness: "fresh", stale: false } },
    ] } });
  });
  return { async refresh() {
    changed = true;
    const before = requests;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => requests).toBeGreaterThan(before);
    await expect(page.locator('#session-list .tier-need')).toHaveCount(2);
  } };
}

test("H1 counters and summary track initial load and refresh without filter interaction", async ({ page }) => {
  const data = await fixture(page);
  await page.goto(server.baseUrl);
  await expect(page.locator('#session-list .card')).toHaveCount(2);
  await expect(page.locator('#dashboard-session-filter [data-session-card-view="need"] .n')).toHaveText("1");
  await expect(page.locator('#session-summary')).toContainText("2 across 1 machine · 1 need you");
  await expect(page.locator('#session-list [data-session-order-id="another-id"] .harness-icon')).toHaveAttribute('aria-label', 'Terminal');
  await expect(page.locator('#session-list [data-session-order-id="test-id"] .status')).toHaveAttribute('title', 'needs input');
  await expect(page.locator('#session-list [data-session-order-id="test-id"] .status')).toHaveText('Needs input');
  await expect(page.locator('#online-machine-count')).toContainText("1 machine online");
  await data.refresh();
  await expect(page.locator('#dashboard-session-filter [data-session-card-view="need"] .n')).toHaveText("2");
  await expect(page.locator('#session-summary')).toContainText("2 need you");
});

test("H2 dashboard query survives runtime refresh", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  const data = await fixture(page);
  await page.goto(server.baseUrl);
  await expect(page.locator('#session-list .card')).toHaveCount(2);
  await page.locator('#dashboard-search').fill("another");
  await expect(page.locator('#session-list .card:visible')).toHaveCount(1);
  await data.refresh();
  await expect(page.locator('#dashboard-search')).toHaveValue("another");
  await expect(page.locator('#session-list .card:visible')).toHaveCount(1);
});

test("M1 control menu is hittable and control/paste preserve terminal focus", async ({ page }, info) => {
  test.skip(info.project.name === "desktop");
  const bytes: number[][] = [];
  await page.routeWebSocket(/\/ws\/pty/, socket => {
    socket.onMessage(message => {
      if (typeof message !== "string") { bytes.push(Array.from(Buffer.from(message))); return; }
      if (JSON.parse(message).type !== "attach") return;
      socket.send(JSON.stringify({ type: "attach_ack" }));
      socket.send(JSON.stringify({ type: "prefill_done" }));
      socket.send(JSON.stringify({ type: "pty_ready" }));
    });
  });
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { readText: async () => "paste-fixture" } }));
  await page.goto(server.baseUrl);
  await page.getByRole('button', { name: 'Open test-project', exact: true }).click();
  const input = page.locator('#desktop-terminal-container textarea');
  await page.locator('#kb-open-btn').click();
  await expect(input).toBeFocused();
  await page.locator('.kb-control summary').tap();
  await expect(input).toBeFocused();
  const key = page.locator('.kb-control-menu [data-key="C-a"]');
  await expect(key).toBeVisible();
  expect(await key.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
  await key.tap();
  await expect.poll(() => bytes).toContainEqual([1]);
  await expect(input).toBeFocused();
  await page.locator('#kb-paste').tap();
  await expect(input).toBeFocused();
  await expect.poll(() => bytes.flat().map(byte => String.fromCharCode(byte)).join('')).toContain('paste-fixture');
});

test("M2 single-terminal destructive chrome is absent in a manual grid", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await page.goto(server.baseUrl);
  await page.getByRole('button', { name: 'Open test-project', exact: true }).click();
  await expect(page.locator('#terminal-chrome')).toBeVisible();
  await expect(page.locator('#terminal-chrome-status i')).toHaveCount(1);
  await expect(page.locator('#sidebar-session-list .sidebar-active .card-preview')).toHaveCSS('color', 'rgb(184, 198, 190)');
  await page.locator('#sidebar-session-list [data-action="toggle-grid"][data-session="another-project"]').click();
  await expect(page.locator('#desktop-grid-container')).toBeVisible();
  await expect(page.locator('#terminal-chrome')).toBeHidden();
  await expect(page.locator('#terminal-stop')).toBeHidden();
});

test("H3 settings navigation link restores focus and uses a matching Back label", async ({ page }, info) => {
  test.skip(info.project.name === "desktop");
  await page.goto(server.baseUrl);
  const settings = page.getByRole('link', { name: 'Settings', exact: true });
  await settings.focus();
  await settings.press('Enter');
  await expect(page.locator('#settings-view')).toHaveClass(/visible/);
  const back = page.locator('#back-btn');
  await expect(back).toHaveAccessibleName(await back.innerText());
  await back.press('Enter');
  await expect(settings).toBeFocused();
});

test("terminal status retains its source tooltip, sentence label, dot and tier colour", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await fixture(page);
  await page.goto(server.baseUrl);
  await page.getByRole('button', { name: 'Open another-project', exact: true }).click();
  const status = page.locator('#terminal-chrome-status');
  await expect(status).toHaveText('Working');
  await expect(status).toHaveAttribute('title', 'working');
  await expect(status).toHaveCSS('color', 'rgb(69, 237, 126)');
  await expect(status.locator('i')).toHaveCSS('background-color', 'rgb(69, 237, 126)');
});

test("failed rows expose Close without hover and retain confirmation", async ({ page }) => {
  await page.route("**/api/sessions", route => route.fulfill({ json: { sessions: [{ name: "test-project", identity: { wolfpackSessionId: "failed-id", agentKind: "pi" }, runtimeState: { state: "failed", authority: "manifest", source: "local-manifest", freshness: "fresh", stale: false } }] } }));
  await page.goto(server.baseUrl);
  const close = page.locator('#session-list .tier-fail').getByRole('button', { name: 'Close test-project', exact: true });
  await page.mouse.move(0, 0);
  await expect(close).toHaveText('Close');
  await expect(close).toHaveCSS('opacity', '1');
  await close.click();
  await expect(page.getByRole('dialog', { name: 'Stop session', exact: true })).toContainText('Stop session "test-project"?');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(close).toBeFocused();
});

test("M2 single-terminal destructive chrome is absent in a delegation grid", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await page.route("**/api/sessions", route => route.fulfill({ json: { sessions: [
    { name: 'test-project', identity: { wolfpackSessionId: 'parent-id' }, triage: 'idle' },
    { name: 'another-project', identity: { wolfpackSessionId: 'child-id', parentSession: { wolfpackSessionId: 'parent-id', wolfpackSessionName: 'test-project' } }, triage: 'idle' },
  ] } }));
  await page.goto(server.baseUrl);
  await page.getByRole('button', { name: 'Open test-project', exact: true }).click();
  await expect(page.locator('#delegation-grid-shell')).toBeVisible();
  await expect(page.locator('#terminal-chrome')).toBeHidden();
});

test("M3 mobile Changes is reachable and opens existing context", async ({ page }, info) => {
  test.skip(info.project.name === "desktop");
  await page.goto(server.baseUrl);
  await page.getByRole('button', { name: 'Open test-project', exact: true }).click();
  const changes = page.getByRole('button', { name: 'Changes', exact: true }).filter({ visible: true });
  await expect(changes).toBeEnabled();
  await changes.tap();
  await expect(page.locator('#workspace-mobile-header')).toBeVisible();
});
