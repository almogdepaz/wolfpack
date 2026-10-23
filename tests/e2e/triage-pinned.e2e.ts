import { expect, test, type Page } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(() => server?.close());

async function fixture(page: Page, needs = true) {
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [] } }));
  await page.route("**/api/sessions", route => route.fulfill({ json: { sessions: [
    { name: "worker", identity: { wolfpackSessionId: "worker", agentKind: "pi" }, runtimeState: { state: "working", authority: "manifest", source: "local-manifest", freshness: "fresh", stale: false } },
    { name: "waiting", lastLine: "Allow write?", identity: { wolfpackSessionId: "waiting", agentKind: "pi" }, runtimeState: { state: needs ? "needs-input" : "done", authority: "manifest", source: "local-manifest", freshness: "fresh", stale: false } },
  ] } }));
}

test("need session is pinned and dimmed in its machine group without changing machine counts", async ({ page }, info) => {
  await fixture(page);
  await page.goto(server.baseUrl);
  const pinned = page.locator("#session-list > .needs-you");
  await expect(pinned).toBeVisible();
  await expect(pinned.locator(".card")).toHaveCount(1);
  await expect(pinned.locator(".machine-chip")).not.toBeEmpty();
  await expect(pinned.locator(".card")).toHaveAttribute("data-machine", "");
  const machine = page.locator("#session-list > .machine-group:not(.needs-you)");
  await expect(machine.locator(".card")).toHaveCount(2);
  await expect(machine.locator(".card-name-text")).toHaveText(["waiting", "worker"]);
  await expect(machine.locator('[data-session-order-id="waiting"]')).toHaveCSS("opacity", "0.6");
  await expect(machine.locator(".machine-session-count")).toHaveText("2 sessions");
  await expect(page.locator("#session-summary")).toContainText("2 sessions across 1 machine · 1 need you");
  expect(await pinned.evaluate(el => el === el.parentElement?.firstElementChild)).toBe(true);
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: info.outputPath("triage-pinned.png"), fullPage: true });
});

test("cross-machine pinning retains routing, waiting children, and both Open actions", async ({ page }) => {
  const origin = "https://triage-peer.example.ts.net";
  const installationId = "2af8af29-c4fe-44f9-8a99-2a0e35952d74";
  const peer = `n-triage:${installationId}`;
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [{ hostname: "triage-peer.example.ts.net", tailnetNodeId: "n-triage", origin, online: true }] } }));
  await page.route(`${origin}/api/info`, route => route.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" } }));
  await page.route(`${origin}/api/machine`, route => route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: {
    protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
    machine: { tailnetNodeId: "n-triage", installationId, displayName: "Peer laptop", origin },
    wolfpack: { version: "test" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"],
  } }));
  const runtime = (state: string, changedAt: string) => ({ state, changedAt, authority: "manifest", source: "local-manifest", freshness: "fresh", stale: false });
  await page.route("**/api/sessions", route => route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: { sessions: new URL(route.request().url()).origin === origin ? [
    { name: "parent", identity: { wolfpackSessionId: "parent" }, runtimeState: runtime("working", "2026-10-20T12:00:00Z") },
    { name: "waiting-child", identity: { wolfpackSessionId: "child", parentSession: { wolfpackSessionId: "parent", wolfpackSessionName: "parent" } }, runtimeState: runtime("needs-input", "2026-10-20T10:00:00Z") },
  ] : [{ name: "local-waiting", identity: { wolfpackSessionId: "local" }, runtimeState: runtime("needs-input", "2026-10-20T11:00:00Z") }] } }));
  const attaches: string[] = [];
  await page.routeWebSocket(/\/ws\/pty/, socket => socket.onMessage(message => {
    if (typeof message !== "string") return;
    const data = JSON.parse(message);
    if (data.type !== "attach") return;
    attaches.push(socket.url());
    socket.send(JSON.stringify({ type: "attach_ack" }));
    socket.send(JSON.stringify({ type: "prefill_done" }));
    socket.send(JSON.stringify({ type: "pty_ready" }));
  }));
  await page.goto(server.baseUrl);
  const pinned = page.locator('#session-list .needs-you');
  await expect(pinned.locator('.card-name-text')).toHaveText(['waiting-child', 'local-waiting']);
  await expect(pinned.locator('.card').first()).toHaveAttribute('data-machine', peer);
  await expect(pinned.locator('.machine-chip').first()).toHaveText('Peer laptop');
  const peerGroup = page.locator(`#session-list > .machine-group[data-machine="${peer}"]`);
  await expect(peerGroup.locator('.machine-session-count')).toHaveText('2 sessions');
  await pinned.getByRole('button', { name: 'Open waiting-child', exact: true }).click();
  await expect.poll(() => attaches.length).toBe(1);
  expect(new URL(attaches[0]!).hostname).toBe('triage-peer.example.ts.net');
  await page.reload();
  const localGroup = page.locator('#session-list > .machine-group[data-machine=""]');
  await localGroup.getByRole('button', { name: 'Open local-waiting', exact: true }).click();
  await expect.poll(() => attaches.length).toBe(2);
  expect(new URL(attaches[1]!).hostname).toBe('127.0.0.1');
});

test("pinned group is absent when no session needs input", async ({ page }) => {
  await fixture(page, false);
  await page.goto(server.baseUrl);
  await expect(page.locator('#session-list .card')).toHaveCount(2);
  await expect(page.locator('#session-list .needs-you')).toHaveCount(0);
});

test("pinned rows expose no drag or keyboard ordering attributes", async ({ page }) => {
  await fixture(page);
  await page.goto(server.baseUrl);
  const pinned = page.locator('#session-list .needs-you');
  await expect(pinned.locator('.card')).toHaveCount(1);
  await expect(pinned.locator('[data-session-order-id], [data-session-order-machine], [data-session-order-parent], [aria-keyshortcuts], [draggable="true"], [data-machine-surface]')).toHaveCount(0);
  const open = pinned.locator('.card-open');
  await open.focus();
  await page.keyboard.press('Alt+ArrowDown');
  expect(await page.evaluate(() => localStorage.getItem('wolfpack-session-order'))).toBeNull();
});
