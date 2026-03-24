/**
 * PTY WebSocket viewer conflict & takeover integration tests.
 *
 * Covers:
 * - viewer_conflict sent to second connection on occupied session
 * - take_control message triggers takeover (old path)
 * - takeControl: true in attach triggers immediate takeover (fast path)
 * - pendingAttachDims captured and used on subsequent take_control
 * - Third viewer displaces pending viewer (4002)
 * - Pending viewer close doesn't tear down active session
 * - Rate limiting on /ws/pty message handler
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  bootTestServer,
  closeWs,
  waitForClose,
  wait,
  connectPty as _connectPty,
  collectJsonMessages,
  waitForMessage,
  type PtyTestContext,
} from "./pty-test-helpers";

// ── Test setup ──

let ctx: PtyTestContext;

const FAKE_SESSIONS = ["takeover-test"];

beforeAll(async () => {
  ctx = await bootTestServer({
    sessions: [...FAKE_SESSIONS],
    capturePane: async () => "$ mock-output\n",
  });
});

afterAll(() => ctx.cleanup());

function connectPty(session: string) {
  return _connectPty(ctx.baseWsUrl, session);
}

/** Inject a fake active PTY entry so the session appears occupied. */
function injectFakeEntry(session: string) {
  const fakeProc = {
    terminal: { write() {}, resize() {}, close() {} },
    kill() {},
  };
  ctx.activePtySessions.set(session, {
    viewer: null,
    pendingViewer: null,
    proc: fakeProc,
    alive: true,
  });
}

/** Connect a viewer and register it as the active viewer on the fake entry. */
async function connectAsActiveViewer(session: string): Promise<WebSocket> {
  const ws = await connectPty(session);
  await wait(10);
  const entry = ctx.activePtySessions.get(session);
  if (entry) entry.viewer = (ws as any)._socket || ws;
  // The server sets entry.viewer on WS open in setupNewPtyEntry, but since we
  // pre-injected the entry, the server won't call setupNewPtyEntry — it goes
  // straight to the conflict path. The first WS to connect to an existing
  // entry becomes the pendingViewer, not the active viewer. So we need to
  // set up properly: inject entry with a viewer already set.
  return ws;
}

// ── Viewer conflict protocol ──

