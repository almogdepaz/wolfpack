import { selectTerminalLayoutFromUi } from "./helpers.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { PROVIDER_DEFINITIONS } from "../../src/provider-readiness.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { start, skipIfNoBroker, type BrokerTestServer } from "./broker-helpers.ts";
import { createOwnedTestServerHome, removeOwnedTestServerHome, type OwnedTestServerHome } from "./test-server-home.ts";

test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);

const ROOT = join(import.meta.dirname, "..", "..");
const SECRET = "extensions-frontend-browser-auth-secret-123";
const PROJECT = "extensions-browser";
const SESSION_A = "extension-browser-scope";
const SESSION_B = "extension-browser-second";
const DELEGATION_PARENT = "extension-browser-parent";
const DELEGATION_CHILD = "extension-browser-child";
const HOSTILE_GOAL = `revision one <img src=x onerror="window.__extensionHostile=1">`;
let root: string;
let home: OwnedTestServerHome | undefined;
let server: BrokerTestServer | undefined;
let cli: string;
let alphaSource: string;
const sessionIds = new Map<string, string>();

function environment(port?: number): Record<string, string> {
  const value: Record<string, string> = {
    PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, SHELL: "/bin/sh", ZDOTDIR: home!.path, HOME: home!.path, TMPDIR: root,
    WOLFPACK_TEST: "1", WOLFPACK_LOG_LEVEL: "error", WOLFPACK_DEV_DIR: join(root, "dev"),
    WOLFPACK_TAILSCALE_STATUS_JSON: "{}", // Local-name fallback without consulting the operator's Tailnet.
    WOLFPACK_MACHINE_ID_PATH: join(home!.path, "machine-id"), WOLFPACK_SESSION_IDENTITY_PATH: join(home!.path, "session-identities.json"),
    WOLFPACK_SETTINGS_PATH: join(home!.path, "settings.json"), WOLFPACK_TASK_ROOT: join(home!.path, "tasks"), WOLFPACK_TASK_RELAY_ROOT: join(home!.path, "relay"),
    WOLFPACK_PI_SKILLS_ROOT: join(home!.path, ".pi", "agent", "skills"), WOLFPACK_JWT_SECRET: SECRET,
  };
  if (port !== undefined) value.WOLFPACK_PORT = String(port);
  return value;
}

function runCliAttempt(args: readonly string[], port?: number): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(cli, args, { cwd: root, env: environment(port), stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function runCli(args: readonly string[], port?: number): string {
  const result = runCliAttempt(args, port);
  expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout;
}

function token(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
  return `${header}.${payload}.${createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url")}`;
}

function writeGenericPackage(id: string, title: string, version = "1.0.0", withLayout = false): string {
  const source = join(root, id);
  mkdirSync(join(source, "dist"), { recursive: true, mode: 0o700 });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: `wolfpack-${id}`, version, wolfpack: { manifestVersion: 1, apiVersion: 1, id, ui: "dist/ui.js", skills: [], documents: [] } }));
  const layout = withLayout ? `host.registerTerminalLayout({ id: "recipe", title: ${JSON.stringify(`${title} recipe`)}, arrange(context) { return { version: 1, rows: Array.from({ length: Math.max(1, context.panes.length) }, () => ({ size: 1 })), columns: [{ size: 1 }], placements: context.panes.map((pane, row) => ({ paneId: pane.id, row, column: 0 })) }; } });` : "";
  writeFileSync(join(source, "dist", "ui.js"), `export default host => { host.registerContextView({ id: "shared", title: ${JSON.stringify(title)}, mount(container) { container.textContent = ${JSON.stringify(`${title} mounted`)}; return { dispose() {} }; } }); ${layout} };\n`);
  return source;
}

