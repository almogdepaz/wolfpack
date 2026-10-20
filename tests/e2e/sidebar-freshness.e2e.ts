import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer;
test.beforeAll(async () => { server = await startTestServer(); });
test.afterAll(async () => { await server?.close(); });
const peerOrigin = "https://fresh-peer.example.ts.net";
const installationId = "2af8af29-c4fe-44f9-9a99-9a0e35952d74";
const candidate = { hostname: "fresh-peer.example.ts.net", tailnetNodeId: "n-fresh", origin: peerOrigin, online: true };
const handshake = {
  protocol: { name: "wolfpack-machine", major: 1, minor: 0 },
  machine: { tailnetNodeId: "n-fresh", installationId, displayName: "fresh peer", origin: peerOrigin },
  wolfpack: { version: "1.7.0" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"],
};
const localRows = [{ name: "test-project", triage: "idle" }, { name: "another-project", triage: "idle" }];
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
async function isolate(page: Page) {
  await page.route("https://**", route => route.abort());
  await page.route(`${peerOrigin}/api/machine`, route => route.fulfill(json(handshake)));
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: [] })));
}

test("an unresolved initial local summary is connecting, not a failed or empty machine", async ({ page }) => {
  await isolate(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/sessions", async route => { await gate; await route.fulfill(json({ sessions: localRows })); });
  await page.goto(server.baseUrl);
  const local = page.locator('#session-list > .machine-group[data-machine=""]');
  try {
    await expect(local).toContainText("Connecting");
    await expect(local).not.toContainText("Connection failed");
    await expect(local).not.toContainText("No sessions yet");
  } finally { release(); }
  await expect(page.getByRole("button", { name: "Open test-project", exact: true })).toBeVisible();
});

test("background peer 401 cannot prompt or stall healthy local refresh", async ({ page }) => {
  await isolate(page);
  let rows = localRows;
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: [candidate] })));
  await page.route(`${peerOrigin}/api/sessions`, route => route.fulfill(json({ error: "token required" }, 401)));
  await page.route(`${server.baseUrl}/api/sessions`, route => route.fulfill(json({ sessions: rows })));
  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Open another-project", exact: true })).toBeVisible();
  rows = [localRows[0]];
  await expect(page.locator("#app-dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Open another-project", exact: true })).toHaveCount(0, { timeout: 7_000 });
});

test("open mobile drawer reconciles while terminal remains active", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await isolate(page);
  let rows = localRows;
  await page.route("**/api/sessions", route => route.fulfill(json({ sessions: rows })));
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Open test-project", exact: true }).click();
  await expect(page.locator("#terminal-view")).toBeVisible();
  await page.locator("#session-chip").click();
  await expect(page.locator('.drawer-item[data-val="another-project"]')).toBeVisible();
  rows = [localRows[0]];
  await expect(page.locator('.drawer-item[data-val="another-project"]')).toHaveCount(0, { timeout: 7_000 });
});

test("a stalled local summary does not stop the next healthy peer refresh", async ({ page }) => {
  await isolate(page);
  let peerRows = [{ name: "peer-old", triage: "idle" }];
  let holdLocal = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: [candidate] })));
  await page.route(`${peerOrigin}/api/sessions`, route => route.fulfill(json({ sessions: peerRows })));
  await page.route(`${server.baseUrl}/api/sessions`, async route => { if (holdLocal) await gate; await route.fulfill(json({ sessions: localRows })); });
  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Open peer-old", exact: true })).toBeVisible();
  holdLocal = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  // Allow this refresh's healthy result to settle, then require a *later* poll.
  await page.waitForTimeout(300);
  peerRows = [{ name: "peer-new", triage: "idle" }];
  try { await expect(page.getByRole("button", { name: "Open peer-new", exact: true })).toBeVisible({ timeout: 7_000 }); }
  finally { release(); }
});

