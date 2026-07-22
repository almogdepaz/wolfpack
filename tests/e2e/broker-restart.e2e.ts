/**
 * Broker restart e2e — proves Wolfpack process restart leaves the broker
 * session alive and the next browser attach receives a prefill containing
 * the pre-restart transcript.
 *
 * Spawns a wolfpack-broker, then two sequential wolfpack server processes
 * against the same broker socket. A real browser context attaches to each
 * server; the assertion is that the second attach's prefill includes the
 * marker bytes typed before the first server was killed.
 */
import { test, expect, type WebSocketRoute } from "@playwright/test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dirname, "..", "..");

function resolveBrokerBin(): string | null {
  const fromEnv = process.env.WOLFPACK_BROKER_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const c of [
    join(ROOT, "broker", "target", "debug", "wolfpack-broker"),
    join(ROOT, "broker", "target", "release", "wolfpack-broker"),
  ]) {
    if (existsSync(c)) return c;
  }
  return null;
}

const BROKER_BIN = resolveBrokerBin();
const skip = {
  condition: !BROKER_BIN,
  reason: "wolfpack-broker binary not found — run cargo build first",
} as const;

const PROJECT_NAME = "wp-restart";
const SESSION_NAME = "restart-shell";
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P^_X][^\x1b]*(?:\x1b\\|$)/g, "")
    .replace(/\x1b./gs, "")
    .replace(/\r/g, "");
}

function frameToText(data: string | Buffer | Uint8Array): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("binary");
  return Buffer.from(data as Uint8Array).toString("binary");
}

async function waitForFile(p: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(p)) return;
    await wait(50);
  }
  throw new Error(`timeout waiting for ${p} to appear`);
}

async function spawnWolfpack(opts: { socketPath: string; devDir: string }): Promise<{ proc: ChildProcess; port: number }> {
  const proc = spawn(
    "bun",
    [join(ROOT, "tests", "e2e", "test-server-broker.ts")],
    {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        WOLFPACK_TEST: "1",
        WOLFPACK_BROKER_SOCKET: opts.socketPath,
        WOLFPACK_DEV_DIR: opts.devDir,
      },
    },
  );

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill(); reject(new Error("wolfpack did not start in 15s")); }, 15_000);
    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const m = stdout.match(/READY:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("exit", (code) => {
      if (!stdout.includes("READY:")) {
        clearTimeout(timer);
        reject(new Error(`wolfpack exited (code ${code}) before READY`));
      }
    });
  });

  return { proc, port };
}

async function killProc(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((r) => proc.once("exit", () => r())),
    wait(3000),
  ]);
  if (proc.exitCode === null) {
    try { proc.kill("SIGKILL"); } catch { /* swallow */ }
  }
}

let brokerProc: ChildProcess | null = null;
let socketPath: string | null = null;
let socketDir: string | null = null;
let devDir: string | null = null;