async function createSession(name: string, parentSession?: string): Promise<void> {
  const response = await fetch(`${server!.baseUrl}/api/create`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token()}` },
    body: JSON.stringify({ projectDir: join(root, "dev", PROJECT), cmd: "shell", sessionName: name, ...(parentSession ? { parentSession } : {}) }),
  });
  expect(response.ok, `create ${name}: ${response.status} ${await response.text()}`).toBe(true);
}

async function refreshSessionIds(): Promise<void> {
  await expect.poll(async () => {
    const response = await fetch(`${server!.baseUrl}/api/sessions`, { headers: { authorization: `Bearer ${token()}` } });
    const payload = await response.json() as { sessions?: Array<{ name?: string; identity?: { wolfpackSessionId?: string } }> };
    for (const session of payload.sessions ?? []) {
      const id = session.identity?.wolfpackSessionId;
      if (session.name && id) sessionIds.set(session.name, id);
    }
    return [SESSION_A, SESSION_B, DELEGATION_PARENT, DELEGATION_CHILD].every(name => sessionIds.has(name));
  }).toBe(true);
}

function writeContext(filename: string, goal: string, schemaVersion = 1): string {
  const path = join(root, filename);
  writeFileSync(path, JSON.stringify({ schemaVersion, goal, planItems: [], decisions: [], blockers: [], nextSteps: [] }));
  return path;
}

function publishContext(sessionName: string, goal: string, ifRevision: number): string {
  return runCli([
    "extension-data", "publish", "agent-context/context", "--session", sessionIds.get(sessionName)!,
    "--file", writeContext(`${sessionName}-${randomUUID()}.json`, goal), "--if-revision", String(ifRevision),
    "--request-id", randomUUID(), "--json",
  ], server!.port);
}

async function authorize(page: Page, safeMode = false): Promise<void> {
  await page.addInitScript(({ bearer, safe }) => {
    sessionStorage.setItem("wpAuthTokens:v1", JSON.stringify({ [location.origin]: bearer }));
    localStorage.setItem("wpJwt", bearer);
    if (safe) localStorage.setItem("wp-effects", JSON.stringify({ extensionSafeMode: true }));
  }, { bearer: token(), safe: safeMode });
}

async function openSession(page: Page, name: string): Promise<void> {
  await page.locator(".card", { hasText: name }).first().click();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 10_000 });
}

async function showWidgets(page: Page): Promise<void> {
  const show = page.locator("#workspace-restore");
  if (await show.isVisible()) await show.click();
}

async function switchSession(page: Page, name: string, testInfo: TestInfo): Promise<void> {
  const mobileBack = page.locator("#workspace-context-back");
  const wasWidgetScreen = await mobileBack.isVisible();
  if (wasWidgetScreen) await mobileBack.click();
  if (testInfo.project.name === "desktop") {
    await page.locator(`[data-action="open-session"][data-session="${name}"]`).filter({ visible: true }).first().click();
  } else {
    await page.locator("#session-chip").click();
    await page.locator(`.drawer-item[data-val="${name}"]`).click();
  }
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 10_000 });
  if (wasWidgetScreen) await showWidgets(page);
}

async function refreshThroughSessionSwitch(page: Page, testInfo: TestInfo): Promise<void> {
  await switchSession(page, SESSION_B, testInfo);
  await switchSession(page, SESSION_A, testInfo);
}

async function selectAgentContext(page: Page): Promise<void> {
  await showWidgets(page);
  await expect(page.getByRole("tab", { name: /Agent Context/ })).toBeVisible({ timeout: 5_000 });
  await page.getByRole("tab", { name: /Agent Context/ }).click();
}

// Production boundary: the compiled public CLI snapshots ordinary packages
// before the authenticated real-broker server starts. Browser code only sees
// catalog/document/asset HTTP routes and the verified Blob loader.
test.beforeAll(async () => {
  root = resolve(mkdtempSync(join(tmpdir(), "wp-extensions-browser-")));
  home = createOwnedTestServerHome();
  mkdirSync(join(root, "dev", PROJECT), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "bin"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home.path, ".profile"), `export PATH=${JSON.stringify(join(root, "bin"))}:"$PATH"\n`);
  // Settings performs provider readiness probes. Never execute operator-installed
  // agents (or their subprocess trees) in this widget-focused fixture.
  for (const provider of PROVIDER_DEFINITIONS) {
    writeFileSync(join(root, "bin", provider.command), '#!/bin/sh\n[ "$1" = "--version" ] || exit 64\nprintf "widget-fixture-provider 1.0\\n"\n', { mode: 0o700 });
  }
  for (const provider of PROVIDER_DEFINITIONS) expect(execFileSync(join(root, "bin", provider.command), ["--version"], { encoding: "utf8", timeout: 2_000 }).trim()).toBe("widget-fixture-provider 1.0");
  cli = join(root, "bin", "wolfpack");
  const build = spawnSync("bun", ["build", "--compile", join(ROOT, "src", "cli", "index.ts"), "--outfile", cli], { cwd: ROOT, env: environment(), stdio: ["ignore", "pipe", "pipe"] });
  expect(build.status, build.stderr.toString()).toBe(0);
  alphaSource = writeGenericPackage("alpha", "Alpha", "1.0.0", true);
  const beta = writeGenericPackage("beta", "Beta");
  runCli(["extensions", "install", alphaSource, "--trust-browser-code"]);
  runCli(["extensions", "install", beta, "--trust-browser-code"]);
  runCli(["extensions", "install", join(ROOT, "examples", "extensions", "agent-context"), "--trust-browser-code", "--skills", "pi"]);
  runCli(["extensions", "install", join(ROOT, "examples", "extensions", "notes"), "--trust-browser-code"]);
  expect(existsSync(join(home.path, ".pi", "agent", "skills", "wolfpack-agent-context", "SKILL.md"))).toBe(true);
  server = await start({ envOverrides: environment() });
  const readiness = await (await fetch(`${server.baseUrl}/api/providers`, { headers: { authorization: `Bearer ${token()}` } })).json();
  expect(readiness.providers).toHaveLength(PROVIDER_DEFINITIONS.length);
  for (const provider of readiness.providers) {
    expect(provider.executablePath).toBe(join(root, "bin", provider.command));
    expect(provider.version).toBe("widget-fixture-provider 1.0");
  }
  writeFileSync(join(home.path, ".wolfpack", "config.json"), JSON.stringify({ devDir: join(root, "dev"), port: server.port }), { mode: 0o600 });
  await createSession(SESSION_A);
  await createSession(SESSION_B);
  await createSession(DELEGATION_PARENT);
  await createSession(DELEGATION_CHILD, DELEGATION_PARENT);
  await refreshSessionIds();
  publishContext(SESSION_A, HOSTILE_GOAL, 0);
  publishContext(DELEGATION_PARENT, "delegation parent", 0);
  publishContext(DELEGATION_CHILD, "delegation child", 0);
});

test.afterAll(async () => {
  await server?.teardown();
  server = undefined;
  if (home) removeOwnedTestServerHome(home);
  home = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});

test("independent widget areas retain live terminals and drafts while mobile leaves desktop tabs untouched", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop simultaneous areas with responsive mobile recovery");
  await authorize(page);
  let sockets = 0;
  page.on("websocket", socket => { if (socket.url().includes("/ws/pty")) sockets++; });
  await page.goto(server!.baseUrl);
  await openSession(page, SESSION_A);
  const terminal = page.locator("#desktop-terminal-container");
  await expect(terminal).toHaveAttribute("data-terminal-load-state", "live");
  await page.getByRole("tab", { name: "Notes", exact: true }).click();
  const note = page.locator("[data-context-view='notes/notes'] textarea");
  await note.fill("independent retained draft");
  await note.evaluate(node => { (window as any).__independentNote = { node, parent: node.parentElement, view: node.closest("[data-context-view]") }; });
  const canvas = terminal.locator("canvas");
  await canvas.evaluate(node => { (window as any).__independentCanvas = node; });
  const attached = sockets;
  await page.getByRole("combobox", { name: "Widget panel placement" }).selectOption("bottom");
  const right = page.locator('.widget-panel[data-widget-area="right"]:visible');
  const bottom = page.locator('.widget-panel[data-widget-area="bottom"]:visible');
  await right.getByRole("tab", { name: "Alpha", exact: true }).click();
  await expect(bottom.locator("textarea")).toHaveValue("independent retained draft");
  await expect(right.locator("[data-context-view='alpha/shared']")).toHaveText("Alpha mounted");
  const terminalBox = (await page.locator("#workspace-terminal-region").boundingBox())!;
  const rightBox = (await right.boundingBox())!; const bottomBox = (await bottom.boundingBox())!;
  expect(rightBox.x).toBeGreaterThanOrEqual(terminalBox.x + terminalBox.width);
  expect(bottomBox.y).toBeGreaterThanOrEqual(terminalBox.y + terminalBox.height);
  expect(Math.abs(bottomBox.width - terminalBox.width)).toBeLessThanOrEqual(2);
  for (const [name, key] of [["Resize right panels", "ArrowLeft"], ["Resize bottom panels", "ArrowUp"]]) {
    const divider = page.getByRole("separator", { name: name!, exact: true });
    const before = Number(await divider.getAttribute("aria-valuenow"));
    await divider.focus(); await divider.press(key!);
    await expect(divider).toHaveAttribute("aria-valuenow", String(before + 10));
  }
  await bottom.getByRole("button", { name: "Context full view", exact: true }).click();
  await expect(right).toBeHidden(); await expect(terminal).toBeHidden();
  await page.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await expect(right).toBeVisible(); await expect(bottom).toBeVisible();
  await right.getByRole("combobox", { name: "Widget panel placement" }).selectOption("bottom");
  await expect(bottom.getByRole("tab", { name: "Alpha", exact: true })).toHaveAttribute("aria-selected", "true");
  await bottom.getByRole("tab", { name: "Notes", exact: true }).click();
  await expect(note).toHaveValue("independent retained draft");
  await bottom.getByRole("tab", { name: "Alpha", exact: true }).click();
  await bottom.getByRole("combobox", { name: "Widget panel placement" }).selectOption("right");
  await expect(right.locator("[data-context-view='alpha/shared']")).toBeVisible();
  await expect(note).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("independent-widget-areas.png") });
  const preferences = await page.evaluate(() => [localStorage.getItem("wolfpack-widget-layout:v1"), localStorage.getItem("wolfpack-workspace-shell")]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#workspace-restore").click();
  await page.getByRole("tab", { name: "Beta", exact: true }).click();
  await expect(page.locator("[data-context-view='beta/shared']")).toBeVisible();
  await expect(note).toBeHidden();
  await page.locator("#workspace-context-back").click();
  await expect(terminal).toBeVisible();
  expect(await page.evaluate(() => [localStorage.getItem("wolfpack-widget-layout:v1"), localStorage.getItem("wolfpack-workspace-shell")])).toEqual(preferences);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(right.locator("[data-context-view='alpha/shared']")).toBeVisible();
  await expect(note).toHaveValue("independent retained draft");
  expect(await note.evaluate(node => { const old = (window as any).__independentNote; return node === old.node && node.parentElement === old.parent && node.closest("[data-context-view]") === old.view; })).toBe(true);
  expect(await canvas.evaluate(node => node === (window as any).__independentCanvas)).toBe(true);
  expect(sockets).toBe(attached);
  await expect(terminal).toHaveAttribute("data-terminal-load-state", "live");
  await right.getByRole("tab", { name: "Beta", exact: true }).focus();
  await page.keyboard.press("Home");
  await expect(right.getByRole("tab").first()).toBeFocused();
  await expect(right.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
  await right.getByRole("tab", { name: "Alpha", exact: true }).click();
  await page.reload(); await openSession(page, SESSION_A);
  await expect(right.locator("[data-context-view='alpha/shared']")).toBeVisible();
  await expect(bottom.locator("textarea")).toHaveValue("independent retained draft");
});

test("native panels share widget areas and Main recovers without losing a draft or desktop preferences", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "native/widget docking with responsive recovery");
  await authorize(page);
  let sockets = 0;
  page.on("websocket", socket => { if (socket.url().includes("/ws/pty")) sockets++; });
  await page.goto(server!.baseUrl); await openSession(page, SESSION_A);
  const terminal = page.locator("#workspace-terminal-region"), sessions = page.locator("#desktop-sidebar");
  await expect(page.locator("#desktop-terminal-container")).toHaveAttribute("data-terminal-load-state", "live");
  await page.getByRole("tab", { name: "Notes", exact: true }).click();
  const note = page.locator("[data-context-view='notes/notes'] textarea");
  await note.fill("native docking retained draft");
  await note.evaluate(node => { (window as any).__dockingNote = { node, parent: node.parentElement }; });
  await terminal.locator("canvas").evaluate(node => { (window as any).__dockingCanvas = node; });
  const attached = sockets;
  await page.getByRole("combobox", { name: "Widget panel placement" }).selectOption("main");
  await expect(terminal).toBeHidden();
  await page.getByRole("button", { name: "Move panels", exact: true }).click();
  await page.getByRole("combobox", { name: "Terminal grid placement", exact: true }).selectOption("bottom");
  await page.getByRole("combobox", { name: "Sessions placement", exact: true }).selectOption("right");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(terminal).toBeVisible(); await expect(note).toBeVisible();
  await expect(sessions).toHaveAttribute("data-widget-area", "right");
  await expect(sessions.getByRole("tab", { name: "Agent Context", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide widgets", exact: true }).click();
  await expect(note).toBeHidden(); await expect(terminal).toHaveAttribute("data-widget-area", "main");
  await page.getByRole("button", { name: "Show widgets", exact: true }).click();
  await expect(note).toHaveValue("native docking retained draft"); await expect(terminal).toHaveAttribute("data-widget-area", "bottom");
  await page.screenshot({ path: testInfo.outputPath("widget-main-sessions-right-grid-bottom.png") });
  const saved = await page.evaluate(() => [localStorage.getItem("wolfpack-widget-layout:v1"), localStorage.getItem("wolfpack-workspace-shell")]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#workspace-restore").click();
  await page.getByRole("tab", { name: "Agent Context", exact: true }).click();
  await page.locator("#workspace-context-back").click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(note).toHaveValue("native docking retained draft"); await expect(terminal).toBeVisible();
  expect(await page.evaluate(() => [localStorage.getItem("wolfpack-widget-layout:v1"), localStorage.getItem("wolfpack-workspace-shell")])).toEqual(saved);
  expect(await note.evaluate(node => node === (window as any).__dockingNote.node && node.parentElement === (window as any).__dockingNote.parent)).toBe(true);
  expect(await terminal.locator("canvas").evaluate(node => node === (window as any).__dockingCanvas)).toBe(true);
  expect(sockets).toBe(attached);
  await page.reload(); await openSession(page, SESSION_A);
  await expect(note).toHaveValue("native docking retained draft");
  await expect(terminal).toHaveAttribute("data-widget-area", "bottom");
  await expect(sessions).toHaveAttribute("data-widget-area", "right");
});

test("installed widget manager works without a terminal and persists local visibility without changing packages", async ({ page }, testInfo) => {
  await authorize(page);
  const before = runCli(["extensions", "list", "--json"]);
  const codeRequests: string[] = [];
  page.on("request", request => { if (/\/api\/extensions\/(assets|documents)\//.test(request.url())) codeRequests.push(request.url()); });
  await page.goto(`${server!.baseUrl}/#settings-extensions`);
  await expect(page.locator("#settings-view")).toBeVisible();
  await expect(page.locator("#settings-view")).not.toHaveClass(/swiping/);
  const manager = page.locator("#settings-extensions");
  await expect(manager.locator("[data-widget-extension]")).toHaveCount(4);
  expect(codeRequests).toEqual([]);
  const alpha = manager.getByRole("checkbox", { name: "Show widgets from alpha", exact: true });
  await expect(alpha).toBeChecked();
  await alpha.uncheck();
  await expect(alpha).toBeFocused();
  await expect(alpha).not.toBeChecked();
  if (testInfo.project.name !== "desktop") {
    const bounds = await page.locator("#settings-view").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await expect(manager.locator("[data-widget-status]")).toContainText("saved for this browser");
  await page.getByRole("link", { name: "Widgets", exact: true }).click();
  await expect(alpha).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("installed-widgets.png"), animations: "disabled" });
  await page.locator(testInfo.project.name === "desktop" ? "#settings-back-btn" : "#back-btn").click();
  await openSession(page, SESSION_A);
  await showWidgets(page);
  await expect(page.getByRole("tab", { name: "Beta", exact: true })).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /^Alpha/ })).toHaveCount(0);
  await expect(page.locator("#workspace-terminal-layout option[value='alpha/recipe']")).toHaveCount(1);
  await page.goto(`${server!.baseUrl}/#settings-extensions`);
  await page.reload(); // the same hash alone is a same-document navigation, not a persistence reload
  await expect(page.locator("#settings-view")).toBeVisible();
  await expect(alpha).not.toBeChecked();
  expect(runCli(["extensions", "list", "--json"])).toBe(before);
});

