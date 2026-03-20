import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import type { AddressInfo } from "node:net";

// Use dynamic import so WOLFPACK_TEST is set before server module evaluation.
process.env.WOLFPACK_TEST = "1";

const { server, __setTestOverrides, __getTestState } = await import("../../src/server/index.ts");
const { activePtySessions: __activePtySessions } = __getTestState();

// ── Test setup ──

let port: number;
let baseUrl: string;
let baseWsUrl: string;

const FAKE_SESSIONS = ["prompt-sess", "reconnect-sess"];
// Mock tmux send/key to avoid requiring real tmux sessions
const sendLog: { session: string; text: string; noEnter?: boolean }[] = [];
const keyLog: { session: string; key: string }[] = [];
__setTestOverrides({
  tmuxList: async () => [...FAKE_SESSIONS],
  tmuxSend: async (session, text, noEnter) => { sendLog.push({ session, text, noEnter }); },
  tmuxSendKey: async (session, key) => { keyLog.push({ session, key }); },
});

const _realConsoleError = console.error;

beforeAll((done) => {
  console.error = (...args: any[]) => {
    const msg = String(args[0] ?? "");
    if (msg.startsWith("WS error")) return;
    _realConsoleError(...args);
  };
  server.listen(0, "127.0.0.1", () => {
    port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    baseWsUrl = `ws://127.0.0.1:${port}`;
    done();
  });
});

afterAll(() => {
  console.error = _realConsoleError;
  server.close();
});

// ── Helpers ──

