import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import type { AddressInfo } from "node:net";

// Set WOLFPACK_TEST before importing serve.ts to prevent auto-listen
process.env.WOLFPACK_TEST = "1";

import { server, wss, __setTmuxList, __getActivePtySessions } from "../../serve.ts";

// ── Test setup ──

let port: number;
let baseWsUrl: string;

// Fake tmuxList returns a known session list (mutated in-place by tests)
const FAKE_SESSIONS = ["test-session", "another-session"];
__setTmuxList(async () => [...FAKE_SESSIONS]);

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

  test("connects via /ws/mobile alias for valid session", async () => {
    const { status, ws } = await rawUpgrade("/ws/mobile?session=test-session");
    expect(status).toBe(101);
    expect(ws).toBeDefined();
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
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

describe("WS /ws/terminal session lifecycle", () => {
  test("closes with 4001 when session disappears after connect", async () => {
    const ws = new WebSocket(`${baseWsUrl}/ws/terminal?session=test-session`);
    const closePromise = new Promise<CloseEvent>((resolve) => {
      ws.addEventListener("close", (ev) => resolve(ev));
    });

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws/terminal connect failed")));
    });

    const idx = FAKE_SESSIONS.indexOf("test-session");
    expect(idx).toBeGreaterThan(-1);
    if (idx !== -1) FAKE_SESSIONS.splice(idx, 1);

    try {
      const closeEvent = await Promise.race([
        closePromise,
        wait(6000).then(() => { throw new Error("timed out waiting for session-ended close"); }),
      ]) as CloseEvent;
      expect(closeEvent.code).toBe(4001);
    } finally {
      if (!FAKE_SESSIONS.includes("test-session")) FAKE_SESSIONS.push("test-session");
      await wait(50);
    }
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

// ── /ws/pty spawn failure + reconnect loop prevention ──

describe("WS /ws/pty spawn failure handling", () => {
  test("closes with 4001 when pty spawn fails (no real tmux session)", async () => {
    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=test-session`);
    ws.binaryType = "arraybuffer";

    // Set up close listener before anything else to avoid race
    const closePromise = new Promise<CloseEvent>((resolve) => {
      ws.addEventListener("close", (ev) => resolve(ev));
    });

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws/pty connect failed")));
    });

    // Trigger spawnPty — will fail because "test-session" has no real tmux session
    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

    const closeEvent = await Promise.race([
      closePromise,
      wait(5000).then(() => { throw new Error("timed out waiting for WS close"); }),
    ]) as CloseEvent;

    // Must close with 4001 (session unavailable), NOT 1000 (normal close).
    // Code 1000 tells the client "safe to reconnect" → infinite reconnect loop.
    expect(closeEvent.code).toBe(4001);
  });

  test("rapid reconnects after spawn failure all get 4001", async () => {
    const closeCodes: number[] = [];

    for (let i = 0; i < 3; i++) {
      const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=test-session`);
      ws.binaryType = "arraybuffer";

      const closePromise = new Promise<CloseEvent>((resolve) => {
        ws.addEventListener("close", (ev) => resolve(ev));
      });

      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("ws/pty connect failed")));
      });

      ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

      const ev = await Promise.race([
        closePromise,
        wait(5000).then(() => { throw new Error("timed out waiting for WS close"); }),
      ]) as CloseEvent;
      closeCodes.push(ev.code);
    }

    // Every reconnect should get 4001, not 1000
    expect(closeCodes).toEqual([4001, 4001, 4001]);
  });
});

// ── Mobile terminal: session disappear + reconnect ──