test("terminal exit evidence invalidates session cards immediately", async ({ page }) => {
  await isolate(page);
  let rows = localRows;
  let socket: WebSocketRoute | undefined;
  await page.route("**/api/sessions", route => route.fulfill(json({ sessions: rows })));
  await page.routeWebSocket(/\/ws\/pty/, ws => {
    socket = ws;
    const upstream = ws.connectToServer();
    ws.onMessage(message => upstream.send(message));
    upstream.onMessage(message => ws.send(message));
  });
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Open test-project", exact: true }).click();
  await expect.poll(() => !!socket).toBe(true);
  rows = [localRows[1]];
  socket!.close({ code: 4001, reason: "session unavailable" });
  await expect(page.getByRole("button", { name: "Open test-project", exact: true })).toHaveCount(0, { timeout: 1_000 });
});

test("lifecycle stream connects with header auth and reconciles a snapshot", async ({ page }) => {
  await isolate(page);
  let streams = 0;
  let rows = localRows;
  await page.addInitScript(() => sessionStorage.setItem("wpAuthTokens:v1", JSON.stringify({ [location.origin]: "test-token" })));
  await page.route("**/api/sessions", route => route.fulfill(json({ sessions: rows })));
  await page.route("**/api/events?*", route => {
    streams++;
    expect(route.request().headers().authorization).toBe("Bearer test-token");
    expect(route.request().url()).not.toContain("test-token");
    rows = [localRows[0]];
    return route.fulfill({ contentType: "text/event-stream", body: 'data: {"kind":"session.exited","sessionId":"old-id","id":1,"at":"now"}\n\n' });
  });
  await page.goto(server.baseUrl);
  await expect.poll(() => streams, { timeout: 2_000 }).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Open another-project", exact: true })).toHaveCount(0, { timeout: 1_000 });
});

test("visible candidate discovery runs within fifteen seconds", async ({ page }) => {
  await isolate(page);
  let available = false;
  let scans = 0;
  await page.route("**/api/tailnet/v1/candidates", route => { scans++; return route.fulfill(json({ candidates: available ? [candidate] : [] })); });
  await page.route(`${peerOrigin}/api/sessions`, route => route.fulfill(json({ sessions: [{ name: "new-peer", triage: "idle" }] })));
  await page.clock.install();
  await page.goto(server.baseUrl);
  await expect.poll(() => scans).toBe(1);
  available = true;
  await page.clock.fastForward(15_000);
  await expect(page.getByRole("button", { name: "Open new-peer", exact: true })).toBeVisible({ timeout: 2_000 });
});

test("verified unavailable machines remain disabled with truthful service health and explicit auth", async ({ page }) => {
  await isolate(page);
  let status = 200;
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: [candidate] })));
  await page.route(`${peerOrigin}/api/sessions`, route => route.fulfill(json(status === 200 ? { sessions: [{ name: "peer-session", lastLine: "private preview" }] } : { error: "token required" }, status)));
  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Open peer-session", exact: true })).toBeVisible();
  status = 401;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const group = page.locator(`#session-list [data-machine="n-fresh:${installationId}"]`).first();
  await expect(group).toHaveClass(/offline/);
  await expect(group.getByRole("button", { name: "Start a session on fresh peer" })).toBeDisabled();
  await expect(group).not.toContainText("private preview");
  await expect(group).toContainText("Last success");
  await expect(page.getByRole("button", { name: "Authenticate fresh peer", exact: true })).toBeVisible();
  await expect(page.locator("#app-dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("#machines-list")).toContainText("Handshake verified; sessions: Authentication required");
  await expect(page.locator("#discover-status")).toContainText("Last successful discovery");
});

test("broker unavailable is unknown service health, not an empty live machine", async ({ page }) => {
  await isolate(page);
  await page.route("**/api/sessions", route => route.fulfill(json({ sessions: [] })));
  await page.route("**/api/backend", route => route.fulfill(json({ brokerReady: false, brokerAvailable: false }, 503)));
  await page.goto(server.baseUrl);
  await expect(page.locator('#session-list > .machine-group[data-machine=""]')).toHaveClass(/offline/);
  await expect(page.locator("#session-list")).toContainText("Broker unavailable");
  await expect(page.getByRole("button", { name: "Create your first session" })).toHaveCount(0);
});