test("widget manager metadata handles failure retry safe mode disabled empty and hostile names", async ({ page }, testInfo) => {
  await authorize(page);
  const catalog = JSON.parse(runCli(["extensions", "list", "--json"]));
  const hostile = '<img src=x onerror="window.__managerHostile=1">';
  catalog.installations[0].package.name = hostile;
  catalog.installations[0].enabled = false;
  let mode = "failure";
  await page.route("**/api/extensions", async route => {
    await route.fulfill(mode === "failure" ? { status: 503, body: "unavailable" } : { json: mode === "empty" ? { safeMode: false, installations: [] } : { ...catalog, safeMode: mode === "safe" } });
  });
  await page.goto(`${server!.baseUrl}/#settings-extensions`);
  await expect(page.locator("#settings-view")).not.toHaveClass(/swiping/);
  const manager = page.locator("#settings-extensions");
  const status = manager.locator("[data-widget-status]");
  const refresh = manager.getByRole("button", { name: "Refresh installed extensions" });
  await expect(status).toContainText("unavailable");
  mode = "normal"; await refresh.click();
  await expect(manager.getByRole("heading", { name: hostile, exact: true })).toBeVisible();
  await expect(manager.locator("img")).toHaveCount(0);
  await expect(manager.getByRole("checkbox", { name: `Show widgets from ${catalog.installations[0].extensionId}`, exact: true })).toBeDisabled();
  mode = "safe"; await refresh.click();
  await expect(status).toContainText("Safe mode");
  await expect(manager.locator("[data-widget-list] input:enabled")).toHaveCount(0);
  mode = "empty"; await refresh.click();
  await expect(status).toContainText("No extensions installed");
  await expect(manager.locator("[data-widget-extension]")).toHaveCount(0);
  mode = "normal"; await refresh.click();
  const beta = manager.getByRole("checkbox", { name: "Show widgets from beta", exact: true });
  await expect(beta).toBeEnabled();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith("wolfpack-widget-visibility:")) throw Error("storage blocked"); original.call(this, key, value); };
  });
  await beta.click(); // rejected storage write restores the original checked state
  await expect(beta).toBeChecked();
  await expect(status).toContainText("Could not save");
  await page.screenshot({ path: testInfo.outputPath("widget-storage-error.png") });
});

