process.env.WOLFPACK_TEST = "1";

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { closeWebSocketsForShutdown, type ShutdownSocket } from "../../src/server/shutdown";
import { CLOSE_CODE_SERVICE_RESTART, WS_CLOSE_REASONS } from "../../src/ws-constants";

describe("closeWebSocketsForShutdown", () => {
  test("closes every connected viewer with 1012 service restart", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const { port } = wss.address() as { port: number };
    try {
      const clients = await Promise.all([0, 1].map(() => new Promise<WebSocket>((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${port}`);
        client.once("open", () => resolve(client));
        client.once("error", reject);
      })));
      while (wss.clients.size < clients.length) await new Promise((r) => setTimeout(r, 5));
      const closes = clients.map((client) => new Promise<{ code: number; reason: string }>((resolve) => {
        client.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      }));

      await closeWebSocketsForShutdown(wss.clients, 1_000);

      for (const close of await Promise.all(closes)) {
        expect(close).toEqual({ code: CLOSE_CODE_SERVICE_RESTART, reason: WS_CLOSE_REASONS.SERVICE_RESTART });
      }
      expect(wss.clients.size).toBe(0);
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  test("terminates a socket that never finishes closing once the deadline passes", async () => {
    const calls: string[] = [];
    const stuck: ShutdownSocket = {
      close: (code, reason) => { calls.push(`close ${code} ${reason}`); },
      once: () => undefined,
      terminate: () => { calls.push("terminate"); },
    };
    const startedAt = Date.now();
    await closeWebSocketsForShutdown([stuck], 50);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45);
    expect(calls).toEqual([`close ${CLOSE_CODE_SERVICE_RESTART} ${WS_CLOSE_REASONS.SERVICE_RESTART}`, "terminate"]);
  });

  test("resolves immediately with no viewers", async () => {
    const startedAt = Date.now();
    await closeWebSocketsForShutdown([], 5_000);
    expect(Date.now() - startedAt).toBeLessThan(100);
  });
});

describe("installShutdownSignalHandlers", () => {
  test("SIGTERM closes viewers with 1012 and the process still dies by SIGTERM", async () => {
    const child = spawn(process.execPath, [join(import.meta.dir, "fixtures", "shutdown-signal-server.ts")], {
      env: { ...process.env, WOLFPACK_TEST: "1" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let out = "";
        child.stdout!.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          const match = /PORT (\d+)/.exec(out);
          if (match) resolve(Number(match[1]));
        });
        child.once("exit", () => reject(new Error("fixture exited before listening")));
      });
      const client = await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        socket.once("open", () => resolve(socket));
        socket.once("error", reject);
      });
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        client.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });

      child.kill("SIGTERM");

      expect(await closed).toEqual({ code: CLOSE_CODE_SERVICE_RESTART, reason: WS_CLOSE_REASONS.SERVICE_RESTART });
      expect(await exited).toEqual({ code: null, signal: "SIGTERM" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 15_000);
});
