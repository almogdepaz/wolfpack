import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    PATH: process.env.PATH ?? "", SHELL: process.env.SHELL ?? "/bin/sh", HOME: home!.path, TMPDIR: root,
    WOLFPACK_TEST: "1", WOLFPACK_LOG_LEVEL: "error", WOLFPACK_DEV_DIR: join(root, "dev"),
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

async function switchSession(page: Page, name: string, testInfo: TestInfo): Promise<void> {
  if (testInfo.project.name === "desktop") {
    await page.locator(`[data-action="open-session"][data-session="${name}"]`).filter({ visible: true }).first().click();
  } else {
    await page.locator("#session-chip").click();
    await page.locator(`.drawer-item[data-val="${name}"]`).click();
  }
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 10_000 });
}

async function refreshThroughSessionSwitch(page: Page, testInfo: TestInfo): Promise<void> {
  await switchSession(page, SESSION_B, testInfo);
  await switchSession(page, SESSION_A, testInfo);
}

async function selectAgentContext(page: Page): Promise<void> {
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
    await selected.locator("canvas").evaluate(canvas => { (window as unknown as { __extensionRetainedCanvas?: Element }).__extensionRetainedCanvas = canvas; });
    const attached = sockets.length;
    const resizeCount = resizeFrames.length;
    await page.locator("#workspace-terminal-layout").selectOption("lead-stack");
    await expect.poll(() => resizeFrames.length).toBeGreaterThan(resizeCount);
    expect(resizeFrames.slice(resizeCount).every(frame => (frame.cols ?? 0) > 0 && (frame.rows ?? 0) > 0)).toBe(true);
    await page.locator("#workspace-context-full").click();
    await expect(page.locator("#workspace-terminal-region")).toBeHidden();
    await page.locator("#workspace-restore").click();
    expect(await selected.locator("canvas").evaluate(canvas => canvas === (window as unknown as { __extensionRetainedCanvas?: Element }).__extensionRetainedCanvas)).toBe(true);
    await expect.poll(readTail).toContain("WPEXTENSION_RETENTION");
    expect(sockets).toHaveLength(attached);
  } else {
    const draft = page.locator("#msg-input");
    await draft.evaluate((editor: HTMLTextAreaElement) => {
      editor.value = "retained mobile terminal draft";
      editor.setSelectionRange(9, 15);
    });
    const canvas = page.locator("#desktop-terminal-container canvas");
    await canvas.evaluate(node => { (window as unknown as { __extensionRetainedCanvas?: Element }).__extensionRetainedCanvas = node; });
    const attached = sockets.length;
    await page.locator("#workspace-context-full").click();
    await expect(page.locator("#workspace-terminal-region")).toBeHidden();
    await page.locator("#workspace-restore").click();
    expect(await canvas.evaluate(node => node === (window as unknown as { __extensionRetainedCanvas?: Element }).__extensionRetainedCanvas)).toBe(true);
    await expect(draft).toHaveValue("retained mobile terminal draft");
    expect(await draft.evaluate((editor: HTMLTextAreaElement) => [editor.selectionStart, editor.selectionEnd])).toEqual([9, 15]);
    expect(sockets).toHaveLength(attached);
  }
});

test("installed package disable re-enable remove reinstall and update preserve an unrelated package", async ({ page }, testInfo) => {
  test.skip(!["desktop", "mobile-webkit"].includes(testInfo.project.name), "desktop Chromium and WebKit package lifecycle");
  await authorize(page);
  await page.goto(server!.baseUrl);
  await openSession(page, SESSION_A);
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

test("extension safe mode uses the real settings control and makes no extension requests until disabled", async ({ page }, testInfo) => {
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
  await safeMode.uncheck();
  expect(extensionRequests).toEqual([]);
  await page.locator(testInfo.project.name === "desktop" ? "#settings-back-btn" : "#back-btn").click();
  if (testInfo.project.name === "mobile-webkit") await openSession(page, SESSION_A);
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
  await page.locator("#workspace-terminal-layout").selectOption("alpha/recipe");
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

  for (const control of ["#workspace-context-collapse", "#workspace-terminal-full"]) {
    const button = page.locator(control);
    if (testInfo.project.name === "mobile-webkit") {
      await button.focus();
      await page.keyboard.press("Enter");
    } else {
      await button.click();
    }
    await expect(page.locator("#workspace-context-region")).toBeHidden();
    const atHide = reads;
    await page.waitForTimeout(2_300);
    expect(reads, `${control} must pause selected context polling`).toBe(atHide);
    await page.locator("#workspace-restore").click();
    await expect.poll(() => reads).toBeGreaterThan(atHide);
    expect(await contextView.evaluate(node => node === (window as unknown as { __extensionRetainedContext?: Element }).__extensionRetainedContext)).toBe(true);
    expect(await canvas.evaluate(node => node === (window as unknown as { __extensionRetainedShellCanvas?: Element }).__extensionRetainedShellCanvas)).toBe(true);
    await expect(page.locator("#workspace-terminal-layout")).toHaveValue(selectedLayout);
    expect(sockets).toHaveLength(attached);
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