test("hiding widgets from another settings tab pauses documents without replacing live terminals or views", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop retained-terminal and cross-tab visibility boundary");
  await authorize(page);
  let reads = 0; let sockets = 0;
  page.on("request", request => { if (request.url().includes("/documents/agent-context/context")) reads++; });
  page.on("websocket", socket => { if (socket.url().includes("/ws/pty")) sockets++; });
  await page.goto(server!.baseUrl); await openSession(page, SESSION_A); await selectAgentContext(page);
  const view = page.locator("[data-context-view='agent-context/context']");
  await expect(view.locator("h2")).toBeVisible();
  const canvas = page.locator("#desktop-terminal-container canvas");
  const oldView = await view.elementHandle(); const oldCanvas = await canvas.elementHandle();
  const attached = sockets;
  const placement = page.getByRole("region", { name: "Agent Context widget", exact: true }).getByRole("combobox", { name: "Widget panel placement" });
  for (const position of ["bottom", "full-screen", "right"]) {
    await placement.selectOption(position);
    await page.screenshot({ path: testInfo.outputPath(`installed-widget-${position}.png`), animations: "disabled" });
  }
  expect(await view.evaluate((node, previous) => node === previous, oldView)).toBe(true);
  expect(await canvas.evaluate((node, previous) => node === previous, oldCanvas)).toBe(true);
  expect(sockets).toBe(attached);
  const managerPage = await context.newPage();
  try {
    await authorize(managerPage);
    await managerPage.goto(`${server!.baseUrl}/#settings-extensions`);
    const checkbox = managerPage.getByRole("checkbox", { name: "Show widgets from agent-context", exact: true });
    await checkbox.uncheck();
    await expect(view).toBeHidden();
    await expect(page.getByRole("tab", { name: /Agent Context/ })).toHaveCount(0);
    const hiddenReads = reads; await page.waitForTimeout(2_300); expect(reads).toBe(hiddenReads);
    await checkbox.check(); await selectAgentContext(page);
    await expect.poll(() => reads).toBeGreaterThan(hiddenReads);
    expect(await view.evaluate((node, previous) => node === previous, oldView)).toBe(true);
    expect(await canvas.evaluate((node, previous) => node === previous, oldCanvas)).toBe(true);
    expect(sockets).toBe(attached);
    await expect(page.locator("#workspace-terminal-layout option[value='alpha/recipe']")).toHaveCount(1);
  } finally { await managerPage.close(); }
});

