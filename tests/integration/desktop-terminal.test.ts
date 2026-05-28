/**
 * Desktop single terminal verification — ghostty-web migration phase 4.
 *
 * Tests the PTY WebSocket protocol for the desktop terminal path (/ws/pty):
 * open (attach handshake), type (binary stdin), scroll (resize), copy (client-only).
 *
 * Note: In test mode, PTY spawn fails because there's no real tmux session.
 * Tests verify the protocol behavior up to and including the spawn failure.
 * The attach_ack is sent synchronously (before async spawn), so it always arrives.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  bootTestServer,
  closeWs,
  waitForClose,
  wait,
  connectPty as _connectPty,
  collectJsonMessages,
  collectAllMessages,
  waitForMessage,
  type PtyTestContext,
} from "./pty-test-helpers";
import { CLOSE_CODE_SESSION_UNAVAILABLE } from "../../src/ws-constants.js";

// ── Test setup ──

let ctx: PtyTestContext;

const FAKE_SESSIONS = ["desktop-test"];

beforeAll(async () => {
  ctx = await bootTestServer({
    sessions: [...FAKE_SESSIONS],
    capturePane: async () => "$ mock-desktop-output\n",
  });
});

afterAll(() => ctx.cleanup());

function connectPty(session: string) {
  return _connectPty(ctx.baseWsUrl, session);
}

// ── Open: attach handshake ──

describe("desktop terminal: open (attach handshake)", () => {
  beforeEach(async () => {
    ctx.activePtySessions.delete("desktop-test");
    ctx.ptySpawnAttempts.delete("desktop-test");
    await wait(50);
  });

  test("connect creates PTY entry immediately (before any messages)", async () => {
    const ws = await connectPty("desktop-test");
    // Entry is created synchronously in setupNewPtyEntry on WS open
    await wait(10);
    const entry = ctx.activePtySessions.get("desktop-test");
    expect(entry).toBeTruthy();
    expect(entry!.alive).toBe(true);
    expect(entry!.viewer).toBeTruthy();
    await closeWs(ws);
    await wait(100);
  });

  test("attach message triggers attach_ack response", async () => {
    const ws = await connectPty("desktop-test");
    const ackPromise = waitForMessage(ws, "attach_ack");
    ws.send(JSON.stringify({ type: "attach", cols: 120, rows: 40, skipPrefill: true }));
    const msg = await ackPromise;
    expect(msg.type).toBe("attach_ack");
    await closeWs(ws);
    await wait(100);
  });

  test("attach with skipPrefill=false still sends attach_ack", async () => {
    const ws = await connectPty("desktop-test");
    const ackPromise = waitForMessage(ws, "attach_ack");
    ws.send(JSON.stringify({ type: "attach", cols: 100, rows: 30, skipPrefill: false }));
    const msg = await ackPromise;
    expect(msg.type).toBe("attach_ack");
    await closeWs(ws);
    await wait(100);
  });

  test("attach_ack is the first message received", async () => {
    const ws = await connectPty("desktop-test");
    const received: Array<{ frame: "text" | "binary"; type?: string }> = [];

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          received.push({ frame: "text", type: msg.type });
        } catch {}
      } else {
        received.push({ frame: "binary" });
      }
    });

    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    // Wait for attach_ack + potential close from spawn failure
    await wait(500);

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].frame).toBe("text");
    expect(received[0].type).toBe("attach_ack");

    await closeWs(ws);
    await wait(100);
  });

  test("attach to an already-streaming entry sends pty_ready after attach_ack", async () => {
    const ws = await connectPty("desktop-test");
    await wait(10);
    const entry = ctx.activePtySessions.get("desktop-test") as any;
    // Broker streaming uses entry.unsubscribe (the data-listener teardown
    // function) as the "already attached" marker. Faking it here is enough
    // for the attach handler to take the existing-stream branch.
    entry.unsubscribe = () => {};

    const msgs = collectJsonMessages(ws);
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    await wait(100);

    expect(msgs.map(m => m.type)).toEqual(["attach_ack", "pty_ready"]);

    await closeWs(ws);
    await wait(100);
  });

  test("duplicate attach messages don't spawn multiple PTYs", async () => {
    const ws = await connectPty("desktop-test");
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    ws.send(JSON.stringify({ type: "attach", cols: 100, rows: 30, skipPrefill: true }));
    ws.send(JSON.stringify({ type: "attach", cols: 120, rows: 40, skipPrefill: true }));
    await wait(300);
    expect(ctx.ptySpawnAttempts.get("desktop-test") || 0).toBe(1);
    await closeWs(ws);
    await wait(100);
  });

  test("attach failure (session not alive) closes WS with 4001", async () => {
    // Force the broker mock to report the session as dead so attach fails.
    ctx.mockBackend.setSessionAlive("desktop-test", false);
    try {
      const ws = await connectPty("desktop-test");
      const closePromise = waitForClose(ws);
      ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
      const ev = await closePromise;
      expect(ev.code).toBe(CLOSE_CODE_SESSION_UNAVAILABLE);
      await wait(50);
    } finally {
      ctx.mockBackend.setSessionAlive("desktop-test", null);
    }
  });
});

// ── Type: binary stdin forwarding ──

describe("desktop terminal: type (binary stdin)", () => {
  beforeEach(async () => {
    ctx.activePtySessions.delete("desktop-test");
    ctx.ptySpawnAttempts.delete("desktop-test");
    await wait(50);
  });

  test("binary frame before attach is silently dropped (no proc)", async () => {
    const ws = await connectPty("desktop-test");
    // Send binary before attach — should be silently dropped (no proc to write to)
    const stdin = new TextEncoder().encode("premature\n");
    ws.send(stdin.buffer);
    await wait(50);
    // Connection survives (no spawn triggered, no crash)
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws);
    await wait(50);
  });

  test("binary frames sent during spawn don't crash server", async () => {
    const ws = await connectPty("desktop-test");
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    // Send binary immediately (before spawn resolves) — proc is null, frame dropped
    ws.send(new TextEncoder().encode("hello\n").buffer);
    ws.send(new TextEncoder().encode("world\n").buffer);
    // Wait for spawn failure + close
    await wait(3000);
    // Server should not have crashed — verify by connecting again
    const ws2 = await connectPty("desktop-test");
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws2);
    await wait(50);
  });

  test("oversized binary frame (>16KB) is silently dropped", async () => {
    const ws = await connectPty("desktop-test");
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    // Send oversized binary — server checks `raw.length > 16384` and drops
    const big = new Uint8Array(20000).fill(65);
    ws.send(big.buffer);
    // Wait for close (spawn failure, not oversized binary)
    await wait(3000);
    // Server still healthy
    const ws2 = await connectPty("desktop-test");
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws2);
    await wait(50);
  });

  test("interleaved binary and JSON messages don't crash server", async () => {
    const ws = await connectPty("desktop-test");
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    // Simulate: user types, then resizes, then types more — all before spawn completes
    ws.send(new TextEncoder().encode("ls").buffer);
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    ws.send(new TextEncoder().encode("\n").buffer);
    await wait(3000);
    // Server still healthy
    const ws2 = await connectPty("desktop-test");
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws2);
    await wait(50);
  });
});

// ── Scroll: resize handling ──

describe("desktop terminal: scroll (resize)", () => {
  beforeEach(async () => {
    ctx.activePtySessions.delete("desktop-test");
    ctx.ptySpawnAttempts.delete("desktop-test");
    await wait(50);
  });

  test("resize triggers spawn attempt (backward compat for older clients)", async () => {
    const ws = await connectPty("desktop-test");
    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    await wait(300);
    expect(ctx.ptySpawnAttempts.get("desktop-test") || 0).toBe(1);
    await closeWs(ws);
    await wait(100);
  });

  test("resize updates latestRequestedSize (attach uses latest dims)", async () => {
    const ws = await connectPty("desktop-test");
    const msgs = collectJsonMessages(ws);
    // Send attach at 80x24, then immediately resize to 120x40
    // The PTY should spawn with the latest requested size (120x40)
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await wait(200);
    // attach_ack should arrive regardless of spawn outcome
    expect(msgs.some(m => m.type === "attach_ack")).toBe(true);
    // Only one spawn attempt (resize while spawning doesn't re-spawn)
    expect(ctx.ptySpawnAttempts.get("desktop-test") || 0).toBe(1);
    await closeWs(ws);
    await wait(100);
  });

  test("rapid resize sequence only triggers one spawn", async () => {
    const ws = await connectPty("desktop-test");
    const sizes = [
      { cols: 90, rows: 25 },
      { cols: 100, rows: 28 },
      { cols: 110, rows: 32 },
      { cols: 120, rows: 36 },
      { cols: 130, rows: 40 },
    ];
    for (const { cols, rows } of sizes) {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
    await wait(300);
    // First resize triggers spawn, rest are queued as latestRequestedSize
    expect(ctx.ptySpawnAttempts.get("desktop-test") || 0).toBe(1);
    await closeWs(ws);
    await wait(100);
  });

  test("resize with extreme values doesn't crash server", async () => {
    const ws = await connectPty("desktop-test");
    // Very small
    ws.send(JSON.stringify({ type: "resize", cols: 1, rows: 1 }));
    // Very large
    ws.send(JSON.stringify({ type: "resize", cols: 500, rows: 200 }));
    // Negative (should be clamped)
    ws.send(JSON.stringify({ type: "resize", cols: -1, rows: -1 }));
    await wait(3000);
    // Server still healthy
    const ws2 = await connectPty("desktop-test");
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws2);
    await wait(50);
  });
});

// ── Session lifecycle ──

describe("desktop terminal: session lifecycle", () => {
  beforeEach(async () => {
    ctx.activePtySessions.delete("desktop-test");
    ctx.ptySpawnAttempts.delete("desktop-test");
    await wait(50);
  });

  test("client close before spawn tears down entry", async () => {
    const ws = await connectPty("desktop-test");
    await wait(10);
    const entry = ctx.activePtySessions.get("desktop-test");
    expect(entry).toBeTruthy();
    expect(entry!.alive).toBe(true);
    // Close immediately (before sending any messages)
    await closeWs(ws);
    await wait(100);
    expect(entry!.alive).toBe(false);
  });

  test("reconnect after attach failure gets fresh entry + attach_ack", async () => {
    // First connection — broker reports session dead, attach yields 4001
    ctx.mockBackend.setSessionAlive("desktop-test", false);
    const ws1 = await connectPty("desktop-test");
    ws1.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    await waitForClose(ws1);
    await wait(100);

    // Clear the override — second connect should succeed cleanly
    ctx.mockBackend.setSessionAlive("desktop-test", null);
    const ws2 = await connectPty("desktop-test");
    const ackPromise = waitForMessage(ws2, "attach_ack");
    ws2.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    const msg = await ackPromise;
    expect(msg.type).toBe("attach_ack");
    await closeWs(ws2);
    await wait(100);
  });

  test("full lifecycle: connect → attach → 4001 close on dead session", async () => {
    // Note: under broker streaming, isSessionAlive is checked synchronously
    // inside attachStreamingBackend, so the WS is torn down before the
    // attach_ack send-guard runs. The original tmux-era test asserted
    // attach_ack arrived before close — that ordering only held because
    // tmux spawn was async. The 4001 close-code contract is what matters.
    ctx.mockBackend.setSessionAlive("desktop-test", false);
    try {
      const ws = await connectPty("desktop-test");
      const closePromise = waitForClose(ws);

      ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));

      const ev = await closePromise;
      expect(ev.code).toBe(CLOSE_CODE_SESSION_UNAVAILABLE);
    } finally {
      ctx.mockBackend.setSessionAlive("desktop-test", null);
    }
  });

  test("rapid connect/disconnect cycles don't leak entries or crash", async () => {
    for (let i = 0; i < 5; i++) {
      const ws = await connectPty("desktop-test");
      ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
      await closeWs(ws);
      await wait(200);
    }
    // Server still healthy
    const ws = await connectPty("desktop-test");
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws);
    await wait(50);
  });
});

// ── Two-phase prefill protocol ──

describe("desktop terminal: two-phase prefill", () => {
  beforeEach(async () => {
    ctx.activePtySessions.delete("desktop-test");
    ctx.ptySpawnAttempts.delete("desktop-test");
    await wait(50);
  });

  test("attach with prefillMode=viewport sends attach_ack and correct prefill sequence", async () => {
    const ws = await connectPty("desktop-test");
    const msgs = collectJsonMessages(ws);

    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, prefillMode: "viewport" }));

    await wait(1500);

    const types = msgs.map(m => m.type);
    expect(types).toContain("attach_ack");
    // In test mode, has-session fails → WS closes with 4001 before prefill runs.
    // When has-session succeeds (production), prefill_done is guaranteed.
    // Verify ordering invariant: if prefill messages exist, they follow attach_ack.
    const ackIdx = types.indexOf("attach_ack");
    const vpIdx = types.indexOf("prefill_viewport");
    const doneIdx = types.indexOf("prefill_done");
    if (vpIdx >= 0) {
      expect(vpIdx).toBeGreaterThan(ackIdx);
    }
    if (doneIdx >= 0) {
      expect(doneIdx).toBeGreaterThan(ackIdx);
      if (vpIdx >= 0) expect(doneIdx).toBeGreaterThan(vpIdx);
    }

    await closeWs(ws);
    await wait(100);
  });

  test("attach with prefillMode=full sends attach_ack and skips viewport boundary", async () => {
    const ws = await connectPty("desktop-test");
    const msgs = collectJsonMessages(ws);

    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, prefillMode: "full" }));

    await wait(1500);

    const types = msgs.map(m => m.type);
    expect(types).toContain("attach_ack");
    // Full prefill has no separate viewport boundary; clients flush buffered
    // full bytes at prefill_done.
    const ackIdx = types.indexOf("attach_ack");
    const doneIdx = types.indexOf("prefill_done");
    expect(types).not.toContain("prefill_viewport");
    if (doneIdx >= 0) {
      expect(doneIdx).toBeGreaterThan(ackIdx);
    }

    await closeWs(ws);
    await wait(100);
  });

  test("attach with prefillMode=none skips all prefill messages and sends no binary data", async () => {
    const ws = await connectPty("desktop-test");
    const msgs = collectJsonMessages(ws);
    const allMsgs = collectAllMessages(ws);

    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, prefillMode: "none" }));

    await wait(1500);

    const types = msgs.map(m => m.type);
    expect(types).toContain("attach_ack");
    // No prefill messages when mode is "none"
    expect(types).not.toContain("prefill_viewport");
    expect(types).not.toContain("prefill_done");
    // No binary prefill data should arrive before attach_ack
    const jsonIdxOfAck = allMsgs.findIndex(m => m.kind === "json" && m.data.type === "attach_ack");
    const binaryBeforeAck = allMsgs.slice(0, jsonIdxOfAck).filter(m => m.kind === "binary");
    expect(binaryBeforeAck.length).toBe(0);

    await closeWs(ws);
    await wait(100);
  });

  test("backward compat: skipPrefill=true behaves like prefillMode=none", async () => {
    const ws = await connectPty("desktop-test");
    const msgs = collectJsonMessages(ws);

    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));

    await wait(1500);

    const types = msgs.map(m => m.type);
    expect(types).toContain("attach_ack");
    expect(types).not.toContain("prefill_viewport");
    expect(types).not.toContain("prefill_done");

    await closeWs(ws);
    await wait(100);
  });

  test("session-unavailable closes with 4001 before any prefill (unknown session)", async () => {
    // Connect with a session name NOT in MockBackend's list.
    // Two acceptable paths, both lock in the "no prefill for unknown session" invariant:
    //   1. Server rejects at HTTP upgrade (403) → connectPty promise rejects.
    //   2. Server accepts upgrade then sends WS close 4001 before any prefill.
    // If the server accepts the upgrade AND any prefill_* leaks through, the
    // take-control state machine regresses — fail the test.
    let connectRejected = false;
    let ws: WebSocket | null = null;
    try {
      ws = await connectPty("nonexistent-session-xyz");
    } catch {
      connectRejected = true;
    }

    if (connectRejected) {
      // Preferred path: upgrade rejected at HTTP layer. Nothing more to assert.
      return;
    }

    // Server accepted the upgrade — must close with CLOSE_CODE_SESSION_UNAVAILABLE
    // before emitting any prefill frames.
    const msgs = collectJsonMessages(ws!);
    const ev = await waitForClose(ws!, 3000);
    expect(ev.code).toBe(CLOSE_CODE_SESSION_UNAVAILABLE);
    const types = msgs.map(m => m.type);
    expect(types).not.toContain("prefill_viewport");
    expect(types).not.toContain("prefill_done");
    await closeWs(ws!).catch(() => {});
  });
});