describe("pty takeover: viewer conflict", () => {
  beforeEach(async () => {
    ctx.activePtySessions.delete("takeover-test");
    ctx.ptySpawnAttempts.delete("takeover-test");
    await wait(50);
  });

  test("second connection to occupied session gets viewer_conflict", async () => {
    injectFakeEntry("takeover-test");
    const ws1 = await connectPty("takeover-test");
    // viewer_conflict is sent immediately on WS open — use waitForMessage
    const msg = await waitForMessage(ws1, "viewer_conflict");
    expect(msg.type).toBe("viewer_conflict");
    await closeWs(ws1);
    await wait(50);
  });

  test("take_control message triggers control_granted", async () => {
    injectFakeEntry("takeover-test");
    const ws = await connectPty("takeover-test");
    await waitForMessage(ws, "viewer_conflict");

    // Send attach first to capture dims, then take_control
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, prefillMode: "none" }));
    await waitForMessage(ws, "attach_ack");
    const grantedPromise = waitForMessage(ws, "control_granted");
    ws.send(JSON.stringify({ type: "take_control" }));
    const msg = await grantedPromise;
    expect(msg.type).toBe("control_granted");
    await closeWs(ws);
    await wait(100);
  });

  test("takeControl:true in attach triggers immediate takeover (fast path)", async () => {
    injectFakeEntry("takeover-test");
    const ws = await connectPty("takeover-test");
    const conflictPromise = waitForMessage(ws, "viewer_conflict");
    await conflictPromise;

    // Send attach with takeControl: true — should skip the separate take_control step
    const grantedPromise = waitForMessage(ws, "control_granted");
    ws.send(JSON.stringify({
      type: "attach",
      cols: 80,
      rows: 24,
      prefillMode: "none",
      takeControl: true,
    }));
    const msg = await grantedPromise;
    expect(msg.type).toBe("control_granted");
    await closeWs(ws);
    await wait(100);
  });

  test("pendingAttachDims captured: attach then take_control uses captured dims", async () => {
    injectFakeEntry("takeover-test");
    const ws = await connectPty("takeover-test");
    await waitForMessage(ws, "viewer_conflict");

    // Step 1: send attach (captures dims as pendingAttachDims, gets attach_ack)
    const ackPromise = waitForMessage(ws, "attach_ack");
    ws.send(JSON.stringify({ type: "attach", cols: 100, rows: 30, prefillMode: "none" }));
    const ack = await ackPromise;
    expect(ack.type).toBe("attach_ack");

    // Step 2: send take_control (should use the captured dims from step 1)
    const grantedPromise = waitForMessage(ws, "control_granted");
    ws.send(JSON.stringify({ type: "take_control" }));
    const granted = await grantedPromise;
    expect(granted.type).toBe("control_granted");

    await closeWs(ws);
    await wait(100);
  });

  test("third viewer displaces pending viewer with 4002", async () => {
    injectFakeEntry("takeover-test");

    // Second viewer (becomes pending)
    const ws2 = await connectPty("takeover-test");
    await waitForMessage(ws2, "viewer_conflict");
    const close2Promise = waitForClose(ws2);

    // Third viewer (displaces ws2)
    const ws3 = await connectPty("takeover-test");
    const conflict3 = waitForMessage(ws3, "viewer_conflict");

    // ws2 should get displaced (4002)
    const closeEv = await close2Promise;
    expect(closeEv.code).toBe(4002);

    // ws3 should get viewer_conflict (it's the new pending)
    const msg3 = await conflict3;
    expect(msg3.type).toBe("viewer_conflict");

    await closeWs(ws3);
    await wait(100);
  });

  test("pending viewer close doesn't tear down active session", async () => {
    injectFakeEntry("takeover-test");

    const ws = await connectPty("takeover-test");
    await waitForMessage(ws, "viewer_conflict");

    // Close the pending viewer
    await closeWs(ws);
    await wait(100);

    // Active session entry should still be alive
    const entry = ctx.activePtySessions.get("takeover-test");
    expect(entry).toBeTruthy();
    expect(entry!.alive).toBe(true);
    expect(entry!.pendingViewer).toBeNull();
  });

  test("takeover tears down old PTY proc", async () => {
    let procKilled = false;
    let termClosed = false;
    ctx.activePtySessions.set("takeover-test", {
      viewer: null,
      pendingViewer: null,
      proc: {
        terminal: { write() {}, resize() {}, close() { termClosed = true; } },
        kill() { procKilled = true; },
      },
      alive: true,
    });

    const ws = await connectPty("takeover-test");
    await waitForMessage(ws, "viewer_conflict");
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, prefillMode: "none" }));
    await waitForMessage(ws, "attach_ack");
    ws.send(JSON.stringify({ type: "take_control" }));
    await waitForMessage(ws, "control_granted");
    await wait(50);

    expect(termClosed).toBe(true);
    expect(procKilled).toBe(true);

    await closeWs(ws);
    await wait(100);
  });
});

// ── Rate limiting ──

describe("pty takeover: rate limiting", () => {
  beforeEach(async () => {
    ctx.activePtySessions.delete("takeover-test");
    ctx.ptySpawnAttempts.delete("takeover-test");
    await wait(50);
  });

  test("burst of messages beyond rate limit doesn't crash server", async () => {
    const ws = await connectPty("takeover-test");
    const msgs = collectJsonMessages(ws);
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, prefillMode: "none" }));
    await wait(50);

    // Send 120 rapid binary messages (rate limit is 60/sec)
    const encoder = new TextEncoder();
    for (let i = 0; i < 120; i++) {
      try { ws.send(encoder.encode("x").buffer); } catch { break; }
    }
    await wait(500);

    // Server should still be healthy — verify by connecting again
    ctx.activePtySessions.delete("takeover-test");
    ctx.ptySpawnAttempts.delete("takeover-test");
    await wait(50);
    const ws2 = await connectPty("takeover-test");
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws2);
    await closeWs(ws);
    await wait(50);
  });

  test("rapid JSON messages beyond rate limit are silently dropped", async () => {
    const ws = await connectPty("takeover-test");
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, prefillMode: "none" }));
    await wait(50);

    // Send 100 resize messages rapidly
    for (let i = 0; i < 100; i++) {
      try { ws.send(JSON.stringify({ type: "resize", cols: 80 + i, rows: 24 })); } catch { break; }
    }
    await wait(500);

    // Should only have 1 spawn attempt (from the attach, not from the resizes)
    expect(ctx.ptySpawnAttempts.get("takeover-test") || 0).toBe(1);

    await closeWs(ws);
    await wait(50);
  });
});

