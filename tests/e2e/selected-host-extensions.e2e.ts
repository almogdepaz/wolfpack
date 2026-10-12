import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { expect, test, type Page } from "@playwright/test";
import { PROVIDER_DEFINITIONS } from "../../src/provider-readiness.ts";
import { start, BROKER_BIN, type BrokerTestServer, type BrokerTestOwnership } from "./broker-helpers.ts";
import { createOwnedTestServerHome, removeOwnedTestServerHome, type OwnedTestServerHome } from "./test-server-home.ts";
import { DEFAULT_WORKSPACE_SHELL_PREFERENCES, WORKSPACE_SHELL_PREFERENCE_KEY } from '../../public/workspace-shell.ts';

const ROOT = join(import.meta.dirname, "..", "..");
const IDS = { local: "44444444-4444-4444-8444-444444444444", a: "11111111-1111-4111-8111-111111111111", b: "33333333-3333-4333-8333-333333333333" };
type Key = keyof typeof IDS;
interface Host { readonly key: Key; readonly home: OwnedTestServerHome; readonly server: BrokerTestServer; readonly token: string; readonly session: string; readonly sessionId: string; readonly parent?: { readonly name: string; readonly id: string }; readonly child?: { readonly name: string; readonly id: string }; }
const hosts = new Map<Key, Host>();
const homes: OwnedTestServerHome[] = [];
const startupOwners: BrokerTestOwnership[] = [];
const sockets = new Set<WebSocket>();
let bundleHash = "";
function token(secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"), now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 3600 })).toString("base64url");
  return `${header}.${payload}.${createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url")}`;
}
function host(key: Key): Host { const value = hosts.get(key); if (!value) throw new Error(`owned host ${key} unavailable`); return value; }
async function createSession(server: BrokerTestServer, bearer: string, key: Key, name: string, parent?: { readonly name: string; readonly id: string }): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/create`, { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectDir: realpathSync(join(host(key).home.path, 'dev', `project-${key}`)), sessionName: name, cmd: "shell", ...(parent ? { parentSession: parent.name } : {}) }) });
  const created: unknown = await response.json();
  expect(response.status, JSON.stringify(created)).toBe(200);
  expect(created).toMatchObject({ ok: true, session: name });
  let id: string | undefined;
  await expect.poll(async () => {
    const listed = await fetch(`${server.baseUrl}/api/sessions`, { headers: { Authorization: `Bearer ${bearer}` } });
    expect(listed.status).toBe(200);
    const value = await listed.json() as { sessions: Array<{ name: string; identity?: { wolfpackSessionId: string } }> };
    id = value.sessions.find(session => session.name === name)?.identity?.wolfpackSessionId;
    return !!id;
  }).toBe(true);
  if (!id) throw new Error("owned real broker did not publish exact session identity");
  return id;
}
async function publish(server: BrokerTestServer, bearer: string, sessionId: string, message: string): Promise<void> {
  const response = await fetch(`${server.baseUrl}/api/extensions/documents/notes/context`, { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, document: message, ifRevision: 0, requestId: randomUUID(), schemaVersion: 1 }) });
  expect(response.status).toBe(200);
}
async function command(key: "a" | "b", action: string, value?: boolean): Promise<void> {
  const owner = host(key), response = await fetch(`${owner.server.baseUrl}/api/fixture/extensions`, { method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ action, ...(value === undefined ? {} : { value }) }) });
  expect(response.status).toBe(200);
}

test.beforeAll(async () => {
  if (!BROKER_BIN) throw new Error("native selected-host acceptance requires an existing approved broker binary; no download/skip");
  const buildHome = createOwnedTestServerHome(); homes.push(buildHome);
  const bundle = join(buildHome.path, "app.bundle.js");
  execFileSync("bun", ["build", join(ROOT, "public/app.ts"), "--outfile", bundle, "--target=browser", "--format=iife", "--minify"], { cwd: ROOT, stdio: "pipe" });
  bundleHash = createHash("sha256").update(readFileSync(bundle)).digest("hex");
  for (const key of ["a", "b", "local"] as const) {
    const home = createOwnedTestServerHome(); homes.push(home);
    const dev = join(home.path, "dev"), project = join(dev, `project-${key}`), bin = join(home.path, "bin");
    mkdirSync(project, { recursive: true }); mkdirSync(bin);
    execFileSync("git", ["init", `--initial-branch=branch-${key}`, project], { stdio: "pipe" });
    writeFileSync(join(project, `only-${key}.txt`), key);
    writeFileSync(join(home.path, "machine-id"), IDS[key] + "\n", { mode: 0o600 });
    for (const provider of PROVIDER_DEFINITIONS) writeFileSync(join(bin, provider.command), '#!/bin/sh\n[ "$1" = "--version" ] || exit 64\nprintf "selected-host-fixture 1.0\\n"\n', { mode: 0o700 });
    const canonicalDev = realpathSync(dev);
    // Simulated verified Serve identity lives ONLY in this owned home; keep real CORS policy.
    mkdirSync(join(home.path, '.wolfpack'), { mode: 0o700 });
    writeFileSync(join(home.path, '.wolfpack/config.json'), JSON.stringify({ devDir: canonicalDev, port: 18799, tailscaleHostname: `${key}.fixture.ts.net` }), { mode: 0o600 });
    const secret = `selected-host-${key}-native-browser-secret-123`, bearer = token(secret);
    const peerBases = key === "local" ? Object.fromEntries((["a", "b"] as const).map(peer => [`https://${peer}.fixture.ts.net`, host(peer).server.baseUrl])) : {};
    const status = { Self: { ID: `node-${key}`, DNSName: `${key}.fixture.ts.net`, HostName: key }, Peer: key === "local" ? Object.fromEntries((["a", "b"] as const).map(peer => [peer, { ID: `node-${peer}`, DNSName: `${peer}.fixture.ts.net`, Online: true }])) : {} };
    const privateEnvironment = { HOME: home.path, ZDOTDIR: home.path, TMPDIR: home.path, XDG_CONFIG_HOME: join(home.path, "config"), XDG_DATA_HOME: join(home.path, "data"), SHELL: "/bin/sh", PATH: `${bin}:${process.env.PATH ?? ""}` };
    const server = await start({ onOwnership: owner => startupOwners.push(owner), serverEntry: join(ROOT, "tests/e2e/selected-host-server.ts"), brokerEnvOverrides: privateEnvironment, envOverrides: {
      ...privateEnvironment, WOLFPACK_SELECTED_HOST_FIXTURE: key, WOLFPACK_TEST_APP_BUNDLE: bundle, WOLFPACK_TEST_PEER_BASES: JSON.stringify(peerBases),
      WOLFPACK_DEV_DIR: canonicalDev, WOLFPACK_MACHINE_ID_PATH: join(home.path, "machine-id"), WOLFPACK_SESSION_IDENTITY_PATH: join(home.path, "identities.json"),
      WOLFPACK_SETTINGS_PATH: join(home.path, "settings.json"), WOLFPACK_TASK_ROOT: join(home.path, "tasks"), WOLFPACK_TASK_RELAY_ROOT: join(home.path, "relay"),
      WOLFPACK_JWT_SECRET: secret, WOLFPACK_TAILSCALE_STATUS_JSON: JSON.stringify(status), WOLFPACK_LOG_LEVEL: "error",
    } });
    // Record ownership before any fixture assertions so failure cleanup still owns the process.
    const session = `selected-${key}`, partial = { key, home, server, token: bearer, session, sessionId: "" };
    hosts.set(key, partial);
    const sessionId = await createSession(server, bearer, key, session);
    if (key !== "local") {
      const parentName = `selected-${key}-parent`, parentId = await createSession(server, bearer, key, parentName);
      const childName = `selected-${key}-child`, childId = await createSession(server, bearer, key, childName, { name: parentName, id: parentId });
      hosts.set(key, { ...partial, sessionId, parent: { name: parentName, id: parentId }, child: { name: childName, id: childId } });
      await publish(server, bearer, sessionId, `document ${key}`); await publish(server, bearer, parentId, `document ${key} parent`); await publish(server, bearer, childId, `document ${key} child`);
    } else hosts.set(key, { ...partial, sessionId });
  }
});
test.afterAll(async () => {
  for (const socket of sockets) socket.terminate(); sockets.clear();
  const results = await Promise.allSettled([...startupOwners].reverse().map(owner => owner.teardown()));
  const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'owned native startup cleanup unconfirmed; homes retained');
  startupOwners.length = 0; hosts.clear();
  for (const home of homes.reverse()) removeOwnedTestServerHome(home); homes.length = 0;
});
async function authorizeAndMap(page: Page): Promise<void> {
  const tokens = Object.fromEntries([...hosts.values()].map(owner => [owner.key === "local" ? owner.server.baseUrl : `https://${owner.key}.fixture.ts.net`, owner.token]));
  await page.addInitScript(values => { sessionStorage.setItem("wpAuthTokens:v1", JSON.stringify(values)); localStorage.setItem("wpJwt", values[location.origin]!); }, tokens);
  await page.route(/^https:\/\/[ab]\.fixture\.ts\.net\//, async route => {
    const url = new URL(route.request().url()), key = url.hostname.slice(0, 1) as "a" | "b";
    const response = await route.fetch({ url: `${host(key).server.baseUrl}${url.pathname}${url.search}`, maxRedirects: 0, headers: { ...route.request().headers(), Origin: "https://local.fixture.ts.net" } });
    await route.fulfill({ response, headers: { ...response.headers(), "access-control-allow-origin": host("local").server.baseUrl } });
  });
  // Transparent byte bridge projects ONLY virtual Tailnet DNS/TLS, not terminal behavior.
  await page.routeWebSocket(/^wss:\/\/[ab]\.fixture\.ts\.net\//, route => {
    const url = new URL(route.url()), key = url.hostname.slice(0, 1) as "a" | "b";
    const socket = new WebSocket(host(key).server.baseUrl.replace("http:", "ws:") + url.pathname + url.search, { headers: { Origin: "https://local.fixture.ts.net" } });
    sockets.add(socket);
    const pending: Array<string | Buffer> = [];
    route.onMessage(message => {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
      else if (socket.readyState === WebSocket.CONNECTING) { if (pending.length >= 16) throw new Error("owned websocket alias queue exceeded bound"); pending.push(message); }
    });
    socket.on("open", () => { for (const message of pending.splice(0)) socket.send(message); });
    socket.on("message", (data, binary) => route.send(binary ? Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data) : data.toString()));
    socket.on("error", () => { void route.close({ code: 1001 }); });
    socket.on("close", () => { sockets.delete(socket); void route.close({ code: 1000 }); });
    route.onClose(() => socket.close());
  });
}
async function open(page: Page, key: Key): Promise<void> {
  await page.locator(`.card [data-action="open-session"][data-session="${host(key).session}"]`).filter({ visible: true }).first().click();
  await expect(page.locator('#desktop-terminal-container canvas')).toBeVisible({ timeout: 10_000 });
}
async function switchTo(page: Page, key: Key): Promise<void> {
  await page.locator(`[data-action="open-session"][data-session="${host(key).session}"]`).filter({ visible: true }).first().click();
  await expect(page.locator('#desktop-terminal-container canvas')).toBeVisible({ timeout: 10_000 });
}
async function trust(page: Page): Promise<void> { await page.getByRole('button', { name: 'Trust this inventory', exact: true }).click({ timeout: 5000 }); }
async function selectedWidget(page: Page, key: "a" | "b", message = `document ${key}`): Promise<void> {
  await expect(page.locator(`[data-peer-code="${key}"]`)).toContainText(`code ${key}`);
  await expect(page.locator(`[data-peer-document="${key}"]`)).toHaveText(message);
  await expect(page.locator(`[data-peer-git="${key}"]`)).toHaveText(`branch-${key}:only-${key}.txt`);
}

