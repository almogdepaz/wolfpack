/**
 * Broker take-control — verify the viewer-conflict / take_control / displaced
 * protocol works against broker-backed sessions.
 *
 * Drives raw WebSocket connections from Node (rather than full browser UI)
 * because the protocol assertions are what matter for broker correctness; the
 * UI is exercised by tests/integration/take-control.test.ts against the mock
 * backend and the smoke/grid e2e tests against real WS.
 *
 * Sequence:
 *   1. wsA connects, becomes live viewer
 *   2. wsB connects, receives viewer_conflict
 *   3. wsB sends take_control → wsA closes with code 4002, wsB gets control_granted
 *   4. wsA reconnects → wsA' becomes pending, takes control back from wsB → wsB closes 4002
 *
 * Acceptance: chain A→B→A works end-to-end against the broker backend.
 */
import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { start, skipIfNoBroker } from "./broker-helpers.ts";
import type { BrokerTestServer } from "./broker-helpers.ts";

// ── Constants ────────────────────────────────────────────────────────────────

const PROJECT_NAME = "wp-take-control";
const SESSION_NAME = "tc-broker";
const STRESS_SESSION_NAMES = [
  "tc-broker-stress-1",
  "tc-broker-stress-2",
  "tc-broker-stress-3",
  "tc-broker-stress-4",
] as const;
const STRESS_SESSION_NAME = STRESS_SESSION_NAMES[0];
const STRESS_PAYLOAD_BYTES = 8_180;
const STRESS_WRITES = 12_000;
const STRESS_WRITE_DELAY_SECONDS = 0.0005;
const STRESS_MIN_OUTPUT_BYTES = 64 * 1024;
const STRESS_OBSERVE_MS = 6_000;
const CLOSE_DISPLACED = 4002;

// ── Helpers ───────────────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface JsonMsg { type: string; [k: string]: unknown }

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 5000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(new Error(`ws error: ${e}`)); }, { once: true });
  });
}

function waitForJson(ws: WebSocket, type: string, timeoutMs = 5000): Promise<JsonMsg> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const cleanup = () => { clearTimeout(timer); ws.removeEventListener("message", onMsg); ws.removeEventListener("close", onClose); };
    function onMsg(ev: MessageEvent) {
      if (typeof ev.data !== "string") return;
      try {
        const msg = JSON.parse(ev.data) as JsonMsg;
        if (msg.type === type) { cleanup(); resolve(msg); }
      } catch { /* non-JSON frames are fine */ }
    }
    function onClose() { cleanup(); reject(new Error(`ws closed before ${type}`)); }
    ws.addEventListener("message", onMsg);
    ws.addEventListener("close", onClose);
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === ws.CLOSED) { resolve({ code: 0, reason: "" }); return; }
    const timer = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
    ws.addEventListener("close", (e) => { clearTimeout(timer); resolve({ code: e.code, reason: e.reason }); }, { once: true });
  });
}

function sendAttachAndTakeControl(ws: WebSocket, cols = 80, rows = 24): void {
  ws.send(JSON.stringify({ type: "attach", cols, rows }));
  ws.send(JSON.stringify({ type: "take_control" }));
}

function binaryMessageBytes(data: unknown): number {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data instanceof Blob) return data.size;
  return 0;
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let srv: BrokerTestServer | null = null;
let devDir: string | null = null;

test.beforeAll(async () => {
  if (skipIfNoBroker.condition) return;
  devDir = realpathSync(mkdtempSync(join(tmpdir(), "wp-broker-tc-")));
  mkdirSync(join(devDir, PROJECT_NAME));
  srv = await start({ envOverrides: { WOLFPACK_DEV_DIR: devDir } });
});

test.afterAll(async () => {
  await srv?.teardown();
  srv = null;
  if (devDir) {
    try { rmSync(devDir, { recursive: true, force: true }); } catch { /* swallow */ }
    devDir = null;
  }
});

// ── Test ──────────────────────────────────────────────────────────────────────

