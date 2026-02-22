import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import type { AddressInfo } from "node:net";

// Set WOLFPACK_TEST before importing serve.ts to prevent auto-listen
process.env.WOLFPACK_TEST = "1";

import { server, wss, __setTmuxList } from "../../serve.ts";

// ── Test setup ──

let port: number;
let baseWsUrl: string;

// Fake tmuxList returns a known session list
const FAKE_SESSIONS = ["test-session", "another-session"];
__setTmuxList(async () => FAKE_SESSIONS);

// Suppress expected tmux errors (no real tmux session in CI/test)
const _realConsoleError = console.error;

beforeAll((done) => {
  console.error = (...args: any[]) => {
    const msg = String(args[0] ?? "");
    if (msg.startsWith("WS error")) return; // expected — no real tmux
    _realConsoleError(...args);
  };
  // Listen on random port for test isolation
  server.listen(0, "127.0.0.1", () => {
    port = (server.address() as AddressInfo).port;
    baseWsUrl = `ws://127.0.0.1:${port}`;
    done();
  });
});

afterAll(() => {
  console.error = _realConsoleError;
  server.close();
});

// ── Helpers ──

/** Connect using raw HTTP upgrade to detect rejection vs acceptance */
async function rawUpgrade(path: string): Promise<{ status: number; ws?: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${baseWsUrl}${path}`);
    ws.addEventListener("open", () => resolve({ status: 101, ws }));
    ws.addEventListener("error", () => resolve({ status: 0 }));
    ws.addEventListener("close", (ev) => {
      // Bun fires close with code 1006 on rejection (server destroyed socket)
      resolve({ status: ev.code === 1006 ? 403 : ev.code });
    });
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.addEventListener("close", () => resolve());
    ws.close();
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Tests ──

describe("WS /ws/terminal connection", () => {
  test("connects for valid session", async () => {
    const { status, ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(status).toBe(101);
    expect(ws).toBeDefined();
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("rejects unknown session (connection fails)", async () => {
    const { status, ws } = await rawUpgrade("/ws/terminal?session=nonexistent");
    // Server writes "403 Forbidden" and destroys socket — client sees error/close
    expect(status).not.toBe(101);
    if (ws) await closeWs(ws);
  });

  test("rejects missing session param (connection fails)", async () => {
    const { status, ws } = await rawUpgrade("/ws/terminal");
    expect(status).not.toBe(101);
    if (ws) await closeWs(ws);
  });

  test("rejects unknown WS path (connection fails)", async () => {
    const { status, ws } = await rawUpgrade("/ws/unknown?session=test-session");
    expect(status).not.toBe(101);
    if (ws) await closeWs(ws);
  });
});

describe("WS /ws/terminal message handling", () => {
  test("survives invalid JSON message", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    ws!.send("this is not json{{{");
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("survives message with missing fields", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    // input without data field
    ws!.send(JSON.stringify({ type: "input" }));
    // key without key field
    ws!.send(JSON.stringify({ type: "key" }));
    // resize without cols/rows
    ws!.send(JSON.stringify({ type: "resize" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("drops disallowed key silently (connection stays open)", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "key", key: "F13-evil" }));
    ws!.send(JSON.stringify({ type: "key", key: "; rm -rf /" }));
    ws!.send(JSON.stringify({ type: "key", key: "" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("accepts allowed key without crash", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    // tmuxSendKey will fail (no real tmux session) but handler catches errors
    ws!.send(JSON.stringify({ type: "key", key: "Enter" }));
    ws!.send(JSON.stringify({ type: "key", key: "C-c" }));
    ws!.send(JSON.stringify({ type: "key", key: "Tab" }));
    await wait(300);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("survives resize with extreme values", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    // Extreme values — will be clamped by clampCols/clampRows, tmuxResize will fail (no tmux)
    ws!.send(JSON.stringify({ type: "resize", cols: 9999, rows: 0 }));
    ws!.send(JSON.stringify({ type: "resize", cols: -1, rows: -1 }));
    ws!.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    await wait(300);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("drops oversized message (>64KB)", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    // 70KB message — exceeds 65536 byte cap, should be silently dropped
    const huge = JSON.stringify({ type: "input", data: "x".repeat(70 * 1024) });
    ws!.send(huge);
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("rate limiting: rapid messages don't crash", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    // Send 65 messages rapidly — first 60 processed, rest dropped
    for (let i = 0; i < 65; i++) {
      ws!.send(JSON.stringify({ type: "key", key: "Enter" }));
    }
    await wait(500);
    // Connection should survive
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("input message with string data doesn't crash", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "input", data: "hello world" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("unknown message type is silently ignored", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "foobar", data: "whatever" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });
});