test('real installed peer code and SDK data switch through current host without a local package or terminal replacement', async ({ page }) => {
  await authorizeAndMap(page);
  const requests: string[] = []; page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/extensions')) requests.push(url.pathname + url.search); });
  await page.goto(host('local').server.baseUrl); await open(page, 'a');
  await page.locator('#desktop-terminal-container canvas').click({ timeout: 1000 });
  await page.keyboard.type("printf 'WP%s\\n' REMOTE_A_BEFORE_EXTENSIONS"); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('#desktop-terminal-container')!;
    return (window as unknown as { __wolfpackTest: { serializeTerminalTail(container: HTMLElement, maxLines: number): string } }).__wolfpackTest.serializeTerminalTail(container, 200);
  })).toContain('WPREMOTE_A_BEFORE_EXTENSIONS');
  expect(requests.filter(path => path.includes('/assets/'))).toHaveLength(0);
  expect(await page.evaluate(() => (window as unknown as { remoteBundleEvaluations?: number }).remoteBundleEvaluations ?? 0)).toBe(0);
  const canvas = page.locator('#desktop-terminal-container canvas');
  await canvas.evaluate(node => { (window as unknown as { ownedCanvas?: Element }).ownedCanvas = node; });
  await trust(page); await selectedWidget(page, 'a');
  await page.getByRole('textbox', { name: 'Selected widget draft' }).fill('draft a');
  expect(await canvas.evaluate(node => node === (window as unknown as { ownedCanvas?: Element }).ownedCanvas)).toBe(true);
  await switchTo(page, 'b'); await trust(page); await selectedWidget(page, 'b');
  await expect(page.getByRole('textbox', { name: 'Selected widget draft' })).toHaveValue('');
  await switchTo(page, 'a'); await selectedWidget(page, 'a');
  await expect(page.getByRole('textbox', { name: 'Selected widget draft' })).toHaveValue('draft a');
  expect(await page.evaluate(() => (window as unknown as { remoteBundleEvaluations: number }).remoteBundleEvaluations)).toBe(2);
  const assets = requests.filter(path => path.includes('/assets/'));
  expect(assets).toHaveLength(2); expect(assets.every(path => path.startsWith('/api/extensions/peer/'))).toBe(true);
  expect(requests.filter(path => path.includes('/documents/') || path.includes('/project/')).every(path => path.startsWith('/api/extensions/peer/'))).toBe(true);
  await switchTo(page, 'local'); await expect(page.locator('[data-peer-code]')).toHaveCount(0);
  await page.locator('#desktop-terminal-container').click(); await page.keyboard.type("printf 'WP%s\\n' LOCAL_SELECTED_HOST"); await page.keyboard.press('Enter');
  await expect.poll(async () => (await (await fetch(`${host('local').server.baseUrl}/api/poll?session=${host('local').session}`, { headers: { Authorization: `Bearer ${host('local').token}` } })).json() as { pane: string }).pane).toContain('WPLOCAL_SELECTED_HOST');
  const localCatalog = await (await fetch(`${host('local').server.baseUrl}/api/extensions`, { headers: { Authorization: `Bearer ${host('local').token}` } })).json() as { installations: unknown[] };
  expect(localCatalog.installations).toHaveLength(0);
  const receipt = test.info().outputPath('installed-peer-browser-counts.json');
  writeFileSync(receipt, JSON.stringify({ boundary: 'three actual broker/server processes, real runtimes/docs/repos; external Tailnet HTTP/TLS/websocket bytes transparently aliased', bundleHash, assets, requests, sessionIds: Object.fromEntries([...hosts].map(([key, owner]) => [key, owner.sessionId])) }, null, 2));
  await test.info().attach('installed-peer-browser-counts', { path: receipt, contentType: 'application/json' });
});

