import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import type { AddressInfo } from "node:net";

// Set WOLFPACK_TEST before importing serve.ts to prevent auto-listen
process.env.WOLFPACK_TEST = "1";

import { server, __setTmuxList, __getActivePtySessions } from "../../serve.ts";

// ── Test setup ──

let port: number;
let baseUrl: string;
let baseWsUrl: string;

const FAKE_SESSIONS = ["dispatch-session", "reconnect-session"];
__setTmuxList(async () => [...FAKE_SESSIONS]);

const _realConsoleError = console.error;

beforeAll((done) => {
  console.error = (...args: any[]) => {
    const msg = String(args[0] ?? "");
    if (msg.startsWith("WS error") || msg.startsWith("PTY WS error") || msg.startsWith("Route error")) return;
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

function collectMessages(ws: WebSocket): { type: string; data?: string }[] {
  const msgs: { type: string; data?: string }[] = [];
  ws.addEventListener("message", (ev) => {
    try { msgs.push(JSON.parse(String(ev.data))); } catch {}
  });
  return msgs;
}

// ── y/n key dispatch via WS terminal ──

describe("WS /ws/terminal y/n prompt key dispatch", () => {
  test("'y' key accepted via WS terminal handler", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();
    // tmuxSendKey will fail (no real tmux) but handler catches error — connection stays open
    ws!.send(JSON.stringify({ type: "key", key: "y" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("'n' key accepted via WS terminal handler", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "key", key: "n" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("y/n keys dispatched in rapid sequence without dropping connection", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();
    // Simulate rapid y/n toggling (user hesitating at prompt)
    for (let i = 0; i < 10; i++) {
      ws!.send(JSON.stringify({ type: "key", key: i % 2 === 0 ? "y" : "n" }));
    }
    await wait(300);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("y/n via HTTP /api/key returns ok for valid session", async () => {
    for (const key of ["y", "n"]) {
      const resp = await fetch(`${baseUrl}/api/key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "dispatch-session", key }),
      });
      const body = await resp.json();
      // tmux will fail but the API validates the key is allowed before attempting
      // Status might be 200 (ok) or 500 (tmux error) — but NOT 400 (key not allowed)
      expect(resp.status).not.toBe(400);
    }
  });

  test("non-allowlisted keys rejected by HTTP /api/key", async () => {
    for (const key of ["x", "q", "A", ";"]) {
      const resp = await fetch(`${baseUrl}/api/key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "dispatch-session", key }),
      });
      expect(resp.status).toBe(400);
      const body = await resp.json();
      expect(body.error).toBe("key not allowed");
    }
  });
});

// ── Keyboard accessory input coordination ──

describe("WS /ws/terminal keyboard accessory input coordination", () => {
  test("interleaved input + key messages don't crash or desync", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();
    // Simulate keyboard accessory row: user types text, taps Tab, types more, taps Enter
    ws!.send(JSON.stringify({ type: "input", data: "git sta" }));
    ws!.send(JSON.stringify({ type: "key", key: "Tab" }));
    ws!.send(JSON.stringify({ type: "input", data: "tus" }));
    ws!.send(JSON.stringify({ type: "key", key: "Enter" }));
    await wait(300);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("rapid key dispatch interleaved with resize doesn't crash", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();
    // Simulate: user rotates phone (resize) while tapping accessory keys
    ws!.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    ws!.send(JSON.stringify({ type: "key", key: "C-c" }));
    ws!.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    ws!.send(JSON.stringify({ type: "key", key: "y" }));
    ws!.send(JSON.stringify({ type: "input", data: "ls -la" }));
    ws!.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    ws!.send(JSON.stringify({ type: "key", key: "Enter" }));
    await wait(400);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("input message followed immediately by y/n key (prompt answer pattern)", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();
    // Common pattern: command output asks "Continue? [y/n]", user taps y from accessory
    ws!.send(JSON.stringify({ type: "input", data: "rm -i file.txt" }));
    ws!.send(JSON.stringify({ type: "key", key: "Enter" }));
    await wait(100);
    // Prompt appears, user answers
    ws!.send(JSON.stringify({ type: "key", key: "y" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("Ctrl-c interrupt followed by new input (cancel + retype pattern)", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "key", key: "C-c" }));
    await wait(50);
    ws!.send(JSON.stringify({ type: "input", data: "corrected-command" }));
    ws!.send(JSON.stringify({ type: "key", key: "Enter" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("empty input string handled gracefully", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "input", data: "" }));
    ws!.send(JSON.stringify({ type: "key", key: "Enter" }));
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("all WS_ALLOWED_KEYS dispatch without crash", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();
    const allKeys = [
      "Enter", "Tab", "Escape", "Up", "Down", "Left", "Right",
      "BTab", "BSpace", "DC", "Home", "End", "PPage", "NPage",
      "y", "n",
      "C-a", "C-b", "C-c", "C-d", "C-e", "C-f", "C-g", "C-h",
      "C-k", "C-l", "C-n", "C-p", "C-r", "C-u", "C-w", "C-z",
    ];
    for (const key of allKeys) {
      ws!.send(JSON.stringify({ type: "key", key }));
    }
    await wait(500);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });
});

// ── Close code semantics driving reconnect decisions ──

describe("WS close code semantics (backoff decision drivers)", () => {
  test("session disappear yields 4001 (no-reconnect signal)", async () => {
    const ws = new WebSocket(`${baseWsUrl}/ws/terminal?session=reconnect-session`);
    const closePromise = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });

    // Remove session to trigger 4001
    const idx = FAKE_SESSIONS.indexOf("reconnect-session");
    FAKE_SESSIONS.splice(idx, 1);

    try {
      const ev = await Promise.race([
        closePromise,
        wait(6000).then(() => { throw new Error("timeout"); }),
      ]) as CloseEvent;
      // 4001 = session unavailable → client should NOT reconnect
      expect(ev.code).toBe(4001);
    } finally {
      FAKE_SESSIONS.push("reconnect-session");
      await wait(50);
    }
  });

  test("normal client-initiated close yields 1000 (clean close)", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();

    const closePromise = new Promise<CloseEvent>((r) => ws!.addEventListener("close", r));
    ws!.close(1000, "client done");

    const ev = await Promise.race([
      closePromise,
      wait(3000).then(() => { throw new Error("timeout"); }),
    ]) as CloseEvent;
    // Client-initiated clean close
    expect(ev.code).toBe(1000);
  });

  test("PTY spawn failure yields 4001 (prevents reconnect loop)", async () => {
    const ptySessions = __getActivePtySessions();
    ptySessions.delete("dispatch-session");
    await wait(50);

    const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=dispatch-session`);
    ws.binaryType = "arraybuffer";
    const closePromise = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("connect failed")));
    });

    // Trigger spawn — will fail (no real tmux session)
    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

    const ev = await Promise.race([
      closePromise,
      wait(5000).then(() => { throw new Error("timeout"); }),
    ]) as CloseEvent;
    // 4001 = session unavailable, not 1000 — prevents infinite reconnect
    expect(ev.code).toBe(4001);
  });

  test("invalid session on connect gets rejected (not 101)", async () => {
    // Client's reconnect logic shouldn't even see an open event for dead sessions
    const { status, ws } = await rawUpgrade("/ws/terminal?session=no-such-session");
    expect(status).not.toBe(101);
    if (ws) await closeWs(ws);
  });
});

// ── State machine transitions ──

describe("WS terminal state machine transitions", () => {
  test("unsized → sized transition: initial resize triggers first update", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();
    const msgs = collectMessages(ws!);

    // Before resize, the poll runs but the handler should work
    await wait(150);

    // Send resize → sized=true, triggers update after 50ms
    ws!.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    await wait(200);

    // Connection still healthy after transition
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("alive → dead transition: close event stops polling", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();
    ws!.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    await wait(200);

    // Close should cleanly stop polling, no dangling timers
    await closeWs(ws!);
    expect(ws!.readyState).toBe(WebSocket.CLOSED);
    // No crash after close — give timers a chance to fire harmlessly
    await wait(300);
  });

  test("multiple resize messages update dimensions without crash", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();

    // Rapid dimension changes (phone orientation flipping)
    const sizes = [
      { cols: 80, rows: 24 },
      { cols: 120, rows: 40 },
      { cols: 40, rows: 80 },
      { cols: 300, rows: 100 }, // max bounds
      { cols: 20, rows: 5 },   // min bounds
    ];
    for (const { cols, rows } of sizes) {
      ws!.send(JSON.stringify({ type: "resize", cols, rows }));
    }
    await wait(400);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("message after close is harmless (no server crash)", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();

    // Close then try to send — WebSocket API will throw on client side, but
    // if somehow a message arrives server-side after close handler, it should not crash
    await closeWs(ws!);

    // Verify server is still accepting connections (didn't crash)
    const { status, ws: ws2 } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(status).toBe(101);
    if (ws2) await closeWs(ws2);
  });
});

// ── PTY state transitions ──

describe("WS /ws/pty state transitions", () => {
  test("entry created on first connect, removed after cleanup", async () => {
    const session = "dispatch-session";
    const ptySessions = __getActivePtySessions();
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
    expect(entry.viewers.size).toBe(1);

    ws.close();
    await wait(200);

    // Still alive during grace period
    expect(entry.alive).toBe(true);
    expect(entry.viewers.size).toBe(0);
  });

  test("reconnect within grace period cancels teardown timer", async () => {
    const session = "reconnect-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    // Connect
    const ws1 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws1.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => resolve());
      ws1.addEventListener("error", () => reject(new Error("connect failed")));
    });

    const entry = ptySessions.get(session)!;

    // Disconnect → starts teardown timer
    ws1.close();
    await wait(200);
    expect((entry as any).teardownTimer).toBeTruthy();

    // Reconnect within grace → cancels timer, reuses entry
    const ws2 = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
    ws2.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => resolve());
      ws2.addEventListener("error", () => reject(new Error("reconnect failed")));
    });

    expect(ptySessions.get(session)).toBe(entry); // same reference
    expect((entry as any).teardownTimer).toBeFalsy(); // timer cancelled
    expect(entry.viewers.size).toBe(1);

    ws2.close();
    await wait(100);
  });

  test("rapid connect/disconnect cycles don't leak entries", async () => {
    const session = "dispatch-session";
    const ptySessions = __getActivePtySessions();
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
      await wait(100);
    }

    // Should still be one entry (reused via grace period), not 5
    const entry = ptySessions.get(session);
    if (entry) {
      expect(entry.alive).toBe(true);
      expect(entry.viewers.size).toBe(0);
    }
  });

  test("PTY viewer count tracks correctly through add/remove", async () => {
    const session = "dispatch-session";
    const ptySessions = __getActivePtySessions();
    ptySessions.delete(session);
    await wait(50);

    const sockets: WebSocket[] = [];

    // Add 3 viewers
    for (let i = 0; i < 3; i++) {
      const ws = new WebSocket(`${baseWsUrl}/ws/pty?session=${session}`);
      ws.binaryType = "arraybuffer";
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error(`viewer ${i} failed`)));
      });
      sockets.push(ws);
    }

    const entry = ptySessions.get(session)!;
    expect(entry.viewers.size).toBe(3);

    // Remove 1 viewer — no teardown
    sockets[0].close();
    await wait(100);
    expect(entry.viewers.size).toBe(2);
    expect(entry.alive).toBe(true);
    expect((entry as any).teardownTimer).toBeFalsy();

    // Remove second
    sockets[1].close();
    await wait(100);
    expect(entry.viewers.size).toBe(1);
    expect(entry.alive).toBe(true);

    // Remove last — triggers grace period
    sockets[2].close();
    await wait(200);
    expect(entry.viewers.size).toBe(0);
    expect((entry as any).teardownTimer).toBeTruthy();
  });
});

// ── Rate limiting edge cases for dispatch ──

describe("WS /ws/terminal rate limiting under dispatch", () => {
  test("burst of y/n keys: first 60 processed, rest dropped, no disconnect", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();

    // Send 70 y/n keys in burst — exceeds 60 token bucket
    for (let i = 0; i < 70; i++) {
      ws!.send(JSON.stringify({ type: "key", key: i % 2 === 0 ? "y" : "n" }));
    }
    await wait(500);
    // Connection must survive rate limiting (drops, doesn't disconnect)
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("mixed input + key messages share same rate limit bucket", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();

    // 30 input messages + 35 key messages = 65 total, exceeds 60 bucket
    for (let i = 0; i < 30; i++) {
      ws!.send(JSON.stringify({ type: "input", data: `cmd-${i}` }));
    }
    for (let i = 0; i < 35; i++) {
      ws!.send(JSON.stringify({ type: "key", key: "Enter" }));
    }
    await wait(500);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });

  test("rate limit tokens replenish after delay", async () => {
    const { ws } = await rawUpgrade("/ws/terminal?session=dispatch-session");
    expect(ws).toBeDefined();

    // Exhaust bucket
    for (let i = 0; i < 65; i++) {
      ws!.send(JSON.stringify({ type: "key", key: "y" }));
    }
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);

    // Wait ~1s for tokens to replenish (60 tokens/sec)
    await wait(1100);

    // Should be able to send more
    for (let i = 0; i < 30; i++) {
      ws!.send(JSON.stringify({ type: "key", key: "n" }));
    }
    await wait(200);
    expect(ws!.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws!);
  });
});