test("stop acknowledgment is UUID-scoped stopping state, never a name tombstone", async ({ page }) => {
  await isolate(page);
  const oldId = "0efdbb46-5c2d-46c7-972b-14365d830c8a";
  const newId = "42d17268-cde1-4b14-990a-44e468ec6333";
  let id = oldId;
  let selector = "";
  await page.route("**/api/sessions", route => route.fulfill(json({ sessions: [{ name: "reused-name", identity: { wolfpackSessionId: id } }] })));
  await page.route("**/api/kill", route => {
    selector = route.request().postDataJSON().session;
    return route.fulfill(json({ ok: true, session: "reused-name", sessionId: oldId }));
  });
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Stop reused-name", exact: true }).click();
  await page.getByRole("dialog", { name: "Stop session", exact: true }).getByRole("button", { name: "Stop session", exact: true }).click();
  await expect.poll(() => selector).toBe(oldId);
  await expect(page.locator("#session-list")).toContainText("Stopping");
  await expect(page.getByRole("button", { name: "Open reused-name", exact: true })).toBeVisible();
  id = newId;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#session-list")).not.toContainText("Stopping");
  await expect(page.getByRole("button", { name: "Open reused-name", exact: true })).toBeVisible();
});

test("hidden pages suspend lifecycle reconnects and all chooser cadences", async ({ page }) => {
  await isolate(page);
  let streams = 0;
  let sessions = 0;
  let discoveries = 0;
  await page.route("**/api/events?*", route => { streams++; return route.fulfill({ contentType: "text/event-stream", body: ": ping\n\n" }); });
  await page.route("**/api/sessions", route => { sessions++; return route.fulfill(json({ sessions: localRows })); });
  await page.route("**/api/tailnet/v1/candidates", route => { discoveries++; return route.fulfill(json({ candidates: [] })); });
  await page.clock.install();
  await page.goto(server.baseUrl);
  await expect.poll(() => streams).toBeGreaterThan(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const before = { streams, sessions, discoveries };
  await page.clock.fastForward(60_000);
  await page.waitForTimeout(100);
  expect({ streams, sessions, discoveries }).toEqual(before);
});

test("explicit peer authentication recovers only that origin", async ({ page }) => {
  await isolate(page);
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: [candidate] })));
  await page.route(`${peerOrigin}/api/sessions`, route => route.fulfill(json(route.request().headers().authorization === "Bearer peer-secret"
    ? { sessions: [{ name: "authenticated-peer", triage: "idle" }] } : { error: "token required" }, route.request().headers().authorization === "Bearer peer-secret" ? 200 : 401)));
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Authenticate fresh peer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Authentication required", exact: true });
  await dialog.getByLabel("Access token", { exact: true }).fill("peer-secret");
  await dialog.getByRole("button", { name: "Authenticate", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open authenticated-peer", exact: true })).toBeVisible();
  const tokens = await page.evaluate(() => JSON.parse(sessionStorage.getItem("wpAuthTokens:v1") || "{}"));
  expect(tokens).toEqual({ [peerOrigin]: "peer-secret" });
});

test("installation replacement cancels an owned authentication dialog", async ({ page }) => {
  await isolate(page);
  let replaced = false;
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: [candidate] })));
  await page.route(`${peerOrigin}/api/machine`, route => route.fulfill(json({ ...handshake, machine: { ...handshake.machine,
    installationId: replaced ? "42d17268-cde1-4b14-990a-44e468ec6333" : installationId,
  } })));
  await page.route(`${peerOrigin}/api/sessions`, route => route.fulfill(json({ error: "token required" }, 401)));
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Authenticate fresh peer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Authentication required", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Access token", { exact: true }).fill("must-not-save");
  replaced = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("wpAuthTokens:v1"))).toBeNull();
  await expect(page.locator(`#session-list > [data-machine="n-fresh:${installationId}"]`)).toHaveCount(0);
});

test("stream reconnect repairs missed lifecycle changes without replay", async ({ page }) => {
  await isolate(page);
  let streams = 0;
  let sessions = 0;
  let rows = localRows;
  await page.route("**/api/events?*", route => { streams++; return route.fulfill({ contentType: "text/event-stream", body: ": ping\n\n" }); });
  await page.route("**/api/sessions", route => { sessions++; return route.fulfill(json({ sessions: rows })); });
  await page.clock.install();
  await page.goto(server.baseUrl);
  await expect.poll(() => streams).toBe(1);
  await page.clock.fastForward(200);
  await expect.poll(() => sessions).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("button", { name: "Open another-project", exact: true })).toBeVisible();
  rows = [localRows[0]];
  await page.clock.fastForward(2_100);
  await expect.poll(() => streams).toBeGreaterThan(1);
  await expect(page.getByRole("button", { name: "Open another-project", exact: true })).toHaveCount(0, { timeout: 1_000 });
});

