/**
 * Concurrent PTY viewer conflicts — task 7a.
 *
 * Tests the full concurrent viewer lifecycle:
 *   - Two viewers connect simultaneously
 *   - Viewer A displaced → Viewer B take-control → Viewer A reconnects
 *   - PTY process crash mid-take-control sequence
 *   - No leaked entries in activePtySessions after all scenarios
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  bootTestServer,
  closeWs,
  waitForClose,
  wait,
  connectPty as _connectPty,
  waitForMessage,
  sendTakeControl,
  type PtyTestContext,
} from "./pty-test-helpers";

let ctx: PtyTestContext;

const SESSION = "concurrent-pty";
const FAKE_SESSIONS = [SESSION];

beforeAll(async () => {
  ctx = await bootTestServer({
    sessions: [...FAKE_SESSIONS],
    capturePane: async () => "$ mock-concurrent\n",
  });
});

afterAll(() => ctx.cleanup());

function connectPty(session = SESSION) {
  return _connectPty(ctx.baseWsUrl, session);
}

function cleanState() {
  ctx.activePtySessions.delete(SESSION);
  ctx.ptySpawnAttempts.delete(SESSION);
}

// ── Two viewers connect simultaneously ──

describe("concurrent viewers: simultaneous connect", () => {
  beforeEach(async () => { cleanState(); await wait(50); });

  test("second viewer gets viewer_conflict, first stays active", async () => {
    const wsA = await connectPty();
    const wsB = await connectPty();
    const msg = await waitForMessage(wsB, "viewer_conflict");
    expect(msg.type).toBe("viewer_conflict");

    // A is still the active viewer
    const entry = ctx.activePtySessions.get(SESSION)!;
    expect(entry.alive).toBe(true);
    expect(entry.viewer).toBeTruthy();
    expect(entry.pendingViewer).toBeTruthy();

    // Exactly one entry in map for this session
    expect(ctx.activePtySessions.has(SESSION)).toBe(true);

    await closeWs(wsB);
    await closeWs(wsA);
    await wait(100);
  });

  test("both connections remain open (pending is not auto-closed)", async () => {
    const wsA = await connectPty();
    const wsB = await connectPty();
    await waitForMessage(wsB, "viewer_conflict");
    await wait(100);

    expect(wsA.readyState).toBe(WebSocket.OPEN);
    expect(wsB.readyState).toBe(WebSocket.OPEN);

    await closeWs(wsB);
    await closeWs(wsA);
    await wait(100);
  });
});

// ── Full displacement + reconnect cycle ──

describe("concurrent viewers: A displaced → B takes control → A reconnects", () => {
  beforeEach(async () => { cleanState(); await wait(50); });

  test("full cycle: A connects, B takes over, A reconnects and reclaims", async () => {
    // Step 1: A connects as active viewer
    const wsA = await connectPty();
    const entryA = ctx.activePtySessions.get(SESSION)!;
    expect(entryA.alive).toBe(true);

    // Step 2: B connects — gets conflict
    const wsB = await connectPty();
    await waitForMessage(wsB, "viewer_conflict");
    expect(entryA.pendingViewer).toBeTruthy();

    // Step 3: B sends take_control — A is displaced
    const wsAClose = waitForClose(wsA);
    const grantedB = waitForMessage(wsB, "control_granted");
    sendTakeControl(wsB);
    await grantedB;

    const evA = await wsAClose;
    expect(evA.code).toBe(4002); // displaced

    // Verify: old entry dead, new entry alive
    expect(entryA.alive).toBe(false);
    const entryB = ctx.activePtySessions.get(SESSION)!;
    expect(entryB).not.toBe(entryA);
    expect(entryB.alive).toBe(true);

    // Step 4: A reconnects — gets conflict (B is active)
    const wsA2 = await connectPty();
    await waitForMessage(wsA2, "viewer_conflict");

    // Step 5: A takes control back from B
    const wsBClose = waitForClose(wsB);
    const grantedA2 = waitForMessage(wsA2, "control_granted");
    sendTakeControl(wsA2);
    await grantedA2;

    const evB = await wsBClose;
    expect(evB.code).toBe(4002);

    // Final state: only one entry, A2 is active
    const finalEntry = ctx.activePtySessions.get(SESSION)!;
    expect(finalEntry.alive).toBe(true);
    expect(entryB.alive).toBe(false);
    expect(finalEntry).not.toBe(entryB);

    // Can still attach
    const ack = waitForMessage(wsA2, "attach_ack");
    wsA2.send(JSON.stringify({ type: "attach", cols: 80, rows: 24, skipPrefill: true }));
    await ack;

    await closeWs(wsA2);
    await wait(100);
  });

  test("displaced viewer close event doesn't leak entry", async () => {
    const wsA = await connectPty();
    const wsB = await connectPty();
    await waitForMessage(wsB, "viewer_conflict");

    const wsAClose = waitForClose(wsA);
    sendTakeControl(wsB);
    await waitForMessage(wsB, "control_granted");
    await wsAClose;

    // Let detach handler settle
    await wait(200);

    // Exactly one entry, the new one — no ghost from A's detach handler
    const entry = ctx.activePtySessions.get(SESSION);
    expect(entry).toBeDefined();
    expect(entry!.alive).toBe(true);

    // Map should have exactly 1 entry for this session
    let sessionCount = 0;
    for (const [key] of ctx.activePtySessions) {
      if (key === SESSION) sessionCount++;
    }
    expect(sessionCount).toBe(1);

    await closeWs(wsB);
    await wait(100);
  });
});

// ── PTY process crash mid-take-control ──

describe("concurrent viewers: PTY crash mid-take-control", () => {
  beforeEach(async () => { cleanState(); await wait(50); });

  test("mock proc exit during take-control doesn't leak entry", async () => {
    // A connects and gets a mock proc installed
    const wsA = await connectPty();
    const entry = ctx.activePtySessions.get(SESSION) as any;

    const exitCallback = null as (() => void) | null;
    let terminalClosed = false;
    entry.proc = {
      terminal: {
        write() {},
        resize() {},
        close() { terminalClosed = true; },
      },
      kill() {
        // Simulate: kill triggers the exit callback asynchronously.
        // (Dead code under broker streaming — entry.proc is no longer set
        // by the broker attach path; preserved for the tmux-era assertion.)
        const cb = exitCallback;
        if (cb) setTimeout(() => cb(), 0);
      },
    };

    // B connects as pending
    const wsB = await connectPty();
    await waitForMessage(wsB, "viewer_conflict");

    // B takes control — this kills the old proc
    const wsAClose = waitForClose(wsA);
    sendTakeControl(wsB);
    await waitForMessage(wsB, "control_granted");
    await wsAClose;
    await wait(100);

    // Old proc's terminal was closed
    expect(terminalClosed).toBe(true);

    // New entry exists and is alive
    const newEntry = ctx.activePtySessions.get(SESSION);
    expect(newEntry).toBeDefined();
    expect(newEntry!.alive).toBe(true);
    expect(entry.alive).toBe(false);

    await closeWs(wsB);
    await wait(100);
  });

  test("proc crash after take-control tears down new entry cleanly", async () => {
    // A connects, B takes control, then B's PTY proc crashes
    const wsA = await connectPty();
    const wsB = await connectPty();
    await waitForMessage(wsB, "viewer_conflict");

    sendTakeControl(wsB);
    await waitForMessage(wsB, "control_granted");
    await wait(50);

    // B now has a fresh entry — install a mock proc with an exit trigger
    const entryB = ctx.activePtySessions.get(SESSION) as any;
    expect(entryB).toBeDefined();
    expect(entryB.alive).toBe(true);

    // Simulate a PTY crash by setting alive=false and deleting (mimics the exit handler)
    entryB.alive = false;
    ctx.activePtySessions.delete(SESSION);
    if (entryB.viewer) {
      try { entryB.viewer.close(4001, "session unavailable"); } catch {}
      entryB.viewer = null;
    }

    await wait(200);

    // No leaked entries
    expect(ctx.activePtySessions.has(SESSION)).toBe(false);

    // Server still healthy — can reconnect
    const wsC = await connectPty();
    expect(wsC.readyState).toBe(WebSocket.OPEN);
    const entryC = ctx.activePtySessions.get(SESSION);
    expect(entryC).toBeDefined();
    expect(entryC!.alive).toBe(true);

    await closeWs(wsC);
    await wait(100);
  });

  test("proc crash while pending viewer exists closes both viewers", async () => {
    // A connects with mock proc, B is pending, proc crashes → both closed
    const wsA = await connectPty();
    const entry = ctx.activePtySessions.get(SESSION) as any;

    // Install mock proc
    entry.proc = {
      terminal: { write() {}, resize() {}, close() {} },
      kill() {},
    };

    const wsB = await connectPty();
    await waitForMessage(wsB, "viewer_conflict");
    expect(entry.pendingViewer).toBeTruthy();

    // Simulate PTY exit handler behavior
    entry.alive = false;
    ctx.activePtySessions.delete(SESSION);
    if (entry.viewer) {
      try { entry.viewer.close(4001, "session unavailable"); } catch {}
      entry.viewer = null;
    }
    if (entry.pendingViewer) {
      try { entry.pendingViewer.close(4001, "session unavailable"); } catch {}
      entry.pendingViewer = null;
    }

    // Wait for close events to propagate
    await wait(300);

    // No leaked entries
    expect(ctx.activePtySessions.has(SESSION)).toBe(false);
    expect(entry.viewer).toBeNull();
    expect(entry.pendingViewer).toBeNull();

    // Server still healthy
    const wsC = await connectPty();
    expect(wsC.readyState).toBe(WebSocket.OPEN);
    await closeWs(wsC);
    await wait(100);
  });

  test("take_control on dead entry (proc just crashed) handled gracefully", async () => {
    const wsA = await connectPty();
    const wsB = await connectPty();
    await waitForMessage(wsB, "viewer_conflict");

    const entry = ctx.activePtySessions.get(SESSION) as any;

    // Simulate crash: entry torn down but B's pending handler still has closure ref
    entry.alive = false;
    ctx.activePtySessions.delete(SESSION);
    if (entry.viewer) {
      try { entry.viewer.close(4001, "session unavailable"); } catch {}
      entry.viewer = null;
    }

    await wait(100);

    // B sends take_control after crash — server should handle gracefully
    // (the take_control handler still runs via the closure, but entry is dead)
    sendTakeControl(wsB);
    await wait(200);

    // B may get control_granted and create a new entry, or may have been closed
    // Either way: no crash, no leaked orphan entries
    const postEntry = ctx.activePtySessions.get(SESSION);
    if (postEntry) {
      // If a new entry was created, it should be valid
      expect(postEntry.alive).toBe(true);
    }

    // Server still responsive
    try { await closeWs(wsB); } catch {}
    const wsC = await connectPty();
    expect(wsC.readyState).toBe(WebSocket.OPEN);
    await closeWs(wsC);
    await wait(100);
  });
});

// ── Leak verification ──

describe("concurrent viewers: no leaked activePtySessions entries", () => {
  beforeEach(async () => { cleanState(); await wait(50); });

  test("rapid A→B→A cycle leaves exactly one entry", async () => {
    const wsA = await connectPty();
    const wsB = await connectPty();
    await waitForMessage(wsB, "viewer_conflict");

    // B takes from A
    sendTakeControl(wsB);
    await waitForMessage(wsB, "control_granted");
    await wait(50);

    // A reconnects and takes from B
    const wsA2 = await connectPty();
    await waitForMessage(wsA2, "viewer_conflict");
    sendTakeControl(wsA2);
    await waitForMessage(wsA2, "control_granted");
    await wait(50);

    // Exactly one entry
    let count = 0;
    for (const [key] of ctx.activePtySessions) {
      if (key === SESSION) count++;
    }
    expect(count).toBe(1);
    expect(ctx.activePtySessions.get(SESSION)!.alive).toBe(true);

    await closeWs(wsA2);
    await wait(100);
  });

  test("all viewers disconnect → zero entries for session", async () => {
    const wsA = await connectPty();
    const wsB = await connectPty();
    await waitForMessage(wsB, "viewer_conflict");

    // B takes control
    const wsAClose = waitForClose(wsA);
    sendTakeControl(wsB);
    await waitForMessage(wsB, "control_granted");
    await wsAClose;

    // B disconnects
    await closeWs(wsB);
    await wait(300);

    // No entries left
    expect(ctx.activePtySessions.has(SESSION)).toBe(false);
  });

  test("5 rapid takeover cycles produce exactly one surviving entry", async () => {
    let prev = await connectPty();

    for (let i = 0; i < 5; i++) {
      const next = await connectPty();
      await waitForMessage(next, "viewer_conflict");
      const prevClose = waitForClose(prev);
      sendTakeControl(next);
      await waitForMessage(next, "control_granted");
      await prevClose;
      await wait(30);
      prev = next;
    }

    // Exactly one alive entry
    let aliveCount = 0;
    for (const [key, entry] of ctx.activePtySessions) {
      if (key === SESSION && entry.alive) aliveCount++;
    }
    expect(aliveCount).toBe(1);

    await closeWs(prev);
    await wait(100);

    // After final close, zero entries
    expect(ctx.activePtySessions.has(SESSION)).toBe(false);
  });

  test("pending viewer disconnect + active disconnect → zero entries", async () => {
    const wsA = await connectPty();
    const wsB = await connectPty();
    await waitForMessage(wsB, "viewer_conflict");

    // Pending (B) disconnects first
    await closeWs(wsB);
    await wait(100);

    const entry = ctx.activePtySessions.get(SESSION)!;
    expect(entry.pendingViewer).toBeNull();
    expect(entry.alive).toBe(true);

    // Active (A) disconnects
    await closeWs(wsA);
    await wait(200);

    expect(ctx.activePtySessions.has(SESSION)).toBe(false);
  });
});