describe("WS /ws/terminal session disappear & reconnect", () => {
  test("client can reconnect after session reappears", async () => {
    // 1. Connect
    const ws1 = new WebSocket(`${baseWsUrl}/ws/terminal?session=test-session`);
    const close1 = new Promise<CloseEvent>((r) => ws1.addEventListener("close", r));
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("connect failed")));
    });

    // 2. Remove session → should get 4001
    const idx = FAKE_SESSIONS.indexOf("test-session");
    FAKE_SESSIONS.splice(idx, 1);

    const ev1 = await Promise.race([
      close1,
      wait(6000).then(() => { throw new Error("timeout waiting for 4001"); }),
    ]) as CloseEvent;
    expect(ev1.code).toBe(4001);

    // 3. Restore session
    FAKE_SESSIONS.push("test-session");
    await wait(50);

    // 4. Reconnect — should succeed
    const { status, ws: ws2 } = await rawUpgrade("/ws/terminal?session=test-session");
    expect(status).toBe(101);
    expect(ws2!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws2!);
  });

  test("multiple terminals get 4001 when session disappears", async () => {
    const conns: WebSocket[] = [];
    const closePromises: Promise<CloseEvent>[] = [];

    // Open 3 concurrent mobile terminal connections
    for (let i = 0; i < 3; i++) {
      const ws = new WebSocket(`${baseWsUrl}/ws/terminal?session=another-session`);
      const cp = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error(`connect ${i} failed`)));
      });
      conns.push(ws);
      closePromises.push(cp);
    }

    // Remove session
    const idx = FAKE_SESSIONS.indexOf("another-session");
    FAKE_SESSIONS.splice(idx, 1);

    try {
      const events = await Promise.race([
        Promise.all(closePromises),
        wait(8000).then(() => { throw new Error("timeout"); }),
      ]) as CloseEvent[];
      // All three should get 4001
      for (const ev of events) {
        expect(ev.code).toBe(4001);
      }
    } finally {
      FAKE_SESSIONS.push("another-session");
      await wait(50);
    }
  });
});

// ── PTY: grace period teardown ──

describe("WS /ws/pty teardown grace period", () => {
  test("PTY entry survives brief viewer disconnect (not torn down immediately)", async () => {
    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=test-session`);
    ws1.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("ws/pty connect failed")));
    });

    const ptySessions = __getActivePtySessions();
    expect(ptySessions.has("test-session")).toBe(true);
    const entryBefore = ptySessions.get("test-session")!;
    expect(entryBefore.alive).toBe(true);

    // Disconnect the only viewer
    ws1.close();
    await wait(200);

    // Entry should still be alive during 15s grace period
    expect(ptySessions.has("test-session")).toBe(true);
    expect(ptySessions.get("test-session")!.alive).toBe(true);

    // Reconnect within grace period — reuses same entry
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=test-session`);
    ws2.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("ws/pty reconnect failed")));
    });

    const entryAfter = ptySessions.get("test-session");
    expect(entryAfter).toBe(entryBefore); // same reference — not recreated
    expect(entryAfter!.alive).toBe(true);

    ws2.close();
    await wait(100);
  });

  test("PTY entry torn down after grace period expires with no viewers", async () => {
    // Use a unique session so we don't collide with other tests
    const session = "another-session";
    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });

    const ptySessions = __getActivePtySessions();
    expect(ptySessions.has(session)).toBe(true);
    expect(ptySessions.get(session)!.alive).toBe(true);

    // Disconnect — starts grace timer
    ws.close();
    await wait(200);

    // Still alive during grace period
    expect(ptySessions.has(session)).toBe(true);
    expect(ptySessions.get(session)!.alive).toBe(true);

    // Wait past the 15s grace period (plus buffer)
    await wait(16_000);

    // Now the entry should be torn down
    const entry = ptySessions.get(session);
    if (entry) {
      // Map entry might still exist but should be dead
      expect(entry.alive).toBe(false);
    } else {
      // Or removed entirely — also valid
      expect(ptySessions.has(session)).toBe(false);
    }
  }, 20_000); // 20s timeout for this test
});

// ── PTY: multi-viewer lifecycle ──

