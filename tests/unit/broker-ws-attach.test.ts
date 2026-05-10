/**
 * Broker WS attach unit tests.
 *
 * Drives `handlePtyWs` directly with an in-memory FakeWs and a mock
 * BrokerBackend that records resize/writeToTerminal calls and exposes a
 * data-emit hook so we can assert that the snapshot+subscribe attach path
 * (replacing the old broker bail-out) wires the WS to the broker correctly.
 */
process.env.WOLFPACK_TEST = "1";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { WebSocket as WsWebSocket } from "ws";
import {
  __setTestBackend,
  __resetBackend,
  type SessionBackend,
  type PtyBackendMethods,
  type SessionLifecycleEvent,
} from "../../src/server/backend";
import { __getTestState } from "../../src/test-hooks";
import { handlePtyWs, teardownPty } from "../../src/server/websocket";

type Listener = (...args: unknown[]) => void;

class FakeWs {
  frames: (Buffer | string)[] = [];
  readyState = 1; // OPEN
  closeCode: number | null = null;
  closeReason: string | null = null;
  private listeners = new Map<string, Listener[]>();

  send(data: Buffer | string): void {
    if (this.readyState !== 1) return;
    if (typeof data === "string") this.frames.push(data);
    else this.frames.push(Buffer.from(data));
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.closeCode = code ?? 1000;
    this.closeReason = reason ?? "";
    this.readyState = 3;
    this.emit("close", this.closeCode, this.closeReason);
  }
  ping(): void {}
  on(event: string, handler: Listener): void {
    let arr = this.listeners.get(event);
    if (!arr) { arr = []; this.listeners.set(event, arr); }
    arr.push(handler);
  }
  removeListener(event: string, handler: Listener): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(handler);
    if (idx >= 0) arr.splice(idx, 1);
  }
  emit(event: string, ...args: unknown[]): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const h of [...arr]) h(...args);
  }

  // Test helpers
  pushJson(msg: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)), false);
  }
  pushBinary(data: Buffer): void {
    this.emit("message", data, true);
  }
  jsonFrames(): Array<{ type: string; [k: string]: unknown }> {
    const out: Array<{ type: string; [k: string]: unknown }> = [];
    for (const f of this.frames) {
      if (typeof f === "string") {
        try { out.push(JSON.parse(f)); } catch { /* ignore */ }
      }
    }
    return out;
  }
  binaryFrames(): Buffer[] {
    return this.frames.filter((f): f is Buffer => Buffer.isBuffer(f));
  }
  hasJsonType(type: string): boolean {
    return this.jsonFrames().some((m) => m.type === type);
  }
}

class FakeBrokerBackend implements SessionBackend, PtyBackendMethods {
  alive = new Set<string>();
  prefill = new Map<string, Buffer>();
  dataListeners = new Map<string, Set<(data: Uint8Array) => void>>();
  lifecycleListeners = new Map<string, Set<(event: SessionLifecycleEvent) => void>>();
  resizeCalls: Array<{ name: string; cols: number; rows: number }> = [];
  writeCalls: Array<{ name: string; data: Uint8Array }> = [];
  resizeDelayMs = 0;

  // SessionBackend
  async list(): Promise<string[]> { return [...this.alive]; }
  async createSession(): Promise<void> {}
  async killSession(name: string): Promise<void> { this.alive.delete(name); }
  async hasSession(name: string): Promise<boolean> { return this.alive.has(name); }
  async capturePane(): Promise<string> { return ""; }
  async capturePaneForTriage(): Promise<string> { return ""; }
  async resize(name: string, cols: number, rows: number): Promise<void> {
    if (this.resizeDelayMs > 0) await wait(this.resizeDelayMs);
    this.resizeCalls.push({ name, cols, rows });
  }
  async send(): Promise<void> {}
  async sendKey(): Promise<void> {}
  sessionDir(): string | undefined { return undefined; }
  async cleanupOrphans(): Promise<void> {}

  // PtyBackendMethods
  isSessionAlive(name: string): boolean { return this.alive.has(name); }
  getSessionPrefill(name: string): { data: Buffer; seq?: bigint } | Promise<{ data: Buffer; seq?: bigint }> {
    const data = this.prefill.get(name) ?? Buffer.alloc(0);
    return { data };
  }
  onSessionData(name: string, cb: (data: Uint8Array) => void, _opts?: { sinceSeq?: bigint }): (() => void) | null {
    if (!this.alive.has(name)) return null;
    let set = this.dataListeners.get(name);
    if (!set) { set = new Set(); this.dataListeners.set(name, set); }
    set.add(cb);
    return () => { set!.delete(cb); };
  }
  writeToTerminal(name: string, data: Buffer | string): void {
    const src = typeof data === "string" ? Buffer.from(data) : data;
    const copy = new Uint8Array(src.length);
    copy.set(src);
    this.writeCalls.push({ name, data: copy });
  }
  onSessionLifecycle(name: string, cb: (event: SessionLifecycleEvent) => void): (() => void) | null {
    if (!this.alive.has(name)) return null;
    let set = this.lifecycleListeners.get(name);
    if (!set) { set = new Set(); this.lifecycleListeners.set(name, set); }
    set.add(cb);
    return () => { set!.delete(cb); };
  }

