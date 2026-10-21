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
    await expect(page.locator('#session-list .machine-group:not(.needs-you) .tier-need')).toHaveCount(2);
  } };
}

test("H1 counters and summary track initial load and refresh without filter interaction", async ({ page }) => {
  const data = await fixture(page);
  await page.goto(server.baseUrl);
  await expect(page.locator('#session-list .machine-group:not(.needs-you) .card')).toHaveCount(2);
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
  await expect(page.locator('#session-list .machine-group:not(.needs-you) .card')).toHaveCount(2);
  await page.locator('#dashboard-search').fill("another");
  await expect(page.locator('#session-list .machine-group:not(.needs-you) .card:visible')).toHaveCount(1);
  await expect(page.locator('#session-list .needs-you')).toBeHidden();
  await data.refresh();
  await expect(page.locator('#dashboard-search')).toHaveValue("another");
  await expect(page.locator('#session-list .machine-group:not(.needs-you) .card:visible')).toHaveCount(1);
  await expect(page.locator('#session-list .needs-you .card:visible')).toHaveCount(1);
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
  await page.addInitScript(() => {
    const reads: Array<{ type?: string; trusted?: boolean }> = [];
    Object.assign(window, { pasteReads: reads });
    Object.defineProperty(navigator, "clipboard", { value: { readText: async () => {
      reads.push({ type: window.event?.type, trusted: window.event?.isTrusted });
      return "paste-fixture";
    } } });
  });
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
  expect(await page.evaluate(() => (window as unknown as { pasteReads: unknown[] }).pasteReads)).toEqual([{ type: 'touchend', trusted: true }]);
  await page.locator('#kb-paste').click();
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { pasteReads: unknown[] }).pasteReads)).toEqual([
    { type: 'touchend', trusted: true }, { type: 'click', trusted: true },
  ]);
  await expect.poll(() => bytes.flat().map(byte => String.fromCharCode(byte)).join('').match(/paste-fixture/g)?.length).toBe(2);
});