test("chooser retention is bounded and does not survive reload", async ({ page }) => {
  await isolate(page);
  let candidates = Array.from({ length: 10 }, (_, index) => ({ ...candidate, tailnetNodeId: `n-retained-${index}`,
    hostname: `retained-${index}.example.ts.net`, origin: `https://retained-${index}.example.ts.net`,
  }));
  let requests = 0;
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates })));
  await page.route("https://**/api/machine", route => {
    const peer = candidates.find(candidate => route.request().url().startsWith(candidate.origin));
    return route.fulfill(json({ ...handshake, machine: { ...handshake.machine, tailnetNodeId: peer!.tailnetNodeId, origin: peer!.origin } }));
  });
  await page.route("https://**/api/sessions", route => { requests++; return route.fulfill(json({ error: "token required" }, 401)); });
  await page.goto(server.baseUrl);
  await expect.poll(() => requests).toBeGreaterThanOrEqual(10);
  await expect(page.locator("#session-list > .machine-group.offline")).toHaveCount(8);
  candidates = [];
  await page.reload();
  await expect(page.getByRole("button", { name: "Open test-project", exact: true })).toBeVisible();
  await expect(page.locator("#session-list > .machine-group.offline")).toHaveCount(0);
});

test("discovery prioritizes known verified peers ahead of a stalled candidate pool", async ({ page }) => {
  await isolate(page);
  let includeSlow = false;
  let knownProbes = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow = Array.from({ length: 16 }, (_, index) => ({ ...candidate, tailnetNodeId: `n-slow-${index}`,
    hostname: `slow-${index}.example.ts.net`, origin: `https://slow-${index}.example.ts.net`,
  }));
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: includeSlow ? [...slow, candidate] : [candidate] })));
  await page.route(`${peerOrigin}/api/machine`, route => { knownProbes++; return route.fulfill(json(handshake)); });
  await page.route(`${peerOrigin}/api/sessions`, route => route.fulfill(json({ sessions: [{ name: "known-peer" }] })));
  await page.route("https://slow-*/api/machine", async route => { await gate; await route.fulfill({ status: 404 }); });
  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Open known-peer", exact: true })).toBeVisible();
  includeSlow = true;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Discover Tailnet", exact: true }).click();
  try { await expect.poll(() => knownProbes, { timeout: 1_000 }).toBeGreaterThanOrEqual(2); }
  finally { release(); }
});

test("peer discovery does not restart unrelated local session reads", async ({ page }) => {
  await isolate(page);
  let localRequests = 0;
  let probes = 0;
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: [candidate] })));
  await page.route(`${peerOrigin}/api/machine`, route => { probes++; return route.fulfill(json(handshake)); });
  await page.route(`${peerOrigin}/api/sessions`, route => route.fulfill(json({ sessions: [{ name: "known-peer" }] })));
  await page.route(`${server.baseUrl}/api/sessions`, route => { localRequests++; return route.fulfill(json({ sessions: localRows })); });
  await page.clock.install();
  await page.goto(server.baseUrl);
  await page.clock.fastForward(200);
  await expect.poll(() => localRequests).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("button", { name: "Open known-peer", exact: true })).toBeVisible();
  const before = localRequests;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Discover Tailnet", exact: true }).click();
  await expect.poll(() => probes).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(200);
  expect(localRequests).toBe(before);
});

test("drawer keyboard focus survives discovery diagnostic repaint", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await isolate(page);
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: [candidate] })));
  await page.route(`${peerOrigin}/api/sessions`, route => route.fulfill(json({ error: "token required" }, 401)));
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Open test-project", exact: true }).click();
  await page.locator("#session-chip").click();
  const auth = page.locator('#drawer-list [data-action="retry-machine"]');
  await expect(auth).toBeVisible();
  await expect(page.locator("#drawer-list .drawer-item").first()).toBeFocused();
  await auth.focus();
  await expect(auth).toBeFocused();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#discover-status")).not.toContainText("Scanning");
  await expect(auth).toBeFocused();
});

