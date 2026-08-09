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

const BOUNDED_GRID_SCROLLBACK_ROWS = 200;

type Listener = (...args: unknown[]) => void;

class FakeWs {
  frames: (Buffer | string)[] = [];
  readyState = 1; // OPEN
  bufferedAmount = 0;
  closeCode: number | null = null;
  closeReason: string | null = null;
  onSend: ((data: Buffer | string) => void) | null = null;
  private listeners = new Map<string, Listener[]>();

  send(data: Buffer | string): void {
    if (this.readyState !== 1) return;
    if (typeof data === "string") this.frames.push(data);
    else this.frames.push(Buffer.from(data));
    this.onSend?.(data);
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
  prefillCalls: Array<{ name: string; cols?: number; scrollbackLines?: number }> = [];
  writeCalls: Array<{ name: string; data: Uint8Array }> = [];
  resizeDelayMs = 0;
  resizePaused = false;
  resizeResolvers: Array<() => void> = [];
  resizeError: Error | null = null;
  resizeOutput: Uint8Array | null = null;
  prefillSeq: bigint | undefined;
  onResizeComplete: ((cols: number, rows: number) => void) | null = null;
  onLiveSubscribe: ((sinceSeq: bigint | undefined) => void) | null = null;
  onWrite: ((name: string, data: Uint8Array) => void) | null = null;
  subscriptionCount = 0;
  deferSubscriptionReadyAt: number | null = null;
  subscriptionReadyResolvers: Array<() => void> = [];
  deferSubscriptionCleanup = false;
  subscriptionCleanupRequested = false;
  subscriptionCleanupResolvers: Array<() => void> = [];
  physicalSubscriptionActive = false;
  physicalSubscriptionSince: bigint | undefined;
  retainedOutput: Array<{ readonly seq: bigint; readonly data: Uint8Array }> = [];
  retainInputOutput = false;
  nextOutputSeq = 2n;

  // SessionBackend
  async list(): Promise<string[]> { return [...this.alive]; }
  async listSessionFacts(): Promise<Array<{ name: string; alive: boolean }>> { return [...this.alive].map((name) => ({ name, alive: true })); }
  async createSession(): Promise<never> { throw new Error("not implemented in attach tests"); }
  async killSession(name: string): Promise<void> { this.alive.delete(name); }
  async hasSession(name: string): Promise<boolean> { return this.alive.has(name); }
  async capturePane(): Promise<string> { return ""; }
  async resize(name: string, cols: number, rows: number): Promise<void> {
    if (this.resizeDelayMs > 0) await wait(this.resizeDelayMs);
    if (this.resizeError) throw this.resizeError;
    this.resizeCalls.push({ name, cols, rows });
    if (this.resizePaused) {
      await new Promise<void>((resolve) => this.resizeResolvers.push(resolve));
    }
    this.onResizeComplete?.(cols, rows);
    if (this.resizeOutput) this.emitData(name, this.resizeOutput);
  }
  releaseNextResize(): void {
    const resolve = this.resizeResolvers.shift();
    if (!resolve) throw new Error("no paused resize to release");
    resolve();
  }
  releaseNextSubscriptionReady(): void {
    const resolve = this.subscriptionReadyResolvers.shift();
    if (!resolve) throw new Error("no deferred subscription readiness to release");
    resolve();
  }
  releaseSubscriptionCleanup(): void {
    const resolve = this.subscriptionCleanupResolvers.shift();
    if (!resolve) throw new Error("no deferred subscription cleanup to release");
    resolve();
  }
  async send(): Promise<void> {}
  async sendKey(): Promise<void> {}
  sessionDir(): string | undefined { return undefined; }
  async cleanupOrphans(): Promise<void> {}

  // PtyBackendMethods
  isSessionAlive(name: string): boolean { return this.alive.has(name); }
  getSessionPrefill(name: string, cols?: number, options?: { scrollbackLines?: number }): { data: Buffer; seq?: bigint } | Promise<{ data: Buffer; seq?: bigint }> {
    this.prefillCalls.push({ name, cols, scrollbackLines: options?.scrollbackLines });
    const data = this.prefill.get(name) ?? Buffer.alloc(0);
    return { data, seq: this.prefillSeq };
  }
  onSessionData(name: string, cb: (data: Uint8Array) => void, opts: { sinceSeq?: bigint; onSubscribeError: (err: unknown) => void }): (() => void) | null {
    if (!this.alive.has(name)) return null;
    let set = this.dataListeners.get(name);
    if (!set) { set = new Set(); this.dataListeners.set(name, set); }
    set.add(cb);
    const startsPhysicalSubscription = !this.physicalSubscriptionActive;
    if (startsPhysicalSubscription) {
      this.physicalSubscriptionActive = true;
      this.physicalSubscriptionSince = opts.sinceSeq;
    }
    this.subscriptionCount += 1;
    this.onLiveSubscribe?.(opts.sinceSeq);
    if (startsPhysicalSubscription && opts.sinceSeq !== undefined) {
      for (const output of this.retainedOutput) {
        if (output.seq > opts.sinceSeq) cb(output.data);
      }
    }
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const unsubscribe = (() => {
      set!.delete(cb);
      if (this.deferSubscriptionCleanup) {
        this.subscriptionCleanupRequested = true;
        this.subscriptionCleanupResolvers.push(() => {
          this.physicalSubscriptionActive = false;
          this.physicalSubscriptionSince = undefined;
          resolveClosed();
        });
        return;
      }
      this.physicalSubscriptionActive = false;
      this.physicalSubscriptionSince = undefined;
      resolveClosed();
    }) as (() => void) & { ready?: Promise<boolean>; closed?: Promise<void> };
    unsubscribe.ready = this.subscriptionCount === this.deferSubscriptionReadyAt
      ? new Promise<boolean>((resolve) => this.subscriptionReadyResolvers.push(() => resolve(true)))
      : Promise.resolve(true);
    unsubscribe.closed = closed;
    return unsubscribe;
  }
  writeToTerminal(name: string, data: Buffer | string): boolean {
    const src = typeof data === "string" ? Buffer.from(data) : data;
    const copy = new Uint8Array(src.length);
    copy.set(src);
    this.writeCalls.push({ name, data: copy });
    this.onWrite?.(name, copy);
    if (this.retainInputOutput) {
      this.retainedOutput.push({ seq: this.nextOutputSeq++, data: copy });
      this.emitData(name, copy);
    }
    return true;
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

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await wait(5);
  }
}
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
  test("attach establishes probe and forwarding subscriptions before pty_ready", async () => {
    const attachEvents: string[] = [];
    backend.prefill.set(SESSION, Buffer.from("snapshot bytes\n"));
    backend.onLiveSubscribe = () => attachEvents.push("subscribe");
    const ws = new FakeWs();
    ws.onSend = (data) => {
      if (typeof data === "string" && JSON.parse(data).type === "pty_ready") {
        attachEvents.push("pty_ready");
      }
    };
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 100, rows: 30 });
    // Attach flow waits PRE_SNAPSHOT_RESIZE_INITIAL_WAIT_MS=200ms for first
    // resize to settle, then QUIESCE_MIN_WAIT_MS=80ms floor before snapshot,
    // plus broker IO. 350ms covers the whole flow with margin.
    await wait(350);