test("authenticated installed packages compose qualified local views and refresh published data without terminal replacement", async ({ page }, testInfo) => {
  test.skip(!["desktop", "mobile-webkit"].includes(testInfo.project.name), "desktop Chromium and WebKit extension boundary");
  await authorize(page);
  const resizeFrames: Array<{ cols?: number; rows?: number }> = [];
  const sockets: string[] = [];
  page.on("websocket", socket => {
    if (!socket.url().includes("/ws/pty")) return;
    sockets.push(socket.url());
    socket.on("framesent", event => {
      if (typeof event.payload !== "string") return;
      try { const frame = JSON.parse(event.payload); if (frame.type === "resize") resizeFrames.push(frame); } catch { /* PTY bytes */ }
    });
  });
  await page.goto(server!.baseUrl);
  await openSession(page, SESSION_A);
  await showWidgets(page);
  await expect(page.getByRole("tab", { name: "Alpha" })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("tab", { name: "Beta" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Agent Context/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Notes" })).toBeVisible();
  await page.getByRole("tab", { name: "Alpha" }).click();
  await expect(page.locator("[data-context-view='alpha/shared']")).toHaveText("Alpha mounted");
  await page.getByRole("tab", { name: "Beta" }).click();
  await expect(page.locator("[data-context-view='beta/shared']")).toHaveText("Beta mounted");

  await selectAgentContext(page);
  const heading = page.locator("[data-context-view='agent-context/context'] h2");
  await expect(heading).toContainText(HOSTILE_GOAL);
  await expect(page.locator("[data-context-view='agent-context/context'] img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __extensionHostile?: number }).__extensionHostile ?? 0)).toBe(0);
  publishContext(SESSION_A, "revision two", 1);
  await expect(heading).toContainText("revision two", { timeout: 5_000 });

  await page.getByRole("tab", { name: "Notes" }).click();
  const note = page.locator("[data-context-view='notes/notes'] textarea");
  await note.fill("retained note draft");
  await note.evaluate((editor: HTMLTextAreaElement) => editor.setSelectionRange(3, 11));
  await selectAgentContext(page);
  await page.getByRole("tab", { name: "Notes" }).click();
  await expect(note).toHaveValue("retained note draft");
  expect(await note.evaluate((editor: HTMLTextAreaElement) => [editor.selectionStart, editor.selectionEnd])).toEqual([3, 11]);

  if (testInfo.project.name === "desktop") {
    await page.locator(`[data-action="toggle-grid"][data-session="${SESSION_B}"]`).filter({ visible: true }).click();
    await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(2, { timeout: 10_000 });
    const selected = page.locator(`#desktop-grid-container .grid-cell[data-session="${SESSION_A}"]`);
    await selected.click();
    await selectAgentContext(page);
    await expect(page.locator("[data-context-view='agent-context/context'] h2")).toContainText("revision two", { timeout: 5_000 });
    const readTail = () => selected.evaluate(cell => (window as unknown as { __wolfpackTest: { serializeTerminalTail(node: Element, lines: number): string } }).__wolfpackTest.serializeTerminalTail(cell, 200));
    await selected.click();
    await page.keyboard.type("printf 'WP%s\\n' EXTENSION_RETENTION");
    await page.keyboard.press("Enter");
    await expect.poll(readTail).toContain("WPEXTENSION_RETENTION");
    const resizeCount = resizeFrames.length;
    await selectTerminalLayoutFromUi(page, "lead-stack");
    await expect(page.locator('#desktop-grid-container .grid-cell.hydrated')).toHaveCount(2);
    await expect.poll(readTail).toContain("WPEXTENSION_RETENTION");
    // Settings suspends/reopens viewers; workspace-only toggles must then retain them.
    await selected.locator("canvas").evaluate(canvas => { (window as unknown as { __extensionRetainedCanvas?: Element }).__extensionRetainedCanvas = canvas; });
    const attached = sockets.length;
    await expect.poll(() => resizeFrames.length).toBeGreaterThan(resizeCount);
    expect(resizeFrames.slice(resizeCount).every(frame => (frame.cols ?? 0) > 0 && (frame.rows ?? 0) > 0)).toBe(true);
    await page.locator("[data-widget-full]:visible").click();
    await expect(page.locator("#workspace-terminal-region")).toBeHidden();
    await page.getByRole("button", { name: "Restore workspace", exact: true }).click();
    expect(await selected.locator("canvas").evaluate(canvas => canvas === (window as unknown as { __extensionRetainedCanvas?: Element }).__extensionRetainedCanvas)).toBe(true);
    await expect.poll(readTail).toContain("WPEXTENSION_RETENTION");
    expect(sockets).toHaveLength(attached);
  } else {
    await page.getByRole("button", { name: "Back to terminal", exact: true }).click();
    const draft = page.locator("#msg-input");
    await draft.evaluate((editor: HTMLTextAreaElement) => {
      editor.value = "retained mobile terminal draft";
      editor.setSelectionRange(9, 15);
    });
    const canvas = page.locator("#desktop-terminal-container canvas");
    await canvas.evaluate(node => { (window as unknown as { __extensionRetainedCanvas?: Element }).__extensionRetainedCanvas = node; });
    const attached = sockets.length;
    await showWidgets(page);
    await expect(page.locator("#workspace-terminal-region")).toBeHidden();
    await page.getByRole("button", { name: "Back to terminal", exact: true }).click();
    expect(await canvas.evaluate(node => node === (window as unknown as { __extensionRetainedCanvas?: Element }).__extensionRetainedCanvas)).toBe(true);
    await expect(draft).toHaveValue("retained mobile terminal draft");
    expect(await draft.evaluate((editor: HTMLTextAreaElement) => [editor.selectionStart, editor.selectionEnd])).toEqual([9, 15]);
    expect(sockets).toHaveLength(attached);
  }
});

test("a sole Agent Context opens directly without its redundant tab and multiple views retain their tabs", async ({ page }, testInfo) => {
  test.skip(!["desktop", "iphone-14"].includes(testInfo.project.name), "desktop and responsive touch single-view contract");
  const catalog = JSON.parse(runCli(["extensions", "list", "--json"]));
  const others = catalog.installations.filter((item: { extensionId: string; enabled: boolean }) => item.extensionId !== "agent-context" && item.enabled).map((item: { extensionId: string }) => item.extensionId);
  try {
    for (const id of others) runCli(["extensions", "disable", id]);
    await authorize(page);
    await page.addInitScript(() => {
      localStorage.setItem("wolfpack-workspace-shell", JSON.stringify({ contextCollapsed: true }));
      localStorage.setItem("wolfpack-terminal-layout", "agent-context/lead-stack");
    });
    await page.goto(server!.baseUrl);
    await openSession(page, SESSION_A);
    const view = page.locator("[data-context-view='agent-context/context']");
    await expect(page.locator("[data-extension-tabs] [role='tab']")).toHaveCount(1);
    await expect(view).toHaveCount(0); // collapsed shell never auto-mounts a view
    await page.getByRole("button", { name: testInfo.project.name === "desktop" ? "Show widgets" : "Expand context panel", exact: true }).click();
    const current = JSON.parse(runCli(["extension-data", "read", "agent-context/context", "--session", sessionIds.get(SESSION_A)!, "--json"], server!.port));
    await expect(view.locator("h2")).toHaveText(current.document.goal, { timeout: 5_000 });
    const layouts = page.locator("#workspace-terminal-layout");
    await expect(layouts.locator("option", { hasText: /^Lead \+ stack$/ })).toHaveCount(1);
    await expect(layouts.locator('option[value="agent-context/lead-stack"]')).toHaveCount(0);
    await expect(layouts).toHaveValue("equal-grid"); // existing missing-recipe fallback, not a legacy alias
    await selectTerminalLayoutFromUi(page, "lead-stack");
    await showWidgets(page);
    await expect(page.locator("[data-extension-tabs]")).toBeHidden();
    await expect(page.getByRole("tab", { name: "Agent Context", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("single-context-no-tab.png") });
    runCli(["extensions", "enable", "notes"]);
    await refreshThroughSessionSwitch(page, testInfo);
    await expect(page.getByRole("tab", { name: "Agent Context", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Notes", exact: true }).click();
    runCli(["extensions", "disable", "notes"]);
    await refreshThroughSessionSwitch(page, testInfo);
    await expect(view.locator("h2")).toHaveText(current.document.goal, { timeout: 5_000 });
    await expect(layouts).toHaveValue("lead-stack");
    await expect(page.locator("[data-extension-tabs]")).toBeHidden();
  } finally {
    for (const id of others) runCli(["extensions", "enable", id]);
  }
});

test("installed package disable re-enable remove reinstall and update preserve an unrelated package", async ({ page }, testInfo) => {
  test.skip(!["desktop", "mobile-webkit"].includes(testInfo.project.name), "desktop Chromium and WebKit package lifecycle");
  await authorize(page);
  await page.goto(server!.baseUrl);
  await openSession(page, SESSION_A);
  await showWidgets(page);
  await expect(page.getByRole("tab", { name: "Alpha" })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("tab", { name: "Beta" })).toBeVisible();

  runCli(["extensions", "disable", "alpha"]);
  await refreshThroughSessionSwitch(page, testInfo);
  await expect(page.getByRole("tab", { name: "Alpha" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Beta" })).toBeVisible();

  runCli(["extensions", "enable", "alpha"]);
  await refreshThroughSessionSwitch(page, testInfo);
  await expect(page.getByRole("tab", { name: "Alpha" })).toBeVisible();

  writeGenericPackage("alpha", "Alpha Updated", "1.1.0", true);
  runCli(["extensions", "update", alphaSource, "--trust-browser-code"]);
  await refreshThroughSessionSwitch(page, testInfo);
  await expect(page.getByRole("tab", { name: "Alpha Updated" })).toBeVisible();
  await page.getByRole("tab", { name: "Alpha Updated" }).click();
  await expect(page.locator("[data-context-view='alpha/shared']")).toHaveText("Alpha Updated mounted");

  runCli(["extensions", "remove", "alpha"]);
  await refreshThroughSessionSwitch(page, testInfo);
  await expect(page.getByRole("tab", { name: "Alpha Updated" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Beta" })).toBeVisible();

  runCli(["extensions", "install", alphaSource, "--trust-browser-code"]);
  // Reinstallation preserves the explicit disabled state left by removal; the
  // ordinary enable operation is required before browser code may run again.
  runCli(["extensions", "enable", "alpha"]);
  await refreshThroughSessionSwitch(page, testInfo);
  await expect(page.getByRole("tab", { name: "Alpha Updated" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Beta" })).toBeVisible();
});

test("real CLI invalid scope schema and CAS rejection keep the good browser document intact", async ({ page }, testInfo) => {
  test.skip(!["desktop", "mobile-webkit"].includes(testInfo.project.name), "desktop Chromium and WebKit document rejection");
  await authorize(page);
  await page.goto(server!.baseUrl);
  await openSession(page, SESSION_A);
  await selectAgentContext(page);
  const heading = page.locator("[data-context-view='agent-context/context'] h2");
  const read = JSON.parse(runCli(["extension-data", "read", "agent-context/context", "--session", sessionIds.get(SESSION_A)!, "--json"], server!.port)) as { revision: number; document: { goal: string } };
  await expect(heading).toContainText(read.document.goal, { timeout: 5_000 });
  const invalidSchema = writeContext("invalid-schema.json", "must not render", 999);
  const invalidSchemaResult = runCliAttempt(["extension-data", "publish", "agent-context/context", "--session", sessionIds.get(SESSION_A)!, "--file", invalidSchema, "--if-revision", String(read.revision), "--request-id", randomUUID(), "--json"], server!.port);
  const staleCasResult = runCliAttempt(["extension-data", "publish", "agent-context/context", "--session", sessionIds.get(SESSION_A)!, "--file", writeContext("stale-cas.json", "must not render"), "--if-revision", "0", "--request-id", randomUUID(), "--json"], server!.port);
  const invalidScopeResult = runCliAttempt(["extension-data", "publish", "agent-context/context", "--session", "session-name", "--file", writeContext("invalid-scope.json", "must not render"), "--if-revision", String(read.revision), "--request-id", randomUUID(), "--json"], server!.port);
  expect(invalidSchemaResult.status).not.toBe(0);
  expect(staleCasResult.status).not.toBe(0);
  expect(invalidScopeResult.status).not.toBe(0);
  await page.waitForTimeout(2_300);
  await expect(heading).toContainText(read.document.goal);
  await expect(heading).not.toContainText("must not render");
});

test("extension safe mode allows manager metadata but never code or documents until disabled", async ({ page }, testInfo) => {
  test.skip(!["desktop", "mobile-webkit"].includes(testInfo.project.name), "desktop Chromium and WebKit safe-mode recovery");
  await authorize(page, true);
  const extensionRequests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/extensions")) extensionRequests.push(request.url()); });
  await page.goto(server!.baseUrl);
  await openSession(page, SESSION_A);
  await expect(page.locator("[data-extension-status]")).toContainText("Safe mode prevents extension loading");
  expect(extensionRequests).toEqual([]);

  if (testInfo.project.name === "mobile-webkit") {
    await page.locator("#back-btn").click();
    await expect(page.locator("#sessions-view")).toBeVisible();
  }
  await page.locator("#sidebar-settings-btn, #expanded-settings-btn, #gear-btn").filter({ visible: true }).first().click();
  const safeMode = page.locator("#setting-extensionSafeMode");
  await expect(safeMode).toBeChecked();
  await expect(page.locator("[data-widget-extension]")).toHaveCount(4);
  expect(extensionRequests.every(url => new URL(url).pathname === "/api/extensions")).toBe(true);
  await safeMode.uncheck();
  expect(extensionRequests.every(url => new URL(url).pathname === "/api/extensions")).toBe(true);
  await page.locator(testInfo.project.name === "desktop" ? "#settings-back-btn" : "#back-btn").click();
  if (testInfo.project.name === "mobile-webkit") await openSession(page, SESSION_A);
  await showWidgets(page);
  await expect(page.getByRole("tab", { name: /Agent Context/ })).toBeVisible({ timeout: 5_000 });
  expect(extensionRequests.some(url => new URL(url).pathname === "/api/extensions")).toBe(true);
});

test("installed extension recipe and terminal instances survive exact grid-scope focus changes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop installed recipe scope transition");
  await authorize(page);
  const sockets: string[] = [];
  page.on("websocket", socket => { if (socket.url().includes("/ws/pty")) sockets.push(socket.url()); });
  await page.goto(server!.baseUrl);
  await openSession(page, SESSION_A);
  await expect(page.locator("#workspace-terminal-layout option[value='alpha/recipe']")).toHaveCount(1, { timeout: 5_000 });
  await selectTerminalLayoutFromUi(page, "alpha/recipe");
  await page.locator(`[data-action="toggle-grid"][data-session="${SESSION_B}"]`).filter({ visible: true }).click();
  await expect(page.locator("#desktop-grid-container .grid-cell.hydrated")).toHaveCount(2, { timeout: 10_000 });
  const first = page.locator(`#desktop-grid-container .grid-cell[data-session="${SESSION_A}"]`);
  const second = page.locator(`#desktop-grid-container .grid-cell[data-session="${SESSION_B}"]`);
  await first.locator("canvas").evaluate(node => { (window as unknown as { __extensionRecipeFirst?: Element }).__extensionRecipeFirst = node; });
  await second.locator("canvas").evaluate(node => { (window as unknown as { __extensionRecipeSecond?: Element }).__extensionRecipeSecond = node; });
  const attached = sockets.length;
  await second.click();
  await expect(page.locator("#workspace-terminal-layout")).toHaveValue("alpha/recipe");
  expect(await first.locator("canvas").evaluate(node => node === (window as unknown as { __extensionRecipeFirst?: Element }).__extensionRecipeFirst)).toBe(true);
  expect(await second.locator("canvas").evaluate(node => node === (window as unknown as { __extensionRecipeSecond?: Element }).__extensionRecipeSecond)).toBe(true);
  expect(sockets).toHaveLength(attached);

  await page.reload();
  await openSession(page, SESSION_A);
  await expect(page.locator("#workspace-terminal-layout option[value='alpha/recipe']")).toHaveCount(1, { timeout: 5_000 });
  await expect(page.locator("#workspace-terminal-layout")).toHaveValue("alpha/recipe");
});

test("ordinary context-hide controls pause polling and preserve retained workspace state", async ({ page }, testInfo) => {
  test.skip(!["desktop", "mobile-webkit"].includes(testInfo.project.name), "Chromium and WebKit shell visibility boundary");
  await authorize(page);
  let reads = 0;
  const sockets: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/extensions/documents/agent-context/context") reads++; });
  page.on("websocket", socket => { if (socket.url().includes("/ws/pty")) sockets.push(socket.url()); });
  await page.goto(server!.baseUrl);
  await openSession(page, SESSION_A);
  await selectAgentContext(page);
  const contextView = page.locator("[data-context-view='agent-context/context']");
  const current = JSON.parse(runCli(["extension-data", "read", "agent-context/context", "--session", sessionIds.get(SESSION_A)!, "--json"], server!.port)) as { document: { goal: string } };
  await expect(contextView.locator("h2")).toContainText(current.document.goal);
  await contextView.evaluate(node => { (window as unknown as { __extensionRetainedContext?: Element }).__extensionRetainedContext = node; });
  const canvas = page.locator("#desktop-terminal-container canvas");
  await canvas.evaluate(node => { (window as unknown as { __extensionRetainedShellCanvas?: Element }).__extensionRetainedShellCanvas = node; });
  const selectedLayout = await page.locator("#workspace-terminal-layout").inputValue();
  const attached = sockets.length;

  const button = page.locator(testInfo.project.name === "desktop" ? "#workspace-context-collapse" : "#workspace-context-back");
  if (testInfo.project.name === "mobile-webkit") await button.tap();
  else await button.click();
  await expect(page.locator("#workspace-context-region")).toBeHidden();
  const atHide = reads;
  await page.waitForTimeout(2_300);
  expect(reads, "collapse must pause selected context polling").toBe(atHide);
  await page.locator("#workspace-restore").click();
  await expect.poll(() => reads).toBeGreaterThan(atHide);
  expect(await contextView.evaluate(node => node === (window as unknown as { __extensionRetainedContext?: Element }).__extensionRetainedContext)).toBe(true);
  expect(await canvas.evaluate(node => node === (window as unknown as { __extensionRetainedShellCanvas?: Element }).__extensionRetainedShellCanvas)).toBe(true);
  await expect(page.locator("#workspace-terminal-layout")).toHaveValue(selectedLayout);
  expect(sockets).toHaveLength(attached);
  if (testInfo.project.name === "mobile-webkit") {
    await expect(page.locator("#terminal-transcript-btn")).toHaveCount(0);
  }
});

test("delegation grid and focused terminal scope follow the exact selected broker UUID", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop delegation scope transition");
  await authorize(page);
  const documentSessions: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.includes("/api/extensions/documents/")) documentSessions.push(url.searchParams.get("session") ?? "");
  });
  await page.goto(server!.baseUrl);
  await page.locator(".delegation-parent-card", { hasText: DELEGATION_PARENT }).first().click();
  const childCell = page.locator(`#delegation-grid-container .grid-cell[data-session="${DELEGATION_CHILD}"]`);
  await expect(childCell).toHaveClass(/hydrated/, { timeout: 10_000 });
  await selectAgentContext(page);
  await expect(page.locator("[data-context-view='agent-context/context'] h2")).toContainText("delegation parent", { timeout: 5_000 });
  await childCell.click();
  await selectAgentContext(page);
  await expect(page.locator("[data-context-view='agent-context/context'] h2")).toContainText("delegation child", { timeout: 5_000 });
  await childCell.getByRole("button", { name: `Focus ${DELEGATION_CHILD}` }).click();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 10_000 });
  await selectAgentContext(page);
  await expect(page.locator("[data-context-view='agent-context/context'] h2")).toContainText("delegation child", { timeout: 5_000 });
  expect(documentSessions).toContain(sessionIds.get(DELEGATION_PARENT)!);
  expect(documentSessions).toContain(sessionIds.get(DELEGATION_CHILD)!);
  expect(documentSessions.every(id => id === sessionIds.get(DELEGATION_PARENT) || id === sessionIds.get(DELEGATION_CHILD))).toBe(true);
});