test("same-identity recovery preserves manual machine and session ordering through an open drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await isolate(page);
  const identity = `n-fresh:${installationId}`;
  const firstId = "0efdbb46-5c2d-46c7-972b-14365d830c8a";
  const secondId = "42d17268-cde1-4b14-990a-44e468ec6333";
  await page.addInitScript(({ identity, firstId, secondId }) => {
    localStorage.setItem("wolfpack-session-order", JSON.stringify({ version: 1, sessions: [
      { machineUrl: identity, sessionId: secondId }, { machineUrl: identity, sessionId: firstId },
    ] }));
    localStorage.setItem("wolfpack-machine-group-preferences", JSON.stringify({ version: 1, order: [identity, "local"], collapsed: { main: [], sidebar: [] } }));
  }, { identity, firstId, secondId });
  let status = 200;
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: [candidate] })));
  await page.route(`${peerOrigin}/api/sessions`, route => route.fulfill(json(status === 200 ? { sessions: [
    { name: "peer-first", identity: { wolfpackSessionId: firstId } },
    { name: "peer-second", identity: { wolfpackSessionId: secondId } },
  ] } : { error: "unavailable" }, status)));
  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Open peer-first", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open test-project", exact: true }).click();
  await page.locator("#session-chip").click();
  const peerNames = page.locator(`#drawer-list .drawer-item[data-val^="${identity}|"] .drawer-item-name`);
  await expect(peerNames).toHaveText(["peer-second", "peer-first"]);
  status = 503;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(`#drawer-list .machine-group[data-machine="${identity}"]`)).toContainText("Server unavailable");
  status = 200;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(peerNames).toHaveText(["peer-second", "peer-first"]);
  await expect(page.locator("#session-list > .machine-group").first()).toHaveAttribute("data-machine", identity);
});

test("registry and chooser agree at stale count and session-success TTL boundaries", async ({ page }) => {
  await isolate(page);
  const day = 24 * 60 * 60 * 1_000;
  const candidates = Array.from({ length: 9 }, (_, index) => ({ hostname: `retained-${index}.example.ts.net`, tailnetNodeId: `n-retained-${index}`, origin: `https://retained-${index}.example.ts.net`, online: true }));
  let unavailable = false;
  let lateSummary = false;
  let releaseSummary!: () => void;
  const summaryGate = new Promise<void>(resolve => { releaseSummary = resolve; });
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json(unavailable ? { candidates: [], error: "enumeration unavailable" } : { candidates })));
  await page.route("**/api/events?*", route => route.fulfill({ status: 404, body: "" }));
  await page.route("https://retained-*/**", async route => {
    const url = new URL(route.request().url());
    const candidate = candidates.find(candidate => candidate.origin === url.origin)!;
    if (lateSummary && url.pathname === "/api/sessions") await summaryGate;
    return route.fulfill(json(url.pathname === "/api/machine"
      ? { ...handshake, machine: { ...handshake.machine, tailnetNodeId: candidate.tailnetNodeId, origin: candidate.origin, displayName: candidate.hostname } }
      : { sessions: [{ name: lateSummary ? "peer-late-summary" : "peer-initial", triage: "idle" }] }));
  });
  await page.clock.install();
  await page.goto(server.baseUrl);
  const remoteGroups = page.locator('#session-list > .machine-group:not([data-machine=""])');
  await expect(remoteGroups).toHaveCount(9);
  await expect(remoteGroups.locator('[data-action="open-session"]')).toHaveCount(9);
  await page.clock.pauseAt(new Date(Date.now() + 1_000));
  const verifiedAt = await page.evaluate(() => Date.now());
  await page.clock.setSystemTime(new Date(verifiedAt + 6 * day));
  lateSummary = true;
  await page.clock.runFor(5_000); // Session polling, not the 15s handshake cadence.
  releaseSummary(); // All summaries commit at the same frozen clock boundary.
  await expect(remoteGroups.locator('[data-action="open-session"][data-session="peer-late-summary"]')).toHaveCount(9);
  const lastSummaryAt = await page.evaluate(() => Date.now());
  unavailable = true;
  await page.clock.setSystemTime(new Date(verifiedAt + 7 * day + 2_000));
  await page.getByRole("button", { name: "Settings", exact: true }).click({ force: true });
  await page.getByRole("button", { name: "Discover Tailnet", exact: true }).click({ force: true });
  await expect(page.locator("#discover-status")).toContainText("enumeration unavailable");
  await expect(page.locator("#machines-list .machine-item")).toHaveCount(8);
  await expect(remoteGroups).toHaveCount(8);
  await expect(remoteGroups.locator('[data-action="open-session"]')).toHaveCount(0);
  const names = await remoteGroups.locator(".machine-header-name").allTextContents();
  expect(names).toHaveLength(8);
  for (const name of names) await expect(page.locator("#machines-list")).toContainText(name.trim());
  await page.clock.setSystemTime(new Date(lastSummaryAt + 7 * day));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(remoteGroups).toHaveCount(8); // Exactly seven days remains retained.
  await expect(page.locator("#machines-list .machine-item")).toHaveCount(8);
  await page.clock.setSystemTime(new Date(lastSummaryAt + 7 * day + 1));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(remoteGroups).toHaveCount(0);
  await expect(page.locator("#machines-list .machine-item")).toHaveCount(0);
});