test("broker take-control: A → B → A chain displaces correctly", async ({}, testInfo) => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  // Protocol-level test — runs once, no per-viewport variants needed.
  test.skip(testInfo.project.name === "desktop", "broker test runs once on mobile project only");

  // ── Create session via API ──
  const createResp = await fetch(`${srv!.baseUrl}/api/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: PROJECT_NAME, cmd: "shell", sessionName: SESSION_NAME }),
  });
  expect(createResp.ok, "POST /api/create").toBeTruthy();

  const wsUrl = srv!.baseUrl.replace(/^http/, "ws") + `/ws/pty?session=${encodeURIComponent(SESSION_NAME)}`;

  // ── Step 1: wsA becomes the live viewer ──
  const wsA = await openWs(wsUrl);
  wsA.send(JSON.stringify({ type: "attach", cols: 80, rows: 24 }));
  // Server doesn't send an explicit "you-are-live" — absence of viewer_conflict
  // for ~250ms is the contract. (handlePtyWs sends viewer_conflict synchronously
  // on second-viewer connection, otherwise calls setupNewPtyEntry directly.)
  await wait(250);

  // ── Step 2: wsB sees viewer_conflict ──
  const wsB = await openWs(wsUrl);
  await waitForJson(wsB, "viewer_conflict");

  // ── Step 3: wsB takes control → wsA closes with 4002, wsB gets control_granted ──
  const wsACloseP = waitForClose(wsA);
  const wsBGrantedP = waitForJson(wsB, "control_granted");
  sendAttachAndTakeControl(wsB);
  const wsAClose = await wsACloseP;
  expect(wsAClose.code, "wsA closed with displaced code").toBe(CLOSE_DISPLACED);
  await wsBGrantedP;

  // ── Step 4: wsA' reconnects, takes control back from wsB ──
  const wsA2 = await openWs(wsUrl);
  await waitForJson(wsA2, "viewer_conflict");

  const wsBCloseP = waitForClose(wsB);
  const wsA2GrantedP = waitForJson(wsA2, "control_granted");
  sendAttachAndTakeControl(wsA2);
  const wsBClose = await wsBCloseP;
  expect(wsBClose.code, "wsB closed with displaced code").toBe(CLOSE_DISPLACED);
  await wsA2GrantedP;

  // Cleanup
  wsA2.close();
  await wait(100);
});

test("broker take-control: redraw burst does not force browser reconnect", async ({ page }, testInfo) => {
  test.skip(skipIfNoBroker.condition, skipIfNoBroker.reason);
  test.skip(testInfo.project.name !== "iphone-se", "one real-browser viewport covers the broker path");

  const activeViewers: WebSocket[] = [];
  let activeOutputBytes = 0;
  const redrawCommand = `python3 -c 'import os,time;[(os.write(1,(f"\\033[H{i:05d}"+("x"*${STRESS_PAYLOAD_BYTES})).encode()),time.sleep(${STRESS_WRITE_DELAY_SECONDS})) for i in range(${STRESS_WRITES})]'\n`;
  for (const sessionName of STRESS_SESSION_NAMES) {
    const createResp = await fetch(`${srv!.baseUrl}/api/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: PROJECT_NAME, cmd: "shell", sessionName }),
    });
    expect(createResp.ok, `POST /api/create ${sessionName}`).toBeTruthy();

    const wsUrl = srv!.baseUrl.replace(/^http/, "ws")
      + `/ws/pty?session=${encodeURIComponent(sessionName)}`;
    const viewer = await openWs(wsUrl);
    activeViewers.push(viewer);
    viewer.send(JSON.stringify({ type: "attach", cols: 80, rows: 24 }));
    await waitForJson(viewer, "attach_ack");
    if (sessionName === STRESS_SESSION_NAME) {
      viewer.addEventListener("message", (event) => {
        if (typeof event.data !== "string") activeOutputBytes += binaryMessageBytes(event.data);
      });
    }
    viewer.send(new TextEncoder().encode(redrawCommand));
  }
  const outputDeadline = Date.now() + 5000;
  while (activeOutputBytes < STRESS_MIN_OUTPUT_BYTES && Date.now() < outputDeadline) await wait(25);
  expect(activeOutputBytes, "stress redraw started before takeover").toBeGreaterThanOrEqual(STRESS_MIN_OUTPUT_BYTES);

  let browserPtyConnections = 0;
  page.on("websocket", (socket) => {
    if (socket.url().includes("/ws/pty")) browserPtyConnections++;
  });
  await page.goto(srv!.baseUrl);
  await page.locator(".card", { hasText: STRESS_SESSION_NAME }).first().click();
  const conflict = page.locator("#desktop-conflict-overlay");
  await expect(conflict).toBeVisible({ timeout: 5000 });

  await page.evaluate(() => {
    const target = document.getElementById("conn-status");
    const state = window as unknown as {
      __takeoverStatuses?: string[];
      __takeoverCloses?: Array<{ readonly code: number; readonly reason: string }>;
      state?: { readonly terminalController?: { readonly ptyClient?: { readonly ws?: WebSocket | null } } };
    };
    state.__takeoverStatuses = [];
    state.__takeoverCloses = [];
    state.state?.terminalController?.ptyClient?.ws?.addEventListener("close", (event) => {
      state.__takeoverCloses?.push({ code: event.code, reason: event.reason });
    });
    if (!target) return;
    const record = () => {
      if (target.style.display !== "none") state.__takeoverStatuses?.push(target.textContent || "");
    };
    new MutationObserver(record).observe(target, { childList: true, subtree: true, attributes: true });
    record();
  });
  await conflict.locator("button").click();
  await expect(conflict).toBeHidden({ timeout: 5000 });
  await page.waitForTimeout(STRESS_OBSERVE_MS);

  const trace = await page.evaluate(() => {
    const state = window as unknown as {
      __takeoverStatuses?: string[];
      __takeoverCloses?: Array<{ readonly code: number; readonly reason: string }>;
    };
    return {
      statuses: state.__takeoverStatuses || [],
      closes: state.__takeoverCloses || [],
    };
  });
  expect(
    browserPtyConnections,
    `takeover stayed on the original browser websocket; closes=${JSON.stringify(trace.closes)}`,
  ).toBe(1);
  expect(trace.statuses.join("\n")).not.toMatch(/reconnecting/i);
  expect(
    srv!.brokerStderr(),
    "broker subscription forwarders kept up with the multi-session redraw burst",
  ).not.toContain("subscription forwarder lagged broadcast");

  for (const viewer of activeViewers) viewer.close();
  for (const session of STRESS_SESSION_NAMES) {
    await fetch(`${srv!.baseUrl}/api/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session }),
    });
  }
});
