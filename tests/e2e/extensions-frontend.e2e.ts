import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { start, skipIfNoBroker, type BrokerTestServer } from "./broker-helpers.ts";
import { createOwnedTestServerHome, removeOwnedTestServerHome, type OwnedTestServerHome } from "./test-server-home.ts";

test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);

const ROOT = join(import.meta.dirname, "..", "..");
const SECRET = "extensions-frontend-browser-auth-secret-123";
const PROJECT = "extensions-browser";
let root: string;
let home: OwnedTestServerHome | undefined;
let server: BrokerTestServer | undefined;
let cli: string;
let sessionId = "";

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
function runCli(args: readonly string[], port?: number): string {
  const result = spawnSync(cli, args, { cwd: root, env: environment(port), stdio: ["ignore", "pipe", "pipe"] });
  expect(result.status, `${args.join(" ")}: ${result.stderr.toString()}`).toBe(0);
  return result.stdout.toString();
}
function token(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
  return `${header}.${payload}.${createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url")}`;
}
function writeGenericPackage(id: string, title: string): string {
  const source = join(root, id); mkdirSync(join(source, "dist"), { recursive: true, mode: 0o700 });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: `wolfpack-${id}`, version: "1.0.0", wolfpack: { manifestVersion: 1, apiVersion: 1, id, ui: "dist/ui.js", skills: [], documents: [] } }));
  writeFileSync(join(source, "dist", "ui.js"), `export default host => host.registerContextView({ id: "shared", title: ${JSON.stringify(title)}, mount(container) { container.textContent = ${JSON.stringify(`${title} mounted`)}; return { dispose() {} }; } });\n`);
  return source;
}

// This is the production boundary: a compiled public CLI snapshots four ordinary
// packages before the real broker-backed server starts. Browser code only sees
// the authenticated catalog/asset route, never these source directories.
test.beforeAll(async () => {
  root = resolve(mkdtempSync(join(tmpdir(), "wp-extensions-browser-")));
  home = createOwnedTestServerHome();
  mkdirSync(join(root, "dev", PROJECT), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "bin"), { recursive: true, mode: 0o700 });
  cli = join(root, "bin", "wolfpack");
  const build = spawnSync("bun", ["build", "--compile", join(ROOT, "src", "cli", "index.ts"), "--outfile", cli], { cwd: ROOT, env: environment(), stdio: ["ignore", "pipe", "pipe"] });
  expect(build.status, build.stderr.toString()).toBe(0);
  const alpha = writeGenericPackage("alpha", "Alpha");
  const beta = writeGenericPackage("beta", "Beta");
  runCli(["extensions", "install", alpha, "--trust-browser-code"]);
  runCli(["extensions", "install", beta, "--trust-browser-code"]);
  runCli(["extensions", "install", join(ROOT, "examples", "extensions", "agent-context"), "--trust-browser-code", "--skills", "pi"]);
  runCli(["extensions", "install", join(ROOT, "examples", "extensions", "notes"), "--trust-browser-code"]);
  expect(existsSync(join(home.path, ".pi", "agent", "skills", "wolfpack-agent-context", "SKILL.md"))).toBe(true);
  server = await start({ envOverrides: environment() });
  writeFileSync(join(home.path, ".wolfpack", "config.json"), JSON.stringify({ devDir: join(root, "dev"), port: server.port }), { mode: 0o600 });
  const created = await fetch(`${server.baseUrl}/api/create`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token()}` }, body: JSON.stringify({ projectDir: join(root, "dev", PROJECT), cmd: "shell", sessionName: "extension-browser-scope" }) });
  expect(created.ok, await created.text()).toBe(true);
  await expect.poll(async () => {
    const response = await fetch(`${server!.baseUrl}/api/sessions`, { headers: { authorization: `Bearer ${token()}` } });
    const sessions = await response.json() as { sessions?: Array<{ name?: string; identity?: { wolfpackSessionId?: string } }> }; 
    return sessions.sessions?.find(item => item.name === "extension-browser-scope")?.identity?.wolfpackSessionId ?? "";
  }).not.toBe("");
  const sessions = await (await fetch(`${server.baseUrl}/api/sessions`, { headers: { authorization: `Bearer ${token()}` } })).json() as { sessions: Array<{ name?: string; identity?: { wolfpackSessionId?: string } }> };
  sessionId = sessions.sessions.find(item => item.name === "extension-browser-scope")!.identity!.wolfpackSessionId!;
  const document = join(root, "context.json");
  writeFileSync(document, JSON.stringify({ schemaVersion: 1, goal: "revision one", planItems: [], decisions: [], blockers: [], nextSteps: [] }));
  runCli(["extension-data", "publish", "agent-context/context", "--session", sessionId, "--file", document, "--if-revision", "0", "--request-id", randomUUID(), "--json"], server.port);
});

test.afterAll(async () => {
  await server?.teardown();
  if (home) removeOwnedTestServerHome(home);
  if (root) rmSync(root, { recursive: true, force: true });
});

test("authenticated installed packages compose qualified local views and refresh published data without terminal replacement", async ({ page }, testInfo) => {
  test.skip(!["desktop", "mobile-webkit"].includes(testInfo.project.name), "desktop Chromium and WebKit extension boundary");
  await page.addInitScript((value) => {
    sessionStorage.setItem("wpAuthTokens:v1", JSON.stringify({ [location.origin]: value }));
    localStorage.setItem("wpJwt", value);
  }, token());
  await page.goto(server!.baseUrl);
  await page.locator(".card", { hasText: "extension-browser-scope" }).first().click();
  await expect(page.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 10_000 });
  const canvas = await page.locator("#desktop-terminal-container canvas").evaluate(node => { (window as any).__extensionCanvas = node; return true; });
  expect(canvas).toBe(true);
  await expect(page.getByRole("tab", { name: "Alpha" })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("tab", { name: "Beta" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Agent Context/ })).toBeVisible();
  await page.getByRole("tab", { name: "Alpha" }).click();
  await expect(page.locator("[data-context-view='alpha/shared']")).toHaveText("Alpha mounted");
  await page.getByRole("tab", { name: "Beta" }).click();
  await expect(page.locator("[data-context-view='beta/shared']")).toHaveText("Beta mounted");
  await page.getByRole("tab", { name: /Agent Context/ }).click();
  await expect(page.locator("[data-context-view='agent-context/context'] h2")).toContainText("revision one");
  const document = join(root, "context-two.json");
  writeFileSync(document, JSON.stringify({ schemaVersion: 1, goal: "revision two", planItems: [], decisions: [], blockers: [], nextSteps: [] }));
  runCli(["extension-data", "publish", "agent-context/context", "--session", sessionId, "--file", document, "--if-revision", "1", "--request-id", randomUUID(), "--json"], server!.port);
  await expect(page.locator("[data-context-view='agent-context/context'] h2")).toContainText("revision two", { timeout: 5_000 });
  expect(await page.locator("#desktop-terminal-container canvas").evaluate(node => node === (window as any).__extensionCanvas)).toBe(true);
});