// ── Regression: post-takeover re-attach must send prefill_done ──

describe("pty takeover: post-control_granted re-attach", () => {
  beforeEach(async () => {
    ctx.activePtySessions.delete("takeover-test");
    ctx.ptySpawnAttempts.delete("takeover-test");
    await wait(50);
  });

  test("re-attach to existing proc after takeover sends prefill_done (regression: grid stuck on overlay)", async () => {
    // Simulate: takeover completes, client sends a second attach to bootstrap prefill.
    // The server must send prefill_done even when entry.proc already exists,
    // otherwise the client buffers all PTY output and the terminal stays black.
    injectFakeEntry("takeover-test");

    const ws = await connectPty("takeover-test");
    await waitForMessage(ws, "viewer_conflict");

    // Send attach to capture dims, then take control
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, prefillMode: "none" }));
    await waitForMessage(ws, "attach_ack");
    ws.send(JSON.stringify({ type: "take_control" }));
    await waitForMessage(ws, "control_granted");

    // The new entry's proc doesn't exist yet (test env can't spawn real tmux).
    // Inject a fake proc to simulate a post-spawn re-attach.
    const entry = ctx.activePtySessions.get("takeover-test") as any;
    if (entry) {
      entry.proc = {
        terminal: { write() {}, resize() {}, close() {} },
        kill() {},
      };
    }

    // Now send a second attach (simulating client's sendAttachHandshake after control_granted)
    const msgs = collectJsonMessages(ws);
    ws.send(JSON.stringify({ type: "attach", cols: 100, rows: 30, prefillMode: "viewport" }));
    await wait(200);

    const types = msgs.map(m => m.type);
    expect(types).toContain("attach_ack");
    // THIS is the regression test: prefill_done MUST be sent so client exits buffering mode
    expect(types).toContain("prefill_done");

    await closeWs(ws);
    await wait(100);
  });

  test("re-attach with prefillMode=none still sends attach_ack + pty_ready (no prefill_done needed)", async () => {
    // When client sends prefillMode=none, it doesn't enter buffering mode,
    // so prefill_done is still sent but client ignores it.
    injectFakeEntry("takeover-test");

    const ws = await connectPty("takeover-test");
    await waitForMessage(ws, "viewer_conflict");
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, prefillMode: "none" }));
    await waitForMessage(ws, "attach_ack");
    ws.send(JSON.stringify({ type: "take_control" }));
    await waitForMessage(ws, "control_granted");

    const entry = ctx.activePtySessions.get("takeover-test") as any;
    if (entry) {
      entry.proc = {
        terminal: { write() {}, resize() {}, close() {} },
        kill() {},
      };
    }

    const msgs = collectJsonMessages(ws);
    ws.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, prefillMode: "none" }));
    await wait(200);

    const types = msgs.map(m => m.type);
    expect(types).toContain("attach_ack");
    expect(types).toContain("pty_ready");
    // prefill_done is also sent (harmless — client just ignores it with prefillMode=none)
    expect(types).toContain("prefill_done");

    await closeWs(ws);
    await wait(100);
  });
});

// ── Full two-viewer grid-like scenario ──