test("sidebar add-to-grid actions reveal on hover and focus while grid members stay visible", async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop');
  await fixture(page);
  await page.goto(server.baseUrl);
  await page.locator('#session-list .needs-you').getByRole('button', { name: 'Open test-project', exact: true }).click();
  const row = page.locator('#sidebar-session-list [data-session-order-id="another-id"]');
  const grid = row.locator('[data-action="toggle-grid"]');
  await expect(grid).toHaveCount(1);
  await page.mouse.move(900, 800);
  await expect(grid).toHaveCSS('opacity', '0');
  await row.hover();
  await expect(grid).toHaveCSS('opacity', '1');
  await page.mouse.move(900, 800);
  await expect(grid).toHaveCSS('opacity', '0');
  await row.getByRole('button', { name: 'Open another-project', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(grid).toBeFocused();
  await expect(grid).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  await expect(page.locator('#desktop-grid-container')).toBeVisible();
  await expect(grid).toHaveClass(/in-grid/);
  await page.locator('#sidebar-search').focus();
  await expect(grid).toHaveCSS('opacity', '1');
  await expect(grid).toHaveCSS('color', 'rgb(69, 237, 126)');
});

test("dashboard search retains a visible tint focus ring without an outline", async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop');
  await page.goto(server.baseUrl);
  const search = page.locator('#dashboard-search');
  await search.focus();
  await expect(search).toBeFocused();
  await expect(search).toHaveCSS('outline-style', 'none');
  await expect(search).toHaveCSS('box-shadow', 'none');
  const field = page.locator('.session-search').filter({ has: search });
  await expect(field).toHaveCSS('border-radius', '9px');
  await expect(field).toHaveCSS('box-shadow', 'rgba(69, 237, 126, 0.7) 0px 0px 0px 3px');
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(search).toHaveCSS('outline-style', 'solid');
  await expect(search).toHaveCSS('outline-width', '2px');
  await expect(field).toHaveCSS('box-shadow', 'none');
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

test("failed rows expose Close without hover and retain confirmation", async ({ page }, info) => {
  await page.route("**/api/sessions", route => route.fulfill({ json: { sessions: [{ name: "test-project", identity: { wolfpackSessionId: "failed-id", agentKind: "pi" }, runtimeState: { state: "failed", authority: "manifest", source: "local-manifest", freshness: "fresh", stale: false } }] } }));
  await page.goto(server.baseUrl);
  const close = page.locator('#session-list .tier-fail').getByRole('button', { name: 'Close test-project', exact: true });
  await page.mouse.move(0, 0);
  await expect(close).toHaveText('Close');
  await expect(close).toHaveCSS('opacity', '1');
  await close.click();
  const dialog = page.getByRole('dialog', { name: 'Close session', exact: true });
  await expect(dialog).toContainText('Close session "test-project"?');
  await expect(dialog.getByRole('button', { name: 'Close session', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(close).toBeFocused();
  if (info.project.name === 'desktop') {
    await page.getByRole('button', { name: 'Collapse sessions', exact: true }).click();
    await page.locator('#sidebar-session-list').getByRole('button', { name: 'Close test-project', exact: true }).click();
    await expect(dialog).toContainText('Close session "test-project"?');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('#sidebar-session-list').getByRole('button', { name: 'Open test-project', exact: true }).click();
    await expect(page.locator('#terminal-stop')).toHaveText('Close');
    await page.locator('#terminal-stop').click();
    await expect(dialog).toContainText('Close session "test-project"?');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
});

test("N2 sidebar parents and solo sessions have equal two-line rows", async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop');
  await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [
    { name: 'test-project', lastLine: 'Same preview', identity: { wolfpackSessionId: 'parent-id' }, triage: 'idle' },
    { name: 'child', identity: { wolfpackSessionId: 'child-id', parentSession: { wolfpackSessionId: 'parent-id', wolfpackSessionName: 'test-project' } }, triage: 'idle' },
    { name: 'another-project', lastLine: 'Same preview', identity: { wolfpackSessionId: 'solo-id' }, triage: 'idle' },
  ] } }));
  await page.goto(server.baseUrl);
  await page.getByRole('button', { name: 'Collapse sessions', exact: true }).click();
  const sidebar = page.locator('#sidebar-session-list');
  const parent = sidebar.locator('[data-session-order-id="parent-id"]');
  const solo = sidebar.locator('[data-session-order-id="solo-id"]');
  await expect(parent.locator('.card-status')).toBeHidden();
  await expect(solo.locator('.card-status')).toBeHidden();
  await expect(parent).toHaveCSS('height', await solo.evaluate(el => getComputedStyle(el).height));
  for (const card of [parent, solo]) {
    const name = await card.locator('.card-name').boundingBox();
    const preview = await card.locator('.card-preview').boundingBox();
    expect(preview!.y - (name!.y + name!.height)).toBeCloseTo(2, 2);
  }
  const toggle = parent.getByRole('button', { name: 'Expand 1 child agent', exact: true });
  await toggle.click();
  await expect(sidebar.locator('[data-session-order-id="child-id"]')).toBeVisible();
  await parent.getByRole('button', { name: 'Collapse 1 child agent', exact: true }).click();
  await expect(sidebar.locator('[data-session-order-id="child-id"]')).toHaveCount(0);
  await parent.getByRole('button', { name: 'Open test-project', exact: true }).click();
  await expect(page.locator('#delegation-grid-shell')).toBeVisible();
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
  await expect(page.locator('#session-list .card').first()).toBeVisible();
  await expect(page.locator('#mobile-changes')).toBeHidden();
  await page.getByRole('button', { name: 'Open test-project', exact: true }).click();
  const changes = page.getByRole('button', { name: 'Changes', exact: true }).filter({ visible: true });
  await expect(changes).toBeEnabled();
  await changes.tap();
  await expect(page.locator('#workspace-mobile-header')).toBeVisible();
});