describe("WS /ws/pty multi-viewer", () => {
  test("multiple viewers share same PTY entry", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();

    // Clear any stale entry from previous tests
    ptySessions.delete(session);
    await wait(50);

    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws1.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("v1 connect failed")));
    });

    const entry1 = ptySessions.get(session);
    expect(entry1).toBeDefined();
    expect(entry1!.viewers.size).toBe(1);

    // Second viewer joins
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws2.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("v2 connect failed")));
    });

    // Same entry, 2 viewers
    expect(ptySessions.get(session)).toBe(entry1);
    expect(entry1!.viewers.size).toBe(2);

    // Third viewer
    const ws3 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws3.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws3.addEventListener("open", () => resolve());
      ws3.addEventListener("error", () => reject(new Error("v3 connect failed")));
    });

    expect(entry1!.viewers.size).toBe(3);

    // Disconnect all
    ws1.close();
    ws2.close();
    ws3.close();
    await wait(200);
  });

  test("partial viewer disconnect doesn't trigger teardown", async () => {
    const session = "test-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws1.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("v1 failed")));
    });

    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws2.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("v2 failed")));
    });

    const entry = ptySessions.get(session)!;
    expect(entry.viewers.size).toBe(2);
    expect(entry.alive).toBe(true);

    // Disconnect one viewer — should NOT start teardown
    ws1.close();
    await wait(200);

    // Entry still alive, one viewer remaining
    expect(entry.alive).toBe(true);
    expect(entry.viewers.size).toBe(1);

    // No teardown timer should be pending (still has a viewer)
    expect((entry as any).teardownTimer).toBeFalsy();

    ws2.close();
    await wait(200);
  });

  test("last viewer disconnect starts grace period, not immediate teardown", async () => {
    const session = "another-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws1.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("connect failed")));
    });

    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws2.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("v2 connect failed")));
    });

    const entry = ptySessions.get(session)!;
    expect(entry.viewers.size).toBe(2);

    // Disconnect both — triggers grace period
    ws1.close();
    ws2.close();
    await wait(300);

    // Should be alive (grace period, not immediate teardown)
    expect(entry.alive).toBe(true);
    expect(entry.viewers.size).toBe(0);
    // teardownTimer should be set
    expect((entry as any).teardownTimer).toBeTruthy();

    // Reconnect cancels the timer
    const ws3 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws3.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws3.addEventListener("open", () => resolve());
      ws3.addEventListener("error", () => reject(new Error("reconnect failed")));
    });

    expect(ptySessions.get(session)).toBe(entry); // same entry reused
    expect((entry as any).teardownTimer).toBeFalsy(); // timer cleared

    ws3.close();
    await wait(100);
  });
});

// ── PTY: rapid spawn failure edge cases ──

describe("WS /ws/pty rapid spawn failure edge cases", () => {
  test("concurrent viewers to dead session all get 4001", async () => {
    const ptySessions = __getActivePtySessions();
    ptySessions.delete("test-session");
    await wait(50);

    // Open all connections first, then send resize to trigger spawn
    const sockets: WebSocket[] = [];
    const closePromises: Promise<CloseEvent>[] = [];

    for (let i = 0; i < 3; i++) {
      const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=test-session`);
      ws.binaryType = "arraybuffer";
      closePromises.push(new Promise<CloseEvent>((r) => ws.addEventListener("close", r)));
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error(`connect ${i} failed`)));
      });
      sockets.push(ws);
    }

    // All connected — trigger spawn from first viewer (others are already joined)
    sockets[0].send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

    const events = await Promise.race([
      Promise.all(closePromises),
      wait(8000).then(() => { throw new Error("timeout waiting for close"); }),
    ]) as CloseEvent[];

    for (const ev of events) {
      expect(ev.code).toBe(4001);
    }
  });

  test("spawn failure cleans up PTY entry", async () => {
    const ptySessions = __getActivePtySessions();
    ptySessions.delete("test-session");
    await wait(50);

    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=test-session`);
    ws.binaryType = "arraybuffer";

    const closePromise = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });

    // Entry exists before spawn attempt
    expect(ptySessions.has("test-session")).toBe(true);

    // Trigger spawn — will fail (no real tmux)
    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

    await Promise.race([
      closePromise,
      wait(5000).then(() => { throw new Error("timeout"); }),
    ]);

    // After spawn failure, entry should be cleaned up
    await wait(100);
    const entry = ptySessions.get("test-session");
    if (entry) {
      expect(entry.alive).toBe(false);
    }
  });

  test("viewer that disconnects before spawn completes is handled gracefully", async () => {
    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=test-session`);
    ws.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });

    // Immediately close WITHOUT triggering spawn (no resize sent)
    ws.close();
    await wait(300);

    // Should not leave orphaned entries permanently (grace period will clean up)
    // Entry might still exist in grace period — that's fine, it's alive but empty
    const ptySessions = __getActivePtySessions();
    const entry = ptySessions.get("test-session");
    if (entry) {
      expect(entry.viewers.size).toBe(0);
    }
  });
});