  emitData(name: string, data: Uint8Array): void {
    const set = this.dataListeners.get(name);
    if (!set) return;
    for (const cb of [...set]) cb(data);
  }
  emitExit(name: string, exitCode?: number, signal?: number): void {
    this.alive.delete(name);
    const set = this.lifecycleListeners.get(name);
    if (!set) return;
    for (const cb of [...set]) cb({ kind: "exited", exitCode, signal });
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SESSION = "broker-attach-test";
const { activePtySessions } = __getTestState();

let backend: FakeBrokerBackend;

beforeEach(() => {
  backend = new FakeBrokerBackend();
  backend.alive.add(SESSION);
  __setTestBackend(backend);
  activePtySessions.clear();
});

afterEach(() => {
  teardownPty(SESSION);
  activePtySessions.clear();
  __resetBackend();
});

function attachWs(ws: FakeWs, session = SESSION): void {
  handlePtyWs(ws as unknown as WsWebSocket, session);
}

describe("broker WS attach: snapshot + subscribe path", () => {
  test("attach delivers prefill, prefill_done, pty_ready and registers a broker subscribe + resize", async () => {
    backend.prefill.set(SESSION, Buffer.from("snapshot bytes\n"));
    const ws = new FakeWs();
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 100, rows: 30 });
    // Attach flow waits PRE_SNAPSHOT_RESIZE_INITIAL_WAIT_MS=200ms for first
    // resize to settle, then QUIESCE_MIN_WAIT_MS=80ms floor before snapshot,
    // plus broker IO. 350ms covers the whole flow with margin.
    await wait(350);

    expect(ws.hasJsonType("attach_ack")).toBe(true);
    expect(ws.hasJsonType("prefill_viewport")).toBe(true);
    expect(ws.hasJsonType("prefill_done")).toBe(true);
    expect(ws.hasJsonType("pty_ready")).toBe(true);

    const binary = ws.binaryFrames();
    expect(binary.length).toBeGreaterThan(0);
    expect(binary[0].toString()).toContain("snapshot bytes");

    expect(backend.resizeCalls).toEqual([{ name: SESSION, cols: 100, rows: 30 }]);
    expect(backend.dataListeners.get(SESSION)?.size).toBe(1);
  });

  test("subscribed broker output frames are forwarded to viewer", async () => {
    const ws = new FakeWs();
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode: "none" });
    await wait(20);

    // Drop pre-attach JSON frames so we can inspect post-attach binary cleanly.
    ws.frames.length = 0;

    backend.emitData(SESSION, new Uint8Array([0x41, 0x42, 0x43]));
    // Output is coalesced server-side (~16ms flush window) before forwarding,
    // so wait briefly for the flush. See COALESCE_FLUSH_MS in websocket.ts.
    await wait(25);
    const bin = ws.binaryFrames();
    expect(bin.length).toBe(1);
    expect(Array.from(bin[0])).toEqual([0x41, 0x42, 0x43]);
  });

  test("binary stdin forwards to broker.writeToTerminal", () => {
    const ws = new FakeWs();
    attachWs(ws);
    ws.pushBinary(Buffer.from([0x01, 0x02, 0x03]));

    expect(backend.writeCalls.length).toBe(1);
    expect(backend.writeCalls[0].name).toBe(SESSION);
    expect(Array.from(backend.writeCalls[0].data)).toEqual([0x01, 0x02, 0x03]);
  });

  test("oversized binary stdin frames are dropped (cap at 16KB)", () => {
    const ws = new FakeWs();
    attachWs(ws);
    ws.pushBinary(Buffer.alloc(16 * 1024 + 1, 0x55));
    expect(backend.writeCalls.length).toBe(0);
  });

  test("resize after attach calls broker.resize (debounced ~80ms)", async () => {
    const ws = new FakeWs();
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode: "none" });
    await wait(20);
    backend.resizeCalls.length = 0;

    ws.pushJson({ type: "resize", cols: 132, rows: 50 });
    expect(backend.resizeCalls.length).toBe(0); // debounced
    await wait(150);
    expect(backend.resizeCalls).toEqual([{ name: SESSION, cols: 132, rows: 50 }]);
  });

  test("resize during attach uses settled dims for the single backend resize", async () => {
    backend.resizeDelayMs = 30;
    const ws = new FakeWs();
    attachWs(ws);

    ws.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode: "viewport" });
    ws.pushJson({ type: "resize", cols: 132, rows: 50 });
    // PRE_SNAPSHOT_RESIZE_INITIAL_WAIT_MS=200ms settle window absorbs the
    // 132x50 message before any backend.resize fires; the quiescence loop
    // then issues ONE resize at the settled dims. This intentionally avoids
    // the old behavior of resizing twice (which caused two SIGWINCH redraws
    // and the post-attach scrolldown burst).
    await wait(400);

    expect(backend.resizeCalls).toEqual([
      { name: SESSION, cols: 132, rows: 50 },
    ]);
    expect(backend.dataListeners.get(SESSION)?.size).toBe(1);
  });

  test("session-ended teardown: WS closes with 4001 when broker reports session not alive", async () => {
    backend.alive.delete(SESSION);
    const ws = new FakeWs();
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24 });
    await wait(20);

    expect(ws.closeCode).toBe(4001);
    expect(activePtySessions.has(SESSION)).toBe(false);
  });

  test("take-control: pending viewer displaces active viewer; new entry re-attaches via broker", async () => {
    const wsA = new FakeWs();
    attachWs(wsA);
    wsA.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode: "none" });
    // prefillMode:"none" skips the quiescence settle, but PRE_SNAPSHOT_RESIZE_*
    // wait still runs before the (skipped) snapshot. 250ms covers it.
    await wait(250);
    expect(backend.dataListeners.get(SESSION)?.size).toBe(1);

    const wsB = new FakeWs();
    attachWs(wsB);
    expect(wsB.hasJsonType("viewer_conflict")).toBe(true);

    wsB.pushJson({ type: "attach", cols: 100, rows: 30 });
    expect(wsB.hasJsonType("attach_ack")).toBe(true);

    backend.resizeCalls.length = 0;
    wsB.pushJson({ type: "take_control" });
    // performImmediateTakeover spawns a fresh attach which goes through the
    // full settle + quiescence flow before subscribing. 350ms covers the
    // 200ms initial wait + 80ms quiesce floor + broker IO + margin.
    await wait(350);

    expect(wsA.closeCode).toBe(4002); // displaced
    expect(wsB.hasJsonType("control_granted")).toBe(true);

    // Old broker subscription was released and a fresh one was registered for
    // the new viewer entry.
    const subs = backend.dataListeners.get(SESSION);
    expect(subs?.size).toBe(1);

    // New entry resized using the dims captured from the pending attach.
    expect(backend.resizeCalls).toEqual([{ name: SESSION, cols: 100, rows: 30 }]);
  });

  test("synthetic broker session_exited closes viewer with 4001 and clears entry", async () => {
    const ws = new FakeWs();
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode: "none" });
    await wait(20);
    expect(activePtySessions.has(SESSION)).toBe(true);
    expect(backend.lifecycleListeners.get(SESSION)?.size).toBe(1);

    backend.emitExit(SESSION, 0);

    expect(ws.closeCode).toBe(4001);
    expect(ws.closeReason).toBe("session unavailable");
    expect(activePtySessions.has(SESSION)).toBe(false);
    expect(backend.dataListeners.get(SESSION)?.size ?? 0).toBe(0);
  });

  test("synthetic exit closes pendingViewer with 4001 too", async () => {
    const wsA = new FakeWs();
    attachWs(wsA);
    wsA.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode: "none" });
    await wait(20);

    const wsB = new FakeWs();
    attachWs(wsB);
    expect(wsB.hasJsonType("viewer_conflict")).toBe(true);
    wsB.pushJson({ type: "attach", cols: 100, rows: 30 });

    backend.emitExit(SESSION);

    expect(wsA.closeCode).toBe(4001);
    expect(wsB.closeCode).toBe(4001);
    expect(activePtySessions.has(SESSION)).toBe(false);
  });

  test("ws close after attach unsubscribes from broker and removes the session entry", async () => {
    const ws = new FakeWs();
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode: "none" });
    await wait(20);

    expect(backend.dataListeners.get(SESSION)?.size).toBe(1);
    expect(activePtySessions.has(SESSION)).toBe(true);

    ws.close();
    await wait(20);

    expect(activePtySessions.has(SESSION)).toBe(false);
    expect(backend.dataListeners.get(SESSION)?.size ?? 0).toBe(0);
  });
});
