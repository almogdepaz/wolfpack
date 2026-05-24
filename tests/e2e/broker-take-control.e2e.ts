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
import { start, skipIfNoBroker, type BrokerTestServer } from "./broker-helpers.ts";

// ── Constants ────────────────────────────────────────────────────────────────

const PROJECT_NAME = "wp-take-control";
const SESSION_NAME = "tc-broker";
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
