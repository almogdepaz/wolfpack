import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import type { AddressInfo } from "node:net";

// Use dynamic import so WOLFPACK_TEST is set before server module evaluation.
process.env.WOLFPACK_TEST = "1";

const { createServerInstance } = await import("../../src/server/index.ts");
const { __getTestState } = await import("../../src/test-hooks.ts");
const { __setTestBackend } = await import("../../src/server/backend.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
const { activePtySessions: __activePtySessions } = __getTestState();

const FAKE_SESSIONS = ["prompt-sess", "reconnect-sess"];
const mockBackend = new MockBackend({ sessions: FAKE_SESSIONS });
__setTestBackend(mockBackend);

const { server } = createServerInstance();

// ── Test setup ──

let port: number;
let baseUrl: string;
let baseWsUrl: string;

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

function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

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
// 1. Reconnect State Transitions (PTY /ws/pty)
// ═══════════════════════════════════════════════════════════════════════════

describe("Reconnect — PTY /ws/pty close codes", () => {
  test("attach failure yields 4001 (prevents reconnect loop)", async () => {
    mockBackend.setSessionAlive("prompt-sess", false);
    try {
      const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=prompt-sess`);
      ws.binaryType = "arraybuffer";
      const closePromise = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));

      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("connect failed")));
      });

      // Trigger attach (resize triggers spawn for older clients) — broker
      // mock reports session dead, so attach yields 4001.
      ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

      const ev = await Promise.race([
        closePromise,
        wait(5000).then(() => { throw new Error("timeout"); }),
      ]) as CloseEvent;

      expect(ev.code).toBe(4001);
    } finally {
      mockBackend.setSessionAlive("prompt-sess", null);
      __activePtySessions.delete("prompt-sess");
    }
  });

  test("consecutive attach failures all return 4001 (no 1000 leak)", async () => {
    mockBackend.setSessionAlive("prompt-sess", false);
    try {
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
        __activePtySessions.delete("prompt-sess");
      }
      expect(codes).toEqual([4001, 4001, 4001]);
    } finally {
      mockBackend.setSessionAlive("prompt-sess", null);
    }
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

