/**
 * Desktop grid verification — ghostty-web migration phase 4.
 *
 * Tests multi-session PTY WebSocket behavior for the desktop grid path:
 * 2-6 concurrent cells, session isolation, focus-switching semantics,
 * stdin guard (server-side), and the reset=1 grid remount path.
 *
 * Note: In test mode, PTY spawn fails because there's no real tmux session.
 * Tests verify protocol behavior up to and including spawn failure, plus
 * multi-session concurrency guarantees.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  bootTestServer,
  closeWs,
  waitForClose,
  wait,
  connectPty as _connectPty,
  waitForMessage,
  cleanupSessions,
  type PtyTestContext,
} from "./pty-test-helpers";

// ── Test setup ──

let ctx: PtyTestContext;

const GRID_SESSIONS = ["grid-a", "grid-b", "grid-c", "grid-d", "grid-e", "grid-f"];

beforeAll(async () => {
  ctx = await bootTestServer({
    sessions: [...GRID_SESSIONS],
    capturePane: async () => "$ grid-mock-output\n",
  });
});

afterAll(() => ctx.cleanup());

function connectPty(session: string, opts?: { reset?: boolean }) {
  return _connectPty(ctx.baseWsUrl, session, opts);
}

function cleanup(...names: string[]) {
  cleanupSessions(ctx.activePtySessions, ctx.ptySpawnAttempts, ...names);
}

// ── Multi-session concurrency (2-6 cells) ──

describe("desktop grid: multi-session concurrency", () => {
  beforeEach(async () => {
    cleanup(...GRID_SESSIONS);
    await wait(50);
  });

  test("2 sessions: both get independent PTY entries on connect", async () => {
    const wsA = await connectPty("grid-a");
    const wsB = await connectPty("grid-b");
    await wait(10);

    const entryA = ctx.activePtySessions.get("grid-a");
    const entryB = ctx.activePtySessions.get("grid-b");
    expect(entryA).toBeTruthy();
    expect(entryB).toBeTruthy();
    expect(entryA!.alive).toBe(true);
    expect(entryB!.alive).toBe(true);
    // Entries are distinct objects
    expect(entryA).not.toBe(entryB);

    await closeWs(wsA);
    await closeWs(wsB);
    await wait(100);
  });

  test("2 sessions: both receive independent attach_ack", async () => {
    const wsA = await connectPty("grid-a");
    const wsB = await connectPty("grid-b");

    const ackA = waitForMessage(wsA, "attach_ack");
    const ackB = waitForMessage(wsB, "attach_ack");

    wsA.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));
    wsB.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));

    const [msgA, msgB] = await Promise.all([ackA, ackB]);
    expect(msgA.type).toBe("attach_ack");
    expect(msgB.type).toBe("attach_ack");

    await closeWs(wsA);
    await closeWs(wsB);
    await wait(100);
  });

  test("4 sessions: all get attach_ack concurrently", async () => {
    const sessions = GRID_SESSIONS.slice(0, 4);
    const sockets = await Promise.all(sessions.map(s => connectPty(s)));

    const acks = sockets.map(ws => waitForMessage(ws, "attach_ack"));
    sockets.forEach(ws => {
      ws.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));
    });

    const results = await Promise.all(acks);
    for (const msg of results) {
      expect(msg.type).toBe("attach_ack");
    }

    for (const ws of sockets) await closeWs(ws);
    await wait(100);
  });

  test("6 sessions (max grid): all get independent entries", async () => {
    const sockets = await Promise.all(GRID_SESSIONS.map(s => connectPty(s)));
    await wait(10);

    for (const name of GRID_SESSIONS) {
      const entry = ctx.activePtySessions.get(name);
      expect(entry).toBeTruthy();
      expect(entry!.alive).toBe(true);
    }

    // All entries are distinct
    const entries = GRID_SESSIONS.map(n => ctx.activePtySessions.get(n));
    const unique = new Set(entries);
    expect(unique.size).toBe(6);

    for (const ws of sockets) await closeWs(ws);
    await wait(100);
  });

  test("6 sessions: all receive attach_ack concurrently", async () => {
    const sockets = await Promise.all(GRID_SESSIONS.map(s => connectPty(s)));

    const acks = sockets.map(ws => waitForMessage(ws, "attach_ack"));
    sockets.forEach(ws => {
      ws.send(JSON.stringify({ type: "attach", cols: 40, rows: 15, skipPrefill: true }));
    });

    const results = await Promise.all(acks);
    for (const msg of results) {
      expect(msg.type).toBe("attach_ack");
    }

    // Each session triggered exactly one spawn attempt
    for (const name of GRID_SESSIONS) {
      expect(ctx.ptySpawnAttempts.get(name) || 0).toBe(1);
    }

    for (const ws of sockets) await closeWs(ws);
    await wait(100);
  });
});

// ── Session isolation ──

describe("desktop grid: session isolation", () => {
  beforeEach(async () => {
    cleanup(...GRID_SESSIONS);
    await wait(50);
  });

  test("closing one session doesn't affect another", async () => {
    const wsA = await connectPty("grid-a");
    const wsB = await connectPty("grid-b");
    await wait(10);

    // Close A
    await closeWs(wsA);
    await wait(100);

    // B should still be alive and open
    const entryB = ctx.activePtySessions.get("grid-b");
    expect(entryB).toBeTruthy();
    expect(entryB!.alive).toBe(true);
    expect(wsB.readyState).toBe(WebSocket.OPEN);

    await closeWs(wsB);
    await wait(100);
  });

  test("attach failure on one session doesn't close others", async () => {
    ctx.mockBackend.setSessionAlive("grid-a", false);
    ctx.mockBackend.setSessionAlive("grid-b", false);
    try {
      const wsA = await connectPty("grid-a");
      const wsB = await connectPty("grid-b");

      // Attach both — broker mock reports both dead, both yield 4001 independently.
      wsA.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));
      wsB.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));

      const closeA = waitForClose(wsA);
      const closeB = waitForClose(wsB);

      // Both should independently close with 4001
      const [evA, evB] = await Promise.all([closeA, closeB]);
      expect(evA.code).toBe(4001);
      expect(evB.code).toBe(4001);
    } finally {
      ctx.mockBackend.setSessionAlive("grid-a", null);
      ctx.mockBackend.setSessionAlive("grid-b", null);
    }
  });

  test("binary stdin on one session doesn't crash another", async () => {
    const wsA = await connectPty("grid-a");
    const wsB = await connectPty("grid-b");

    // Attach A only — B stays in pre-attach state
    wsA.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));

    // Send binary to A (dropped — no proc yet), while B is idle
    wsA.send(new TextEncoder().encode("hello\n").buffer);
    await wait(50);

    // B should be unaffected
    expect(wsB.readyState).toBe(WebSocket.OPEN);
    const entryB = ctx.activePtySessions.get("grid-b");
    expect(entryB).toBeTruthy();
    expect(entryB!.alive).toBe(true);

    await closeWs(wsA);
    await closeWs(wsB);
    await wait(100);
  });

  test("rapid connect/disconnect on one session while another stays connected", async () => {
    const wsB = await connectPty("grid-b");
    await wait(10);

    // Rapid cycles on grid-a
    for (let i = 0; i < 3; i++) {
      const wsA = await connectPty("grid-a");
      wsA.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));
      await closeWs(wsA);
      await wait(200);
    }

    // B should still be alive
    expect(wsB.readyState).toBe(WebSocket.OPEN);
    const entryB = ctx.activePtySessions.get("grid-b");
    expect(entryB).toBeTruthy();
    expect(entryB!.alive).toBe(true);

    await closeWs(wsB);
    await wait(100);
  });

  test("each session has independent spawn counters", async () => {
    const wsA = await connectPty("grid-a");
    const wsB = await connectPty("grid-b");
    const wsC = await connectPty("grid-c");

    // Only attach A and C (not B)
    wsA.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));
    wsC.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));
    await wait(300);

    expect(ctx.ptySpawnAttempts.get("grid-a") || 0).toBe(1);
    expect(ctx.ptySpawnAttempts.get("grid-b") || 0).toBe(0);
    expect(ctx.ptySpawnAttempts.get("grid-c") || 0).toBe(1);

    await closeWs(wsA);
    await closeWs(wsB);
    await closeWs(wsC);
    await wait(100);
  });
});

// ── Reset path (grid remount) ──

describe("desktop grid: reset=1 remount path", () => {
  beforeEach(async () => {
    cleanup(...GRID_SESSIONS);
    await wait(50);
  });

  test("reset=1 creates fresh entry even when existing entry is alive", async () => {
    const ws1 = await connectPty("grid-a");
    await wait(10);
    const entry1 = ctx.activePtySessions.get("grid-a");
    expect(entry1).toBeTruthy();
    expect(entry1!.alive).toBe(true);

    // Connect with reset=1 — should tear down old and create fresh
    const ws2 = await connectPty("grid-a", { reset: true });
    await wait(10);
    const entry2 = ctx.activePtySessions.get("grid-a");
    expect(entry2).toBeTruthy();
    expect(entry2!.alive).toBe(true);
    // New entry replaces old
    expect(entry2).not.toBe(entry1);
    expect(entry1!.alive).toBe(false);

    await closeWs(ws1);
    await closeWs(ws2);
    await wait(100);
  });

  test("reset=1 gets attach_ack on the fresh entry", async () => {
    const ws1 = await connectPty("grid-a");
    ws1.send(JSON.stringify({ type: "attach", cols: 120, rows: 40, skipPrefill: true }));
    await wait(200);

    // Reconnect with reset — simulates grid cell remount after single→grid transition
    const ws2 = await connectPty("grid-a", { reset: true });
    const ackPromise = waitForMessage(ws2, "attach_ack");
    ws2.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));
    const msg = await ackPromise;
    expect(msg.type).toBe("attach_ack");

    await closeWs(ws1);
    await closeWs(ws2);
    await wait(100);
  });

  test("reset=1 on one session doesn't affect another", async () => {
    const wsA = await connectPty("grid-a");
    const wsB = await connectPty("grid-b");
    await wait(10);

    const entryB_before = ctx.activePtySessions.get("grid-b");

    // Reset grid-a — grid-b should be unaffected
    const wsA2 = await connectPty("grid-a", { reset: true });
    await wait(10);

    const entryB_after = ctx.activePtySessions.get("grid-b");
    expect(entryB_after).toBe(entryB_before);
    expect(entryB_after!.alive).toBe(true);
    expect(wsB.readyState).toBe(WebSocket.OPEN);

    await closeWs(wsA);
    await closeWs(wsA2);
    await closeWs(wsB);
    await wait(100);
  });

  test("reset=1 without prior entry works like normal connect", async () => {
    // No existing entry for grid-a
    const ws = await connectPty("grid-a", { reset: true });
    await wait(10);
    const entry = ctx.activePtySessions.get("grid-a");
    expect(entry).toBeTruthy();
    expect(entry!.alive).toBe(true);

    const ackPromise = waitForMessage(ws, "attach_ack");
    ws.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));
    const msg = await ackPromise;
    expect(msg.type).toBe("attach_ack");

    await closeWs(ws);
    await wait(100);
  });

  test("reset=1 old viewer close does NOT teardown new entry (race condition guard)", async () => {
    const ws1 = await connectPty("grid-a");
    await wait(10);

    const ws1Close = waitForClose(ws1);

    // Connect with reset=1 — old entry torn down, new entry created
    const ws2 = await connectPty("grid-a", { reset: true });
    await wait(50);

    // Old ws1 should be closed by teardownPty
    const ev = await ws1Close;
    expect(ev.code).toBe(1000);

    // Wait for old close event handlers to fully propagate through detach()
    await wait(300);

    // New entry must still be alive — old detach handler must NOT destroy it
    // (detach() triple-guards: entry.alive && entry.viewer === ws && map.get(session) === entry)
    const entry = ctx.activePtySessions.get("grid-a");
    expect(entry).toBeTruthy();
    expect(entry!.alive).toBe(true);

    await closeWs(ws2);
    await wait(100);
  });

  test("rapid reset=1 cycles don't leak entries", async () => {
    for (let i = 0; i < 5; i++) {
      const ws = await connectPty("grid-a", { reset: true });
      await wait(50);
      await closeWs(ws);
      await wait(100);
    }

    const entry = ctx.activePtySessions.get("grid-a");
    if (entry) {
      expect(entry.alive).toBe(false);
    }
  });
});

// ── Focus switching: server-side resize per cell ──

describe("desktop grid: per-cell resize independence", () => {
  beforeEach(async () => {
    cleanup(...GRID_SESSIONS);
    await wait(50);
  });

  test("different cells can request different dimensions", async () => {
    const wsA = await connectPty("grid-a");
    const wsB = await connectPty("grid-b");

    // Each cell sends its own dimensions (grid cells are smaller than full-screen)
    wsA.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));
    wsB.send(JSON.stringify({ type: "attach", cols: 80, rows: 30, skipPrefill: true }));

    // Both get ack — dimensions are stored per-session
    const [ackA, ackB] = await Promise.all([
      waitForMessage(wsA, "attach_ack"),
      waitForMessage(wsB, "attach_ack"),
    ]);
    expect(ackA.type).toBe("attach_ack");
    expect(ackB.type).toBe("attach_ack");

    await closeWs(wsA);
    await closeWs(wsB);
    await wait(100);
  });

  test("resize on one cell doesn't trigger spawn on another", async () => {
    const wsA = await connectPty("grid-a");
    const wsB = await connectPty("grid-b");

    // Only resize A (backward-compat spawn trigger)
    wsA.send(JSON.stringify({ type: "resize", cols: 60, rows: 20 }));
    await wait(300);

    expect(ctx.ptySpawnAttempts.get("grid-a") || 0).toBe(1);
    expect(ctx.ptySpawnAttempts.get("grid-b") || 0).toBe(0);

    await closeWs(wsA);
    await closeWs(wsB);
    await wait(100);
  });

  test("rapid resizes on multiple cells don't interfere", async () => {
    const wsA = await connectPty("grid-a");
    const wsB = await connectPty("grid-b");
    const wsC = await connectPty("grid-c");

    // Simulate window resize: all cells refit simultaneously
    const sizes = [
      { cols: 55, rows: 18 },
      { cols: 60, rows: 20 },
      { cols: 65, rows: 22 },
    ];

    for (const size of sizes) {
      wsA.send(JSON.stringify({ type: "resize", ...size }));
      wsB.send(JSON.stringify({ type: "resize", ...size }));
      wsC.send(JSON.stringify({ type: "resize", ...size }));
    }
    await wait(300);

    // Each session triggers exactly one spawn (first resize bootstraps)
    expect(ctx.ptySpawnAttempts.get("grid-a") || 0).toBe(1);
    expect(ctx.ptySpawnAttempts.get("grid-b") || 0).toBe(1);
    expect(ctx.ptySpawnAttempts.get("grid-c") || 0).toBe(1);

    await closeWs(wsA);
    await closeWs(wsB);
    await closeWs(wsC);
    await wait(100);
  });
});

// ── Stdin guard: binary frames are session-scoped ──

describe("desktop grid: stdin guard (binary isolation)", () => {
  beforeEach(async () => {
    cleanup(...GRID_SESSIONS);
    await wait(50);
  });

  test("binary frame to one session doesn't crash or affect others", async () => {
    const wsA = await connectPty("grid-a");
    const wsB = await connectPty("grid-b");

    wsA.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));
    wsB.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));

    // Send stdin to A only — B should never receive it
    wsA.send(new TextEncoder().encode("ls -la\n").buffer);
    wsB.send(new TextEncoder().encode("pwd\n").buffer);
    await wait(50);

    // Both sessions handle their own binary frames independently
    // (dropped since proc is null in test mode, but no cross-contamination)
    // Server still healthy
    await wait(3000);
    const ws3 = await connectPty("grid-c");
    expect(ws3.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws3);

    await closeWs(wsA);
    await closeWs(wsB);
    await wait(100);
  });

  test("oversized binary on one cell doesn't affect others", async () => {
    const wsA = await connectPty("grid-a");
    const wsB = await connectPty("grid-b");

    // Only attach A — B stays in pre-attach state (no spawn failure)
    wsA.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));

    // Send oversized binary to A (>16KB, silently dropped)
    const big = new Uint8Array(20000).fill(65);
    wsA.send(big.buffer);
    await wait(50);

    // B is unaffected — still open, still alive
    expect(wsB.readyState).toBe(WebSocket.OPEN);
    const entryB = ctx.activePtySessions.get("grid-b");
    expect(entryB).toBeTruthy();
    expect(entryB!.alive).toBe(true);

    await closeWs(wsA);
    await closeWs(wsB);
    await wait(100);
  });

  test("interleaved JSON and binary across multiple sessions", async () => {
    const wsA = await connectPty("grid-a");
    const wsB = await connectPty("grid-b");

    wsA.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));
    wsB.send(JSON.stringify({ type: "attach", cols: 80, rows: 30, skipPrefill: true }));

    // Interleave: A types, B resizes, A resizes, B types
    wsA.send(new TextEncoder().encode("echo hello").buffer);
    wsB.send(JSON.stringify({ type: "resize", cols: 90, rows: 35 }));
    wsA.send(JSON.stringify({ type: "resize", cols: 70, rows: 25 }));
    wsB.send(new TextEncoder().encode("echo world").buffer);
    await wait(3000);

    // Server still healthy
    const ws3 = await connectPty("grid-c");
    expect(ws3.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws3);

    await closeWs(wsA);
    await closeWs(wsB);
    await wait(100);
  });
});

// ── Grid lifecycle: full add/remove cycle ──

describe("desktop grid: lifecycle (add/remove/exit)", () => {
  beforeEach(async () => {
    cleanup(...GRID_SESSIONS);
    await wait(50);
  });

  test("connect 3 sessions, close middle one, remaining 2 still work", async () => {
    const wsA = await connectPty("grid-a");
    const wsB = await connectPty("grid-b");
    const wsC = await connectPty("grid-c");
    await wait(10);

    // Close middle session
    await closeWs(wsB);
    await wait(100);

    // A and C still alive
    expect(wsA.readyState).toBe(WebSocket.OPEN);
    expect(wsC.readyState).toBe(WebSocket.OPEN);
    expect(ctx.activePtySessions.get("grid-a")?.alive).toBe(true);
    expect(ctx.activePtySessions.get("grid-c")?.alive).toBe(true);

    // A and C can still attach
    const ackA = waitForMessage(wsA, "attach_ack");
    const ackC = waitForMessage(wsC, "attach_ack");
    wsA.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));
    wsC.send(JSON.stringify({ type: "attach", cols: 60, rows: 20, skipPrefill: true }));

    const [msgA, msgC] = await Promise.all([ackA, ackC]);
    expect(msgA.type).toBe("attach_ack");
    expect(msgC.type).toBe("attach_ack");

    await closeWs(wsA);
    await closeWs(wsC);
    await wait(100);
  });

  test("close all sessions in reverse order, server stays healthy", async () => {
    const sessions = GRID_SESSIONS.slice(0, 4);
    const sockets = await Promise.all(sessions.map(s => connectPty(s)));
    await wait(10);

    // Close in reverse
    for (let i = sockets.length - 1; i >= 0; i--) {
      await closeWs(sockets[i]);
      await wait(50);
    }
    await wait(100);

    // Server still healthy — can connect fresh
    const ws = await connectPty("grid-a");
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws);
    await wait(50);
  });

  test("reconnect to same session after close gets fresh entry", async () => {
    const ws1 = await connectPty("grid-a");
    await wait(10);
    const entry1 = ctx.activePtySessions.get("grid-a");
    expect(entry1).toBeTruthy();

    await closeWs(ws1);
    await wait(100);
    expect(entry1!.alive).toBe(false);

    // Reconnect
    const ws2 = await connectPty("grid-a");
    await wait(10);
    const entry2 = ctx.activePtySessions.get("grid-a");
    expect(entry2).toBeTruthy();
    expect(entry2!.alive).toBe(true);
    expect(entry2).not.toBe(entry1);

    await closeWs(ws2);
    await wait(100);
  });
});