for (const failure of [
  { name: "429", status: 429, contentType: "application/json", body: "private-event-body", diagnostic: "HTTP 429" },
  { name: "wrong content type", status: 200, contentType: "application/json", body: "private-event-body", diagnostic: "unexpected content type" },
  { name: "malformed event", status: 200, contentType: "text/event-stream", body: "data: private-event-body\n\n", diagnostic: "invalid event data" },
]) {
  test(`application reports bounded lifecycle diagnostics for ${failure.name}`, async ({ page }) => {
    await isolate(page);
    const diagnostics: string[] = [];
    page.on("console", message => { if (message.text().startsWith("[sessions] lifecycle stream:")) diagnostics.push(message.text()); });
    await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: [candidate] })));
    await page.route("**/api/sessions", route => route.fulfill(json({ sessions: localRows })));
    await page.route("**/api/events?*", route => route.fulfill({ status: failure.status, contentType: failure.contentType, body: failure.body, headers: { "Access-Control-Allow-Origin": "*" } }));
    await page.goto(server.baseUrl);
    await expect.poll(() => diagnostics.find(message => message.includes(`n-fresh:${installationId}`))).toContain(failure.diagnostic);
    expect(diagnostics.every(message => message.length < 256 && !message.includes("private-event-body"))).toBe(true);
    await expect(page.locator("#app-dialog")).not.toBeVisible();
  });
}

test("notification route is consumed once across staggered machine completions and preserves a newer route", async ({ page, isMobile }) => {
  test.skip(isMobile, "exercises the desktop terminal-switch paint barrier");
  await isolate(page);
  await page.addInitScript(() => localStorage.setItem("wolfpackDebug", "1"));
  let holdPeer = false;
  let peerHeld = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill(json({ candidates: [candidate] })));
  await page.route("**/api/events?*", route => route.fulfill({ status: 404, body: "" }));
  await page.route(`${server.baseUrl}/api/sessions`, route => route.fulfill(json({ sessions: [localRows[0], { ...localRows[1], identity: { wolfpackSessionId: "notification-target", wolfpackSessionName: "another-project" } }] })));
  await page.route(`${peerOrigin}/api/sessions`, async route => {
    if (holdPeer) { peerHeld = true; await gate; }
    await route.fulfill(json({ sessions: [{ name: holdPeer ? "peer-after" : "peer-before", triage: "idle" }] }));
  });
  await page.clock.install();
  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Open peer-before", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open test-project", exact: true }).click();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible();
  await page.evaluate(() => {
    const debug = window as unknown as { notificationOpens: number; __wfTraceObserver: (trace: { _meta: { session: string } }, event: { kind: string }) => void };
    debug.notificationOpens = 0;
    debug.__wfTraceObserver = (trace, event) => { if (trace._meta.session === "another-project" && event.kind === "openSession.start") debug.notificationOpens++; };
    history.replaceState(null, "", "/?sessionId=notification-target&session=another-project&machine=local");
  });
  holdPeer = true;
  // Freeze the two-rAF terminal-switch paint barrier while independent local
  // and peer HTTP responses settle in different turns.
  await page.clock.pauseAt(new Date(Date.now() + 5_000));
  try {
    await expect.poll(() => peerHeld).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as unknown as { notificationOpens: number }).notificationOpens)).toBe(1);
    release();
    await expect(page.locator(`#session-list .machine-group[data-machine="n-fresh:${installationId}"]`)).toContainText("peer-after");
    expect(await page.evaluate(() => (window as unknown as { notificationOpens: number }).notificationOpens)).toBe(1);
    await expect(page).toHaveURL(server.baseUrl + "/");
    await page.evaluate(() => history.replaceState(null, "", "/?sessionId=newer-route&session=newer&machine=local"));
  } finally { release(); await page.clock.runFor(100); }
  // Completing an older open must not strip a notification that arrived later.
  await expect(page).toHaveURL(/sessionId=newer-route/);
});