test('pending inline approval allows real peer card navigation with collapsed widgets and no stale imports', async ({ page }) => {
  await authorizeAndMap(page);
  await page.addInitScript(({ key, preferences }) => localStorage.setItem(key, JSON.stringify(preferences)), { key: WORKSPACE_SHELL_PREFERENCE_KEY, preferences: { ...DEFAULT_WORKSPACE_SHELL_PREFERENCES, contextCollapsed: true } });
  const assets: string[] = []; page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/extensions/peer/') && url.pathname.includes('/assets/')) assets.push(url.pathname); });
  await page.goto(host('local').server.baseUrl); await open(page, 'a');
  const access = page.locator('#workspace-extension-access');
  await expect(access.getByRole('button', { name: 'Trust this inventory', exact: true })).toBeVisible();
  await expect(page.locator('#workspace-context-region')).not.toBeVisible();
  const old = await access.getByRole('button', { name: 'Trust this inventory', exact: true }).elementHandle();
  if (!old) throw new Error('owned old inventory control missing');
  await switchTo(page, 'b'); await expect(access).toContainText('https://b.fixture.ts.net');
  await expect(access.locator('form')).toHaveCount(1);
  await old.evaluate(button => (button as HTMLButtonElement).click());
  expect(assets).toHaveLength(0); expect(await page.evaluate(() => (window as unknown as { remoteBundleEvaluations?: number }).remoteBundleEvaluations ?? 0)).toBe(0);
  await page.locator('#desktop-terminal-container canvas').click(); await page.keyboard.type("printf 'WP%s\\n' B_WITH_PENDING_TRUST"); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wolfpackTest: { serializeTerminalTail(container: HTMLElement, maxLines: number): string } }).__wolfpackTest.serializeTerminalTail(document.getElementById('desktop-terminal-container')!, 200))).toContain('WPB_WITH_PENDING_TRUST');
  await access.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(access).toBeHidden(); expect(assets).toHaveLength(0);
  await switchTo(page, 'local'); await expect(page.locator('[data-peer-code]')).toHaveCount(0);
});