    expect(ws.jsonFrames()).toContainEqual({ type: "attach_ack", capabilities: ["ordered-resize-ack"] });
    expect(ws.hasJsonType("prefill_viewport")).toBe(false);
    expect(ws.hasJsonType("prefill_done")).toBe(true);
    expect(ws.hasJsonType("pty_ready")).toBe(true);

    const binary = ws.binaryFrames();
    expect(binary.length).toBeGreaterThan(0);
    expect(binary[0].toString()).toContain("snapshot bytes");

    expect(backend.resizeCalls).toEqual([{ name: SESSION, cols: 100, rows: 30 }]);
    expect(backend.dataListeners.get(SESSION)?.size).toBe(1);
    expect(attachEvents).toEqual(["subscribe", "subscribe", "pty_ready"]);
  });

  test("input accepted after attach_ack is forwarded once the replay-backed subscription confirms", async () => {
    const input = Buffer.from("redraw command\n");
    let acceptedInput: Uint8Array | null = null;
    let resolveForwardingSubscribe!: () => void;
    const forwardingSubscribe = new Promise<void>((resolve) => { resolveForwardingSubscribe = resolve; });
    backend.deferSubscriptionReadyAt = 2;
    backend.onWrite = (_name, data) => {
      acceptedInput = data;
      backend.emitData(SESSION, data);
    };
    backend.onLiveSubscribe = () => {
      if (backend.subscriptionCount === 2) resolveForwardingSubscribe();
    };

    const ws = new FakeWs();
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24 });
    expect(ws.jsonFrames()).toContainEqual({ type: "attach_ack", capabilities: ["ordered-resize-ack"] });
    let resolvePtyReady!: () => void;
    let resolveForwardedOutput!: () => void;
    const ptyReady = new Promise<void>((resolve) => { resolvePtyReady = resolve; });
    const forwardedOutput = new Promise<void>((resolve) => { resolveForwardedOutput = resolve; });
    ws.onSend = (data) => {
      if (typeof data === "string" && JSON.parse(data).type === "pty_ready") resolvePtyReady();
      if (Buffer.isBuffer(data) && data.equals(input)) resolveForwardedOutput();
    };
    ws.pushBinary(input);

    await forwardingSubscribe;
    await Promise.resolve();
    expect(backend.writeCalls).toHaveLength(0);
    expect(ws.hasJsonType("pty_ready")).toBe(false);
    backend.releaseNextSubscriptionReady();
    await Promise.all([ptyReady, forwardedOutput]);

    expect(backend.writeCalls).toHaveLength(1);
    expect(ws.binaryFrames().some((frame) => frame.equals(input))).toBe(true);
  });

  test("queued input is discarded when the viewer closes before subscription readiness", async () => {
    const input = Buffer.from("cancel before live subscription");
    backend.deferSubscriptionReadyAt = 2;
    const ws = new FakeWs();
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24 });
    ws.pushBinary(input);

    await waitFor(() => backend.subscriptionCount === 2);
    ws.close();
    backend.releaseNextSubscriptionReady();
    await wait(20);

    expect(backend.writeCalls).toEqual([]);
    expect(ws.hasJsonType("pty_ready")).toBe(false);
  });

  test("queued input is bounded while attach waits for subscription readiness", () => {
    const ws = new FakeWs();
    backend.deferSubscriptionReadyAt = 2;
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24 });

    for (let i = 0; i < 60; i++) ws.pushBinary(Buffer.alloc(16 * 1024));
    ws.pushBinary(Buffer.from([0x61]));

    expect(backend.writeCalls).toEqual([]);
    expect(ws.closeCode).toBe(1008);
    expect(ws.closeReason).toBe("pending input limit exceeded");
  });

  test("output triggered by input after attach_ack replays across the snapshot-to-live boundary", async () => {
    const input = Buffer.from("redraw burst after attach acknowledgement");
    backend.prefillSeq = 1n;
    backend.deferSubscriptionCleanup = true;
    backend.retainInputOutput = true;
    const ws = new FakeWs();
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24 });
    expect(ws.jsonFrames()).toContainEqual({ type: "attach_ack", capabilities: ["ordered-resize-ack"] });
    ws.pushBinary(input);

    await waitFor(() => backend.subscriptionCleanupRequested);
    expect(ws.binaryFrames().some((frame) => frame.equals(input))).toBe(false);
    backend.releaseSubscriptionCleanup();
    await waitFor(() => ws.hasJsonType("pty_ready"));
    await waitFor(() => ws.binaryFrames().some((frame) => frame.equals(input)));

    expect(ws.binaryFrames().some((frame) => frame.equals(input))).toBe(true);
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

  test("binary stdin exceeding the per-viewer byte budget closes the viewer", () => {
    const ws = new FakeWs();
    attachWs(ws);
    const frame = Buffer.alloc(16 * 1024, 0x55);

    for (let i = 0; i < 61; i++) ws.pushBinary(frame);

    expect(backend.writeCalls.length).toBe(60);
    expect(ws.closeCode).toBe(1008);
    expect(ws.closeReason).toBe("input rate limit exceeded");
  });

  for (const prefillMode of ["full", "viewport", "none"] as const) test(`final ${prefillMode} attach reconciliation applies and acknowledges a boundary resize exactly once`, async () => {
    const ws = new FakeWs();
    const events: string[] = [];
    backend.prefill.set(SESSION, Buffer.from("snapshot bytes\n"));
    backend.prefillSeq = 1n;
    backend.resizeDelayMs = 20;
    backend.onResizeComplete = (cols, rows) => events.push(`resize:${cols}x${rows}`);
    ws.onSend = (data) => {
      if (typeof data !== "string") return;
      const frame = JSON.parse(data) as { readonly type?: string; readonly resizeId?: number };
      if (frame.type === "resize_ack") events.push(`ack:${frame.resizeId}`);
    };
    backend.onLiveSubscribe = (sinceSeq) => {
      if (prefillMode === "none" ? sinceSeq !== undefined : sinceSeq === undefined) return;
      backend.onLiveSubscribe = null;
      ws.pushJson({ type: "resize", resizeId: 42, cols: 120, rows: 40 });
    };
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode });
    await wait(500);

    expect(backend.resizeCalls.filter((call) => call.cols === 120 && call.rows === 40)).toHaveLength(1);
    expect(ws.jsonFrames()).toContainEqual({ type: "resize_ack", resizeId: 42, cols: 120, rows: 40 });
    expect(events.indexOf("resize:120x40")).toBeLessThan(events.indexOf("ack:42"));
  });

  for (const prefillMode of ["full", "viewport"] as const) test(`final ${prefillMode} attach acknowledges a forced same-dimension boundary without another backend resize`, async () => {
    const ws = new FakeWs();
    const events: string[] = [];
    backend.prefill.set(SESSION, Buffer.from("snapshot bytes\n"));
    backend.prefillSeq = 1n;
    backend.resizeDelayMs = 20;
    backend.onResizeComplete = (cols, rows) => events.push(`resize:${cols}x${rows}`);
    ws.onSend = (data) => {
      if (typeof data !== "string") return;
      const frame = JSON.parse(data) as { readonly type?: string; readonly resizeId?: number };
      if (frame.type === "resize_ack") events.push(`ack:${frame.resizeId}`);
      if (frame.type === "pty_ready") events.push("pty_ready");
    };
    backend.onLiveSubscribe = (sinceSeq) => {
      if (sinceSeq === undefined) return;
      backend.onLiveSubscribe = null;
      ws.pushJson({ type: "resize", resizeId: 42, cols: 80, rows: 24 });
    };
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode });
    await wait(500);

    expect(backend.resizeCalls).toEqual([{ name: SESSION, cols: 80, rows: 24 }]);
    expect(ws.jsonFrames()).toContainEqual({ type: "resize_ack", resizeId: 42, cols: 80, rows: 24 });
    expect(events.indexOf("resize:80x24")).toBeLessThan(events.indexOf("ack:42"));
    expect(events.indexOf("ack:42")).toBeLessThan(events.indexOf("pty_ready"));
  });

  for (const prefillMode of ["full", "viewport", "none"] as const) test(`failed ${prefillMode} attach resize closes without acknowledgement or readiness`, async () => {
    const ws = new FakeWs();
    backend.resizeError = new Error("broker unavailable");
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode });
    await wait(500);

    expect(ws.closeCode).toBe(1011);
    expect(ws.closeReason).toBe("resize failed");
    expect(ws.hasJsonType("resize_ack")).toBe(false);
    expect(ws.hasJsonType("pty_ready")).toBe(false);
  });

  test("none attach owns boundary and in-flight ordered resizes through the final acknowledgement", async () => {
    const ws = new FakeWs();
    const events: string[] = [];
    backend.resizePaused = true;
    backend.onResizeComplete = (cols, rows) => events.push(`resize:${cols}x${rows}`);
    ws.onSend = (data) => {
      if (typeof data !== "string") return;
      const frame = JSON.parse(data) as { readonly type?: string; readonly resizeId?: number };
      if (frame.type === "resize_ack") events.push(`ack:${frame.resizeId}`);
      if (frame.type === "pty_ready") events.push("pty_ready");
    };
    backend.onLiveSubscribe = () => {
      backend.onLiveSubscribe = null;
      ws.pushJson({ type: "resize", resizeId: 42, cols: 120, rows: 40 });
    };
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode: "none" });

    await wait(20);
    expect(backend.resizeCalls).toEqual([{ name: SESSION, cols: 120, rows: 40 }]);

    ws.pushJson({ type: "resize", resizeId: 43, cols: 132, rows: 50 });
    backend.releaseNextResize();
    await wait(20);
    expect(backend.resizeCalls).toEqual([
      { name: SESSION, cols: 120, rows: 40 },
      { name: SESSION, cols: 132, rows: 50 },
    ]);

    ws.pushJson({ type: "resize", resizeId: 44, cols: 140, rows: 55 });
    backend.releaseNextResize();
    await wait(20);
    expect(backend.resizeCalls).toEqual([
      { name: SESSION, cols: 120, rows: 40 },
      { name: SESSION, cols: 132, rows: 50 },
      { name: SESSION, cols: 140, rows: 55 },
    ]);

    backend.releaseNextResize();
    await wait(120);

    expect(ws.jsonFrames()).not.toContainEqual({ type: "resize_ack", resizeId: 42, cols: 120, rows: 40 });
    expect(ws.jsonFrames()).not.toContainEqual({ type: "resize_ack", resizeId: 43, cols: 132, rows: 50 });
    expect(ws.jsonFrames()).toContainEqual({ type: "resize_ack", resizeId: 44, cols: 140, rows: 55 });
    expect(events.indexOf("resize:140x55")).toBeLessThan(events.indexOf("ack:44"));
    expect(events.indexOf("ack:44")).toBeLessThan(events.indexOf("pty_ready"));
  });

  test("a resize received while the boundary resize awaits becomes the final authoritative dimensions", async () => {
    const ws = new FakeWs();
    const events: string[] = [];
    backend.prefill.set(SESSION, Buffer.from("snapshot bytes\n"));
    backend.prefillSeq = 1n;
    backend.resizeDelayMs = 20;
    backend.onResizeComplete = (cols, rows) => {
      events.push(`resize:${cols}x${rows}`);
      if (cols === 120 && rows === 40) ws.pushJson({ type: "resize", resizeId: 43, cols: 132, rows: 50 });
    };
    ws.onSend = (data) => {
      if (typeof data !== "string") return;
      const frame = JSON.parse(data) as { readonly type?: string; readonly resizeId?: number };
      if (frame.type === "resize_ack") events.push(`ack:${frame.resizeId}`);
    };
    backend.onLiveSubscribe = (sinceSeq) => {
      if (sinceSeq === undefined) return;
      backend.onLiveSubscribe = null;
      ws.pushJson({ type: "resize", resizeId: 42, cols: 120, rows: 40 });
    };
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24 });
    await wait(600);

    expect(backend.resizeCalls.filter((call) => call.cols === 120 && call.rows === 40)).toHaveLength(1);
    expect(backend.resizeCalls.filter((call) => call.cols === 132 && call.rows === 50)).toHaveLength(1);
    expect(ws.jsonFrames()).not.toContainEqual({ type: "resize_ack", resizeId: 42, cols: 120, rows: 40 });
    expect(ws.jsonFrames()).toContainEqual({ type: "resize_ack", resizeId: 43, cols: 132, rows: 50 });
    expect(events.indexOf("resize:132x50")).toBeLessThan(events.indexOf("ack:43"));
  });

  test("resize acknowledgement is emitted only after the broker applies dimensions", async () => {
    const ws = new FakeWs();
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode: "none" });
    await wait(20);
    backend.resizeCalls.length = 0;

    ws.pushJson({ type: "resize", resizeId: 42, cols: 120, rows: 40 });
    expect(ws.hasJsonType("resize_ack")).toBe(false);
    await wait(150);

    expect(backend.resizeCalls).toEqual([{ name: SESSION, cols: 120, rows: 40 }]);
    expect(ws.jsonFrames()).toContainEqual({ type: "resize_ack", resizeId: 42, cols: 120, rows: 40 });
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

  test("post-attach resize rejection closes without acknowledgement or a second readiness frame", async () => {
    const ws = new FakeWs();
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode: "none" });
    await wait(20);
    ws.frames.length = 0;

    backend.resizeError = new Error("broker unavailable");
    ws.pushJson({ type: "resize", resizeId: 42, cols: 132, rows: 50 });
    await wait(150);

    expect(ws.closeCode).toBe(1011);
    expect(ws.closeReason).toBe("resize failed");
    expect(ws.hasJsonType("resize_ack")).toBe(false);
    expect(ws.hasJsonType("pty_ready")).toBe(false);
    expect(activePtySessions.has(SESSION)).toBe(false);
  });

  test("slow viewer is closed before output exceeds its bounded queue", async () => {
    const ws = new FakeWs();
    attachWs(ws);
    ws.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode: "none" });
    await wait(20);
    ws.frames.length = 0;

    ws.bufferedAmount = 1024 * 1024;
    backend.emitData(SESSION, new Uint8Array([0x41, 0x42, 0x43]));
    await wait(25);

    expect(ws.binaryFrames()).toEqual([]);
    expect(ws.closeCode).toBe(1011);
    expect(ws.closeReason).toBe("slow viewer");
    expect(activePtySessions.has(SESSION)).toBe(false);
  });

  test("viewport attach applies initial resize without full desktop settle wait", async () => {
    const ws = new FakeWs();
    attachWs(ws);

    ws.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode: "viewport" });
    // Viewport now pays its 60ms dimension settle plus at least 50ms of
    // redraw quiescence. Keep margin for event-loop scheduling while staying
    // below the full desktop attach budget.
    await wait(220);

    expect(backend.resizeCalls).toEqual([
      { name: SESSION, cols: 80, rows: 24 },
    ]);
    expect(ws.hasJsonType("pty_ready")).toBe(true);
  });

  test("viewport attach requests bounded grid scrollback after the resize redraw", async () => {
    backend.resizeOutput = new Uint8Array(2 * 1024);
    const ws = new FakeWs();
    attachWs(ws);

    ws.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode: "viewport" });
    await wait(95);

    expect(backend.prefillCalls).toEqual([]);
    expect(ws.hasJsonType("pty_ready")).toBe(false);

    await wait(100);
    expect(backend.prefillCalls).toEqual([
      { name: SESSION, cols: 80, scrollbackLines: BOUNDED_GRID_SCROLLBACK_ROWS },
    ]);
    expect(ws.hasJsonType("pty_ready")).toBe(true);
  });

  test("full attach overlaps resize apply with initial settle wait", async () => {
    backend.prefill.set(SESSION, Buffer.from("snapshot bytes\n"));
    const ws = new FakeWs();
    attachWs(ws);

    ws.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode: "full" });
    await wait(80);

    expect(backend.resizeCalls).toEqual([
      { name: SESSION, cols: 80, rows: 24 },
    ]);
    expect(backend.prefillCalls).toEqual([]);

    await wait(180);
    expect(backend.prefillCalls).toEqual([
      { name: SESSION, cols: 80, scrollbackLines: undefined },
    ]);
    expect(ws.hasJsonType("pty_ready")).toBe(true);
  });

  test("full attach accepts matching layout_stable to end resize settle early", async () => {
    backend.prefill.set(SESSION, Buffer.from("snapshot bytes\n"));
    const ws = new FakeWs();
    attachWs(ws);

    ws.pushJson({ type: "attach", cols: 80, rows: 24, prefillMode: "full" });
    ws.pushJson({ type: "layout_stable", cols: 80, rows: 24 });
    await wait(75);

    expect(backend.prefillCalls).toEqual([
      { name: SESSION, cols: 80, scrollbackLines: undefined },
    ]);
    expect(ws.hasJsonType("pty_ready")).toBe(true);
  });

  test("full attach accepts layout_stable after resize and snapshots resized dims early", async () => {
    backend.prefill.set(SESSION, Buffer.from("snapshot bytes\n"));
    const ws = new FakeWs();
    attachWs(ws);

    ws.pushJson({ type: "attach", cols: 159, rows: 47, prefillMode: "full" });
    ws.pushJson({ type: "resize", cols: 126, rows: 47 });
    ws.pushJson({ type: "layout_stable", cols: 126, rows: 47 });
    await wait(75);

    expect(backend.resizeCalls).toEqual([
      { name: SESSION, cols: 159, rows: 47 },
      { name: SESSION, cols: 126, rows: 47 },
    ]);
    expect(backend.prefillCalls).toEqual([
      { name: SESSION, cols: 126, scrollbackLines: undefined },
    ]);
    expect(ws.hasJsonType("pty_ready")).toBe(true);
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
    expect(backend.prefillCalls).toEqual([
      { name: SESSION, cols: 132, scrollbackLines: BOUNDED_GRID_SCROLLBACK_ROWS },
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