test.beforeAll(async () => {
  if (skip.condition) return;
  socketDir = mkdtempSync("/tmp/wp-broker-");
  socketPath = join(socketDir, "b.sock");
  devDir = realpathSync(mkdtempSync(join(tmpdir(), "wp-restart-")));
  mkdirSync(join(devDir, PROJECT_NAME));

  brokerProc = spawn(BROKER_BIN!, [], {
    env: {
      ...process.env,
      WOLFPACK_BROKER_SOCKET: socketPath,
      WOLFPACK_BROKER_LOG: process.env.WOLFPACK_BROKER_LOG ?? "warn",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await waitForFile(socketPath, 5000);
});

test.afterAll(async () => {
  if (brokerProc && brokerProc.exitCode === null) {
    try { brokerProc.kill("SIGTERM"); } catch { /* swallow */ }
    await wait(200);
    if (brokerProc.exitCode === null) {
      try { brokerProc.kill("SIGKILL"); } catch { /* swallow */ }
    }
  }
  brokerProc = null;
  if (socketDir) {
    try { rmSync(socketDir, { recursive: true, force: true }); } catch { /* swallow */ }
    socketDir = null;
    socketPath = null;
  }
  if (devDir) {
    try { rmSync(devDir, { recursive: true, force: true }); } catch { /* swallow */ }
    devDir = null;
  }
});

test("wolfpack restart: broker session survives and prefill restores marker", async ({ browser }, testInfo) => {
  test.skip(skip.condition, skip.reason);
  test.skip(testInfo.project.name === "desktop", "broker test runs once on mobile project only");

  const marker = `WP_RESTART_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

  // ── Spawn first wolfpack ──
  const wp1 = await spawnWolfpack({ socketPath: socketPath!, devDir: devDir! });
  const baseUrl1 = `http://127.0.0.1:${wp1.port}`;

  // ── Create session via API ──
  const createResp = await fetch(`${baseUrl1}/api/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: PROJECT_NAME, cmd: "shell", sessionName: SESSION_NAME }),
  });
  expect(createResp.ok, "POST /api/create").toBeTruthy();

  // ── Browser attach #1: type the marker ──
  const ctx1 = await browser.newContext();
  const page1 = await ctx1.newPage();
  let conn1Output = "";
  await page1.routeWebSocket(/\/ws\/pty/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => server.send(msg));
    server.onMessage((data) => {
      if (typeof data !== "string") conn1Output += frameToText(data);
      ws.send(data);
    });
    ws.onClose((code, reason) => server.close({ code, reason }));
    server.onClose((code, reason) => ws.close({ code, reason }));
  });
  await page1.goto(baseUrl1);
  await page1.waitForSelector(".card", { timeout: 5000 });
  await page1.locator(".card", { hasText: SESSION_NAME }).first().click();
  const canvas1 = page1.locator("#desktop-terminal-container canvas");
  await expect(canvas1).toBeVisible({ timeout: 5000 });

  // Wait for shell prompt to settle.
  let lastLen = 0;
  let idleCount = 0;
  const idleDeadline = Date.now() + 8000;
  while (Date.now() < idleDeadline) {
    await wait(200);
    if (conn1Output.length === lastLen) {
      if (++idleCount >= 3) break;
    } else { idleCount = 0; lastLen = conn1Output.length; }
  }

  await page1.locator("#kb-open-btn").click();
  await page1.locator("#desktop-terminal-container textarea").focus();
  await page1.keyboard.type(`echo ${marker}`);
  await page1.keyboard.press("Enter");

  // Wait for marker to land in WS output.
  const seenDeadline = Date.now() + 10_000;
  while (Date.now() < seenDeadline) {
    if (stripAnsi(conn1Output).includes(marker)) break;
    await wait(150);
  }
  expect(stripAnsi(conn1Output), "marker visible before restart").toContain(marker);

  // ── Kill wolfpack #1 (broker keeps running) ──
  await ctx1.close();
  await killProc(wp1.proc);

  // ── Spawn wolfpack #2 against the same broker ──
  const wp2 = await spawnWolfpack({ socketPath: socketPath!, devDir: devDir! });
  const baseUrl2 = `http://127.0.0.1:${wp2.port}`;

  // ── Browser attach #2: prefill must contain marker ──
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  let conn2Prefill = "";
  await page2.routeWebSocket(/\/ws\/pty/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => server.send(msg));
    server.onMessage((data) => {
      if (typeof data !== "string") conn2Prefill += frameToText(data);
      ws.send(data);
    });
    ws.onClose((code, reason) => server.close({ code, reason }));
    server.onClose((code, reason) => ws.close({ code, reason }));
  });
  await page2.goto(baseUrl2);
  await page2.waitForSelector(".card", { timeout: 5000 });
  await page2.locator(".card", { hasText: SESSION_NAME }).first().click();
  await expect(page2.locator("#desktop-terminal-container canvas")).toBeVisible({ timeout: 5000 });

  // Allow prefill to fully arrive.
  const prefillDeadline = Date.now() + 6000;
  while (Date.now() < prefillDeadline) {
    if (stripAnsi(conn2Prefill).includes(marker)) break;
    await wait(150);
  }
  expect(stripAnsi(conn2Prefill), "post-restart prefill contains pre-restart marker")
    .toContain(marker);

  await ctx2.close();
  await killProc(wp2.proc);
});