test('expired extension credentials prompt passively while an already attached real terminal remains usable', async ({ page }) => {
  await authorizeAndMap(page); await page.goto(host('local').server.baseUrl); await open(page, 'a');
  const access = page.locator('#workspace-extension-access');
  await expect(access.getByRole('button', { name: 'Trust this inventory', exact: true })).toBeVisible();
  // Existing terminal socket is authenticated; expire only the tab's subsequent HTTP credential.
  await page.evaluate(() => { const values = JSON.parse(sessionStorage.getItem('wpAuthTokens:v1')!) as Record<string, string>; values['https://a.fixture.ts.net'] = 'invalid.fixture.token'; sessionStorage.setItem('wpAuthTokens:v1', JSON.stringify(values)); });
  await trust(page); const token = access.getByLabel('Access token', { exact: true });
  await expect(token).toBeVisible(); await expect(token).toHaveAttribute('type', 'password');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.locator('#desktop-terminal-container canvas').click(); await page.keyboard.type("printf 'WP%s\\n' A_WITH_PENDING_AUTH"); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wolfpackTest: { serializeTerminalTail(container: HTMLElement, maxLines: number): string } }).__wolfpackTest.serializeTerminalTail(document.getElementById('desktop-terminal-container')!, 200))).toContain('WPA_WITH_PENDING_AUTH');
  expect(await page.evaluate(() => (window as unknown as { remoteBundleEvaluations?: number }).remoteBundleEvaluations ?? 0)).toBe(0);
  await token.fill(host('a').token); await access.getByRole('button', { name: 'Authenticate', exact: true }).click();
  await selectedWidget(page, 'a'); await expect(access).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('wpJwt'))).toBe(host('local').token);
});