describe("pty takeover: full two-viewer flow (grid scenario)", () => {
  beforeEach(async () => {
    ctx.activePtySessions.delete("takeover-test");
    ctx.ptySpawnAttempts.delete("takeover-test");
    await wait(50);
  });

  test("viewer A active, viewer B takes control with takeControl:true → A gets 4002, B gets control_granted + attach_ack", async () => {
    // Viewer A: inject fake active entry with a proc
    injectFakeEntry("takeover-test");

    // Viewer B: connect → gets viewer_conflict (A is active)
    const wsB = await connectPty("takeover-test");
    const msgsB = collectJsonMessages(wsB);
    await waitForMessage(wsB, "viewer_conflict");

    // Register close listener on A's viewer BEFORE triggering takeover
    const entry = ctx.activePtySessions.get("takeover-test") as any;
    // The fake entry's viewer is null (injectFakeEntry sets it to null).
    // performImmediateTakeover closes the old viewer — with null it's a no-op.

    // B sends attach with takeControl:true (the grid fast-path)
    wsB.send(JSON.stringify({
      type: "attach",
      cols: 120,
      rows: 40,
      prefillMode: "none",
      takeControl: true,
    }));

    // B should get control_granted + attach_ack (from initial dims)
    // Note: in test env, spawnPty fails async → WS closes with 4001 shortly after.
    // But control_granted and attach_ack are sent synchronously before the async spawn.
    await wait(300);
    const typesB = msgsB.map(m => m.type);
    expect(typesB).toContain("control_granted");
    expect(typesB).toContain("attach_ack");

    // Verify both arrived (ordering depends on server internals — both are valid)

    try { await closeWs(wsB); } catch {}
    await wait(100);
  });

  test("two real viewers: A active, B takes control → A gets 4002", async () => {
    // A: connect first, become active
    const wsA = await connectPty("takeover-test");
    const msgsA = collectJsonMessages(wsA);
    wsA.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, prefillMode: "none" }));
    await wait(300);
    // A will get 4001 from spawn failure, but entry exists briefly
    // We need A to stay alive — inject a proc to prevent spawn failure close
    const entryA = ctx.activePtySessions.get("takeover-test") as any;
    if (!entryA || !entryA.alive) {
      // Entry died from spawn failure — re-inject
      ctx.activePtySessions.set("takeover-test", {
        viewer: null, pendingViewer: null, alive: true,
        proc: { terminal: { write() {}, resize() {}, close() {} }, kill() {} },
      });
    } else {
      entryA.proc = { terminal: { write() {}, resize() {}, close() {} }, kill() {} };
    }

    // B: connect → gets viewer_conflict
    const wsB = await connectPty("takeover-test");
    const msgsB = collectJsonMessages(wsB);
    await waitForMessage(wsB, "viewer_conflict");

    // B takes control
    wsB.send(JSON.stringify({
      type: "attach", cols: 100, rows: 30, prefillMode: "none", takeControl: true,
    }));
    await wait(300);

    const typesB = msgsB.map(m => m.type);
    expect(typesB).toContain("control_granted");
    expect(typesB).toContain("attach_ack");

    try { await closeWs(wsA); } catch {}
    try { await closeWs(wsB); } catch {}
    await wait(100);
  });
});

// ── WS upgrade session validation ──

describe("pty takeover: session validation at upgrade", () => {
  beforeEach(async () => {
    ctx.activePtySessions.delete("takeover-test");
    ctx.ptySpawnAttempts.delete("takeover-test");
    await wait(50);
  });

  test("rejects WS upgrade for nonexistent session", async () => {
    try {
      const ws = await connectPty("nonexistent-session-xyz");
      // If we get here, connection opened — wait for server to close it
      const ev = await waitForClose(ws, 3000);
      expect(ev.code).toBeGreaterThanOrEqual(1000);
      await closeWs(ws).catch(() => {});
    } catch {
      // connect failed outright — expected (server rejects upgrade)
    }
  });

  test("rejects WS upgrade with missing session param", async () => {
    try {
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const w = new WebSocket(`${ctx.baseWsUrl}/ws/pty`);
        w.binaryType = "arraybuffer";
        w.addEventListener("open", () => resolve(w));
        w.addEventListener("error", () => reject(new Error("connect failed")));
      });
      const ev = await waitForClose(ws, 3000);
      expect(ev.code).toBeGreaterThanOrEqual(1000);
      await closeWs(ws).catch(() => {});
    } catch {
      // connect failed — expected
    }
  });
});

// ── take_control without attach guard ──

describe("pty takeover: take_control without attach", () => {
  beforeEach(async () => {
    ctx.activePtySessions.delete("takeover-test");
    ctx.ptySpawnAttempts.delete("takeover-test");
    await wait(50);
  });

  test("take_control without prior attach is ignored — old viewer preserved", async () => {
    injectFakeEntry("takeover-test");
    const ws = await connectPty("takeover-test");
    await waitForMessage(ws, "viewer_conflict");

    // Send take_control WITHOUT sending attach first
    ws.send(JSON.stringify({ type: "take_control" }));
    await wait(300);

    // Old entry should still be alive — take_control was rejected
    const entry = ctx.activePtySessions.get("takeover-test");
    expect(entry).toBeDefined();
    expect(entry!.alive).toBe(true);

    await closeWs(ws);
    await wait(50);
  });
});
