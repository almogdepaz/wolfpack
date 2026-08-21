import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { connect, type AddressInfo, type Socket } from "node:net";
import {
  createTailnetOriginServerFixture,
  TAILNET_REJECTED_ORIGINS,
  TAILNET_SIBLING_ORIGIN,
} from "./tailnet-origin-fixture.ts";
import type { TailnetOriginServerFixture } from "./tailnet-origin-fixture.ts";

// Use dynamic import so WOLFPACK_TEST is set before server module evaluation.
process.env.WOLFPACK_TEST = "1";

const {
  createServerInstance,
  __wsConnectionsByIp,
  __reserveWsConnection,
  MAX_WS_CONNECTIONS_PER_IP,
} = await import("../../src/server/index.ts");
const { PTY_WEBSOCKET_MAX_PAYLOAD_BYTES } = await import("../../src/ws-constants.ts");
const { __getTestState } = await import("../../src/test-hooks.ts");
const { __setTestBackend } = await import("../../src/server/backend.ts");
const { MockBackend } = await import("../../src/server/mock-backend.ts");
const { activePtySessions: __activePtySessions, ptySpawnAttempts: __ptySpawnAttempts } = __getTestState();

const FAKE_SESSIONS = ["dispatch-session", "reconnect-session"];
const mockBackend = new MockBackend({ sessions: FAKE_SESSIONS });
__setTestBackend(mockBackend);

const { server, wss } = createServerInstance();

// ── Test setup ──

let port: number;
let baseUrl: string;
let baseWsUrl: string;
let tailnetServer: TailnetOriginServerFixture;

const _realConsoleError = console.error;

beforeAll(async () => {
  console.error = (...args: any[]) => {
    const msg = String(args[0] ?? "");
    if (msg.startsWith("WS error") || msg.startsWith("PTY WS error") || msg.startsWith("Route error")) return;
    _realConsoleError(...args);
  };
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;
      baseWsUrl = `ws://127.0.0.1:${port}`;
      resolve();
    });
  });
  tailnetServer = await createTailnetOriginServerFixture();
});

afterAll(async () => {
  console.error = _realConsoleError;
  server.close();
  await tailnetServer.stop();
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

function originUpgrade(origin: string, targetPort = port): Promise<{ readonly statusLine: string; readonly socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect(targetPort, "127.0.0.1");
    let response = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve({ statusLine: response.split("\r\n", 1)[0] ?? "", socket });
    };
    socket.once("error", reject);
    socket.on("connect", () => socket.write(
      "GET /ws/pty?session=dispatch-session HTTP/1.1\r\n"
      + `Host: 127.0.0.1:${targetPort}\r\n`
      + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
      + "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
      + `Origin: ${origin}\r\n\r\n`,
    ));
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\r\n\r\n")) finish();
    });
    socket.once("close", finish);
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

// ── Close code semantics driving reconnect decisions ──

test("WebSocket transport caps payloads before application parsing", () => {
  expect(wss.options.maxPayload).toBe(PTY_WEBSOCKET_MAX_PAYLOAD_BYTES);
});

test("WebSocket connection reservations reject an IP at the active cap", () => {
  __wsConnectionsByIp.set("127.0.0.1", MAX_WS_CONNECTIONS_PER_IP);
  try {
    expect(__reserveWsConnection("127.0.0.1")).toBe(false);
  } finally {
    __wsConnectionsByIp.clear();
  }
});

describe("WS close code semantics (backoff decision drivers)", () => {
  test("invalid session on PTY connect gets rejected (not 101)", async () => {
    const { status, ws } = await rawUpgrade("/ws/pty?session=no-such-session");
    expect(status).not.toBe(101);
    if (ws) await closeWs(ws);
  });

  test("configured sibling Tailnet origin reaches websocket upgrade and dispatch", async () => {
    const session = "dispatch-session";
    const tailnetPort = Number(new URL(tailnetServer.base).port);
    const { statusLine, socket } = await originUpgrade(TAILNET_SIBLING_ORIGIN, tailnetPort);
    try {
      expect(statusLine).toBe("HTTP/1.1 101 Switching Protocols");
      expect(await tailnetServer.wasDispatched(session)).toBe(true);
    } finally {
      socket.destroy();
      await wait(50);
    }
  });

  test("rejects foreign and lookalike websocket origins before dispatch", async () => {
    const session = "dispatch-session";
    const tailnetPort = Number(new URL(tailnetServer.base).port);
    for (const origin of TAILNET_REJECTED_ORIGINS) {
      const { statusLine, socket } = await originUpgrade(origin, tailnetPort);
      try {
        expect(statusLine, origin).not.toBe("HTTP/1.1 101 Switching Protocols");
        expect(await tailnetServer.wasDispatched(session), origin).toBe(false);
      } finally {
        socket.destroy();
      }
    }
  });
});

// ── PTY state transitions (single-viewer model) ──

describe("WS /ws/pty state transitions", () => {
  test("entry created on first connect, torn down on disconnect", async () => {
    const session = "dispatch-session";
    const ptySessions = __activePtySessions;
    ptySessions.delete(session);
    await wait(50);

    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });

    // Entry exists after connect
    expect(ptySessions.has(session)).toBe(true);
    const entry = ptySessions.get(session)!;
    expect(entry.alive).toBe(true);
    expect(entry.viewer).toBeTruthy();

    ws.close();
    await wait(200);

    // Single-viewer model: immediate teardown on disconnect
    expect(entry.alive).toBe(false);
  });

  test("attach + immediate resize only triggers one spawn attempt", async () => {
    const session = "dispatch-session";
    const ptySessions = __activePtySessions;
    ptySessions.delete(session);
    const spawnAttempts = __ptySpawnAttempts;
    spawnAttempts.delete(session);
    await wait(50);

    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });

    // During bootstrap, attach and resize can arrive back-to-back.
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await wait(250);

    expect(spawnAttempts.get(session) || 0).toBe(1);
    await closeWs(ws);
  });

  test("second viewer gets conflict, first stays active", async () => {
    const session = "dispatch-session";
    const ptySessions = __activePtySessions;
    ptySessions.delete(session);
    await wait(50);

    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws1.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("connect failed")));
    });

    const entry = ptySessions.get(session)!;
    expect(entry.viewer).toBeTruthy();
    const originalViewer = entry.viewer;

    // Second viewer connects — should get viewer_conflict
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws2.binaryType = "arraybuffer";
    const conflictPromise = new Promise<boolean>((resolve) => {
      ws2.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === "viewer_conflict") resolve(true);
        } catch {}
      });
      setTimeout(() => resolve(false), 2000);
    });

    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("ws2 connect failed")));
    });

    expect(await conflictPromise).toBe(true);
    // Original viewer still active
    expect(entry.viewer).toBe(originalViewer);

    await closeWs(ws2);
    await closeWs(ws1);
    await wait(100);
  });

  test("rapid connect/disconnect cycles don't leak entries", async () => {
    const session = "dispatch-session";
    const ptySessions = __activePtySessions;
    ptySessions.delete(session);
    await wait(50);

    // 5 rapid connect/disconnect cycles
    for (let i = 0; i < 5; i++) {
      const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
      ws.binaryType = "arraybuffer";
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error(`cycle ${i} connect failed`)));
      });
      ws.close();
      await wait(200);
    }

    // After last close, entry should be torn down (no grace period in single-viewer model)
    const entry = ptySessions.get(session);
    if (entry) {
      expect(entry.alive).toBe(false);
    }
  });
});