async function rawUpgrade(path: string): Promise<{ status: number; ws?: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${baseWsUrl}${path}`);
    ws.addEventListener("open", () => resolve({ status: 101, ws }));
    ws.addEventListener("error", () => resolve({ status: 0 }));
    ws.addEventListener("close", (ev) => {
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

// ═══════════════════════════════════════════════════════════════════════════
// Keyboard Accessory Input Coordination (WS key dispatch)
// ═══════════════════════════════════════════════════════════════════════════

describe("Keyboard accessory — WS /ws/terminal key dispatch", () => {
  test("Tab key accepted via WS", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=prompt-sess");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "key", key: "Tab" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("Escape key accepted via WS", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=prompt-sess");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "key", key: "Escape" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("C-c key accepted via WS", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=prompt-sess");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "key", key: "C-c" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("arrow keys accepted via WS", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=prompt-sess");
    expect(ws).toBeDefined();
    for (const key of ["Up", "Down", "Left", "Right"]) {
      ws!.send(JSON.stringify({ type: "key", key }));
    }
    await wait(300);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("insert characters sent as input (not key)", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=prompt-sess");
    expect(ws).toBeDefined();
    // Keyboard accessory insert chars (|, /, ~, -) are sent as input type
    for (const char of ["|", "/", "~", "-"]) {
      ws!.send(JSON.stringify({ type: "input", data: char }));
    }
    await wait(300);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("mixed key and input messages in rapid succession", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=prompt-sess");
    expect(ws).toBeDefined();
    // Simulate rapid keyboard accessory taps
    ws!.send(JSON.stringify({ type: "key", key: "Tab" }));
    ws!.send(JSON.stringify({ type: "input", data: "cd " }));
    ws!.send(JSON.stringify({ type: "key", key: "Tab" }));
    ws!.send(JSON.stringify({ type: "key", key: "Enter" }));
    await wait(400);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Reconnect State Transitions
// ═══════════════════════════════════════════════════════════════════════════

describe("Reconnect — mobile terminal close codes", () => {
  test("session disappear yields 4001 (client should NOT retry)", async () => {
    const ws = new WebSocket(`${baseWsUrl}/ws/terminal?session=prompt-sess`);
    const closePromise = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });

    // Remove session
    const idx = FAKE_SESSIONS.indexOf("prompt-sess");
    FAKE_SESSIONS.splice(idx, 1);

    try {
      const ev = await Promise.race([
        closePromise,
        wait(6000).then(() => { throw new Error("timeout"); }),
      ]) as CloseEvent;
      expect(ev.code).toBe(4001);
    } finally {
      FAKE_SESSIONS.push("prompt-sess");
      await wait(50);
    }
  });

  test("reconnect succeeds after session reappears post-4001", async () => {
    // First: connect and get 4001
    const ws1 = new WebSocket(`${baseWsUrl}/ws/terminal?session=reconnect-sess`);
    const close1 = new Promise<CloseEvent>((r) => ws1.addEventListener("close", r));
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("connect failed")));
    });

    const idx = FAKE_SESSIONS.indexOf("reconnect-sess");
    FAKE_SESSIONS.splice(idx, 1);

    const ev1 = await Promise.race([
      close1,
      wait(6000).then(() => { throw new Error("timeout"); }),
    ]) as CloseEvent;
    expect(ev1.code).toBe(4001);

    // Restore session and reconnect
    FAKE_SESSIONS.push("reconnect-sess");
    await wait(50);

    const { status, ws: ws2 } = await rawUpgrade("/ws/terminal?session=reconnect-sess");
    expect(status).toBe(101);
    expect(ws2!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws2!);
  });

  test("connection to nonexistent session rejected immediately", async () => {
    const { status, ws } = await rawUpgrade("/ws/terminal?session=ghost-session");
    expect(status).not.toBe(101);
    if (ws) await closeWs(ws);
  });
});

describe("Reconnect — PTY /ws/pty close codes", () => {
  test("PTY spawn failure yields 4001 (prevents reconnect loop)", async () => {
    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=prompt-sess`);
    ws.binaryType = "arraybuffer";
    const closePromise = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });

    // Trigger spawn (will fail — no real tmux)
    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

    const ev = await Promise.race([
      closePromise,
      wait(5000).then(() => { throw new Error("timeout"); }),
    ]) as CloseEvent;

    expect(ev.code).toBe(4001);
  });

  test("consecutive PTY spawn failures all return 4001 (no 1000 leak)", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=prompt-sess`);
      ws.binaryType = "arraybuffer";
      const cp = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("connect failed")));
      });
      ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
      const ev = await Promise.race([
        cp,
        wait(5000).then(() => { throw new Error("timeout"); }),
      ]) as CloseEvent;
      codes.push(ev.code);
    }
    expect(codes).toEqual([4001, 4001, 4001]);
  });
});

describe("Reconnect — PTY single-viewer state transitions", () => {
  test("viewer disconnect → immediate teardown → reconnect creates fresh entry", async () => {
    const ptySessions = __activePtySessions;
    ptySessions.delete("prompt-sess");
    await wait(50);

    // Connect
    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=prompt-sess`);
    ws1.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("connect failed")));
    });

    expect(ptySessions.has("prompt-sess")).toBe(true);
    const entry = ptySessions.get("prompt-sess")!;
    expect(entry.alive).toBe(true);

    // Disconnect — immediate teardown (no grace period)
    ws1.close();
    await wait(200);
    expect(entry.alive).toBe(false);

    // Reconnect — creates fresh entry
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=prompt-sess`);
    ws2.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("reconnect failed")));
    });

    const newEntry = ptySessions.get("prompt-sess");
    expect(newEntry).toBeDefined();
    expect(newEntry!.alive).toBe(true);
    expect(newEntry).not.toBe(entry); // fresh entry, not reused
    ws2.close();
    await wait(200);
  });

  test("viewer disconnect tears down immediately (no grace period)", async () => {
    const ptySessions = __activePtySessions;
    ptySessions.delete("reconnect-sess");
    await wait(50);

    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=reconnect-sess`);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });

    const entry = ptySessions.get("reconnect-sess")!;
    expect(entry.alive).toBe(true);

    ws.close();
    await wait(200);

    // Immediate teardown — no need to wait 15s
    expect(entry.alive).toBe(false);
  });
});