test('real manual and delegation grids select owning peer and exact pane scope without draft or context reuse', async ({ page }) => {
  await authorizeAndMap(page); await page.goto(host('local').server.baseUrl); await open(page, 'a'); await trust(page); await selectedWidget(page, 'a');
  await page.getByRole('textbox', { name: 'Selected widget draft' }).fill('single a');
  await page.locator(`[data-action="toggle-grid"][data-session="${host('b').session}"]`).filter({ visible: true }).click();
  const grid = page.locator('#desktop-grid-container'), a = grid.locator(`[data-session="${host('a').session}"]`), b = grid.locator(`[data-session="${host('b').session}"]`);
  await expect(a).toHaveClass(/hydrated/); await expect(b).toHaveClass(/hydrated/);
  await b.locator('canvas').click(); await expect(page.getByRole('button', { name: 'Trust this inventory', exact: true })).toBeVisible();
  await a.locator('canvas').click(); await selectedWidget(page, 'a');
  await b.locator('canvas').click(); await trust(page); await selectedWidget(page, 'b');
  await expect(page.getByRole('textbox', { name: 'Selected widget draft' })).toHaveValue('');
  await page.getByRole('textbox', { name: 'Selected widget draft' }).fill('grid b');
  await a.locator('canvas').click(); await selectedWidget(page, 'a'); await expect(page.getByRole('textbox', { name: 'Selected widget draft' })).toHaveValue('single a');
  const parent = host('a').parent!, child = host('a').child!;
  await page.locator(`[data-action="open-session"][data-session="${parent.name}"]`).filter({ visible: true }).click();
  const delegation = page.locator('#delegation-grid-container');
  const parentCell = delegation.locator(`[data-session="${parent.name}"]`), childCell = delegation.locator(`[data-session="${child.name}"]`);
  await expect(parentCell).toHaveClass(/hydrated/); await expect(childCell).toHaveClass(/hydrated/);
  await parentCell.locator('canvas').click(); await selectedWidget(page, 'a', 'document a parent');
  await expect(page.getByRole('textbox', { name: 'Selected widget draft' })).toHaveValue(''); await page.getByRole('textbox', { name: 'Selected widget draft' }).fill('parent a');
  await childCell.locator('canvas').click(); await selectedWidget(page, 'a', 'document a child'); await expect(page.getByRole('textbox', { name: 'Selected widget draft' })).toHaveValue('');
  const captured = await page.evaluate(async primaryId => {
    const contexts = (window as unknown as { remoteContexts: Array<import('../../src/extensions/sdk.ts').ExtensionViewContext> }).remoteContexts;
    const old = contexts.find(context => context.scope.sessionId === primaryId);
    if (!old) throw new Error('real captured primary SDK context missing');
    let staleReadRejected = false;
    try { await old.documents.read('context'); } catch { staleReadRejected = true; }
    const current = contexts.findLast(context => !context.signal.aborted);
    return { oldAborted: old.signal.aborted, staleReadRejected, currentScope: current?.scope, evaluations: (window as unknown as { remoteBundleEvaluations: number }).remoteBundleEvaluations };
  }, host('a').sessionId);
  expect(captured.oldAborted).toBe(true); expect(captured.staleReadRejected).toBe(true);
  expect(captured.currentScope?.sessionId).toBe(child.id); expect(captured.currentScope).not.toHaveProperty('machine'); expect(captured.evaluations).toBe(2);
  await parentCell.locator('canvas').click(); await selectedWidget(page, 'a', 'document a parent'); await expect(page.getByRole('textbox', { name: 'Selected widget draft' })).toHaveValue('parent a');
  await switchTo(page, 'local'); await expect(page.locator('[data-peer-code]')).toHaveCount(0);
});
