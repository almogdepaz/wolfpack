/**
 * Shared helpers for PTY WebSocket integration tests.
 *
 * Provides: server boot, console-error suppression, WS connect/close/wait
 * utilities, and JSON message collection. Used by desktop-terminal,
 * desktop-grid, and take-control test suites.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// ── Server setup ──

export interface PtyTestContext {
  port: number;
  baseWsUrl: string;
  server: Server;
  activePtySessions: Map<string, any>;
  ptySpawnAttempts: Map<string, number>;
  cleanup: () => void;
}

/**
 * Boot the wolfpack server on a random port for integration tests.
 * Call in beforeAll; call ctx.cleanup() in afterAll.
 *
 * Injects a MockBackend as the session backend singleton so that
 * `isAllowedSession` / `uniqueSessionName` (which go through `getBackend().list()`)
 * work without real tmux. No tmux overrides needed — all backend calls route
 * through MockBackend.
 */
export async function bootTestServer(opts: {
  sessions: string[];
  capturePane?: (session: string) => Promise<string>;
}): Promise<PtyTestContext> {
  process.env.WOLFPACK_TEST = "1";
  const { createServerInstance } = await import("../../src/server/index.ts");
  const { __getTestState } = await import("../../src/test-hooks.ts");
  const { __setTestBackend } = await import("../../src/server/backend.ts");
  const { MockBackend } = await import("../../src/server/mock-backend.ts");
  const { activePtySessions, ptySpawnAttempts } = __getTestState();

  // Inject MockBackend so backend.list() returns the fake sessions
  const mock = new MockBackend({
    sessions: opts.sessions,
    capturePane: opts.capturePane,
  });
  __setTestBackend(mock);

  const { server } = createServerInstance();

  const realConsoleError = console.error;
  console.error = (...args: any[]) => {
    const msg = String(args[0] ?? "");
    if (msg.startsWith("WS error") || msg.startsWith("PTY WS error") || msg.startsWith("Route error")) return;
    realConsoleError(...args);
  };

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

  return {
    port,
    baseWsUrl: `ws://127.0.0.1:${port}`,
    server,
    activePtySessions,
    ptySpawnAttempts,
    cleanup: () => {
      console.error = realConsoleError;
      server.close();
    },
  };
}

// ── WebSocket helpers ──

export function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState >= WebSocket.CLOSING) return resolve();
    ws.addEventListener("close", () => resolve());
    ws.close();
  });
}

export function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return reject(new Error("already closed"));
    const timer = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
    ws.addEventListener("close", (ev) => { clearTimeout(timer); resolve(ev); });
  });
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function connectPty(baseWsUrl: string, session: string, opts?: { reset?: boolean }): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const resetSuffix = opts?.reset ? "&reset=1" : "";
    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}${resetSuffix}`);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("connect failed")));
  });
}

export function collectJsonMessages(ws: WebSocket): { type: string; [k: string]: any }[] {
  const msgs: { type: string; [k: string]: any }[] = [];
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") {
      try { msgs.push(JSON.parse(ev.data)); } catch {}
    }
  });
  return msgs;
}

/** Collect all WS messages — binary as ArrayBuffer, JSON as parsed objects. */
export function collectAllMessages(ws: WebSocket): ({ kind: "binary"; data: ArrayBuffer } | { kind: "json"; data: { type: string; [k: string]: any } })[] {
  const msgs: ({ kind: "binary"; data: ArrayBuffer } | { kind: "json"; data: { type: string; [k: string]: any } })[] = [];
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") {
      try { msgs.push({ kind: "json", data: JSON.parse(ev.data) }); } catch {}
    } else if (ev.data instanceof ArrayBuffer) {
      msgs.push({ kind: "binary", data: ev.data });
    }
  });
  return msgs;
}

export function waitForMessage(ws: WebSocket, type: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const cleanup = () => { clearTimeout(timer); ws.removeEventListener("message", handler); };
    function handler(ev: MessageEvent) {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === type) { cleanup(); resolve(msg); }
        } catch {}
      }
    }
    ws.addEventListener("message", handler);
    ws.addEventListener("close", () => { cleanup(); reject(new Error(`ws closed before ${type}`)); });
  });
}

/** Clean up PTY state for the given session names. */
export function cleanupSessions(
  activePtySessions: Map<string, any>,
  ptySpawnAttempts: Map<string, number>,
  ...names: string[]
) {
  for (const name of names) {
    activePtySessions.delete(name);
    ptySpawnAttempts.delete(name);
  }
}