for (const surface of ["main", "sidebar"] as const) {
  for (const interaction of ["focus", "drag"] as const) {
    test(`${surface} ${interaction} survives diagnostic-only automatic discovery`, async ({ page, isMobile }) => {
      test.skip(isMobile, "desktop chooser ownership and pointer drag regression");
      await isolate(page);
      let scans = 0;
      await page.route("**/api/tailnet/v1/candidates", route => { scans++; return route.fulfill(json({ candidates: [candidate] })); });
      await page.route("**/api/sessions", route => route.fulfill(json({ sessions: localRows })));
      await page.clock.install();
      await page.goto(server.baseUrl);
      await expect(page.locator('#session-list > .machine-group[data-machine=""] .card').first()).toBeVisible();
      if (surface === "sidebar") await page.getByRole("button", { name: "Collapse sessions", exact: true }).click();
      const list = page.locator(surface === "main" ? "#session-list" : "#sidebar-session-list");
      const local = list.locator('.machine-group[data-machine=""]');
      const button = local.getByRole("button", { name: "Open test-project", exact: true });
      await expect(button).toBeVisible(); // Explicitly establish sidebar ownership, unlike the review's invalid sidebar probe.
      await expect.poll(() => scans).toBe(1);
      if (interaction === "focus") await button.focus();
      else {
        const handle = local.locator(".machine-name-handle");
        await handle.hover();
        const box = (await handle.boundingBox())!;
        await page.mouse.down();
        await page.mouse.move(box.x + 15, box.y + 20, { steps: 2 });
        await expect(page.locator(".machine-group-drag-floating")).toBeVisible();
      }
      try {
        await page.clock.fastForward(16_000);
        await expect.poll(() => scans).toBeGreaterThanOrEqual(2);
        await expect(page.locator("#discover-status")).not.toContainText("Scanning");
        if (interaction === "focus") await expect(button).toBeFocused();
        else await expect(page.locator(".machine-group-drag-floating")).toBeVisible();
      } finally { if (interaction === "drag") await page.mouse.up(); }
    });
  }
}

for (const event of ["focus", "pageshow"] as const) {
  test(`${event} reconciles newly available peers without manual discovery`, async ({ page }) => {
    await isolate(page);
    let available = false;
    let scans = 0;
    await page.route("**/api/tailnet/v1/candidates", route => { scans++; return route.fulfill(json({ candidates: available ? [candidate] : [] })); });
    await page.route(`${peerOrigin}/api/sessions`, route => route.fulfill(json({ sessions: [{ name: "peer-session", triage: "idle" }] })));
    await page.clock.install();
    await page.goto(server.baseUrl);
    await expect(page.getByRole("button", { name: "Open test-project", exact: true })).toBeVisible();
    await expect.poll(() => scans).toBe(1);
    available = true;
    await page.clock.fastForward(2_000);
    await page.evaluate(event => window.dispatchEvent(event === "focus" ? new Event("focus") : new PageTransitionEvent("pageshow", { persisted: true })), event);
    await expect(page.getByRole("button", { name: "Open peer-session", exact: true })).toBeVisible({ timeout: 2_000 });
  });
}
