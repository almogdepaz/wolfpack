/**
 * SessionBackend interface — abstraction over the broker daemon.
 *
 * BackendRouter is now a thin shim around BrokerBackend. Earlier revisions
 * supported tmux and an in-process PTY fallback; both have been removed.
 * The broker is mandatory — wolfpack will not start without one.
 */
import { existsSync } from "node:fs";
import { createLogger, errMsg } from "../log.js";
import { defaultBrokerSocketPath } from "../broker/client.js";
import type { BrokerBackend } from "./broker-backend.js";
import type { EventBody } from "../broker/codec.js";
import type { AgentKind, CaptureSessionIdentityInput, PublicSessionIdentity } from "./session-identity.js";

const log = createLogger("backend");

export class DuplicateSessionError extends Error {
  readonly code = "DUPLICATE_SESSION" as const;
  constructor(name: string) {
    super(`duplicate session: ${name}`);
    this.name = "DuplicateSessionError";
  }
}

const BROKER_HANDSHAKE_TIMEOUT_MS = 1000;
const BROKER_CONNECT_TIMEOUT_MS = 1500;
/** How often the recovery watchdog re-probes a broker that previously failed.
 *  5s is short enough to recover well within a session-start attempt timeout
 *  and long enough to avoid hot-looping when the broker is genuinely dead. */
const BROKER_WATCHDOG_INTERVAL_MS = 5000;

export interface SessionBackend {
  list(): Promise<string[]>;
  listIdentities?(): Promise<Record<string, PublicSessionIdentity>>;
  createSession(
    name: string,
    cwd: string,
    cmd: string | undefined,
    loadSettings: () => { agentCmd: string },
    identity?: {
      agentKind?: AgentKind | string;
      externalAgent?: CaptureSessionIdentityInput["externalAgent"];
    },
  ): Promise<void>;
  killSession(name: string): Promise<void>;
  hasSession(name: string): Promise<boolean>;
  capturePane(name: string): Promise<string>;
  capturePaneForTriage(name: string): Promise<string>;
  resize(name: string, cols: number, rows: number): Promise<void>;
  send(name: string, text: string, noEnter?: boolean): Promise<void>;
  sendKey(name: string, key: string): Promise<void>;
  sessionDir(name: string): string | undefined;
  cleanupOrphans(): Promise<void>;
}

// ── Broker streaming/attach methods needed by websocket.ts ──

/**
 * Lifecycle event delivered to `onSessionLifecycle` subscribers.
 *  - `exited`: the broker fires this when a session's child reaps.
 *  - `replay_truncated`: the broker reported `replay_truncated: true` on a
 *    `subscribe` response (ring overrun during the lag window).
 *    Subscribers should force a re-snapshot — in practice the WS layer
 *    closes the viewer with 1011 so the client reconnects and re-prefills
 *    instead of sitting on out-of-sync output.
 */
export type SessionLifecycleEvent =
  | { kind: "exited"; exitCode?: number; signal?: number }
  | { kind: "replay_truncated" };

export interface SessionPrefill {
  data: Buffer;
  /** Broker output-stream seq at snapshot time; undefined for non-broker backends. */
  seq?: bigint;
}

export interface SessionPrefillOptions {
  /** Limit broker scrollback rows before rendering; omit for backend default. */
  scrollbackLines?: number;
}

export interface PtyBackendMethods {
  onSessionData(
    name: string,
    cb: (data: Uint8Array) => void,
    opts: {
      sinceSeq?: bigint;
      /**
       * Async-failure escape hatch. The broker `subscribe` RPC is fire-and-
       * forget from the caller's perspective — a synchronous unsub function
       * is returned immediately. If the RPC later rejects, the backend has
       * unwound its local refcount but the WS layer's reference to the
       * (now dead) callback is still in `entry.unsubscribe`, leaving the
       * viewer connected with no data stream forever. The callback is
       * REQUIRED so callers can't silently regress the dead-viewer fix;
       * pass `() => {}` for fire-and-forget probe paths that don't care
       * about teardown.
       */
      onSubscribeError: (err: unknown) => void;
    },
  ): (() => void) | null;
  writeToTerminal(name: string, data: Buffer | string): void;
  /**
   * Returns prefill bytes + snapshot seq for the WS attach handler.
   * Async because the broker sources prefill from a snapshot RPC.
   */
  getSessionPrefill(name: string, cols?: number, options?: SessionPrefillOptions): SessionPrefill | Promise<SessionPrefill>;
  isSessionAlive(name: string): boolean;
  /**
   * Register a lifecycle callback for a session (currently: exit only).
   * Returns null when the backend cannot resolve the name (e.g. broker
   * cache cold or session unknown).
   */
  onSessionLifecycle(
    name: string,
    cb: (event: SessionLifecycleEvent) => void,
  ): (() => void) | null;
}

// ── Backend Router ──

/** Sync probe: does the broker socket file exist? Cheap; never opens it. */
export function checkBrokerSocketExists(socketPath: string = defaultBrokerSocketPath()): boolean {
  try {
    return existsSync(socketPath);
  } catch {
    return false;
  }
}

export class BackendRouter implements SessionBackend {
  private broker: BrokerBackend | null;
  // Reference to the underlying BrokerClient (typed loose to keep
  // backend.ts free of a hard `BrokerClient` dependency at compile time).
  private brokerClient: { close(): void; isConnected(): boolean; request: (m: string, p?: unknown, o?: { timeoutMs?: number }) => Promise<unknown>; start(): void } | null;
  private brokerSocketPath: string;
  private _brokerAvailable: boolean;
  /** Recovery-watchdog timer handle; null when not running. */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard — a slow handshake must not stack on top of itself. */
  private watchdogInFlight = false;

  constructor() {
    this.brokerSocketPath = defaultBrokerSocketPath();
    this.broker = null;
    this.brokerClient = null;
    this._brokerAvailable = false;
    // Skip live broker startup under WOLFPACK_TEST so tests that instantiate
    // a router don't accidentally connect to a real broker socket on the
    // developer's machine. Test code injects its own mock via `__setTestBackend`.
    if (process.env.WOLFPACK_TEST) return;

    if (!checkBrokerSocketExists(this.brokerSocketPath)) {
      throw new Error(`broker socket missing at ${this.brokerSocketPath}; the broker daemon must be running`);
    }
    this.startBrokerClient();
    this._brokerAvailable = true;
    // Watchdog runs for the lifetime of the router so we recover from a
    // mid-life broker wedge (verifyBrokerHandshake tears the client down,
    // and the next tick brings it back).
    this.startWatchdog();
  }

  private startBrokerClient(): void {
    const { BrokerClient } = require("../broker/client.js");
    const { createBrokerBackend } = require("./broker-backend.js");
    const client = new BrokerClient({
      socketPath: this.brokerSocketPath,
      onEvent: (event: EventBody) => {
        this.broker?.ingestEvent(event);
      },
      // When the broker rings a session out (overrun during a lag window
      // and replay would skip bytes), fan it out to that session's
      // lifecycle subscribers as a `replay_truncated` event. The WS layer
      // turns it into a 1011 close so the client reconnects with a fresh
      // snapshot — closing the stale-prefill gap.
      onReplayTruncated: (sessionId: string) => {
        this.broker?.handleReplayTruncated(sessionId);
      },
      // Surface circuit-breaker trips at warn level so a zombie-broker
      // recovery is visible in the server log. The breaker has already
      // destroyed the socket by the time this fires; reconnect is queued.
      onCircuitBreak: (consecutive: number) => {
        log.warn("broker circuit breaker tripped; forcing reconnect", {
          consecutiveTimeouts: consecutive,
          socketPath: this.brokerSocketPath,
        });
      },
    });
    client.start();
    this.brokerClient = client;
    this.broker = createBrokerBackend(client);
  }

  /**
   * Periodically re-probe the broker when it is marked unavailable so the
   * server self-heals after the daemon comes back. Without this, a wedge
   * that flips `_brokerAvailable` to false at startup or after a circuit-
   * breaker trip keeps the server returning "broker backend unavailable"
   * until the next manual restart — the 8-hour zombie state observed
   * 2026-05-11. See issue #141 for the wedge-itself investigation.
   */
  private startWatchdog(intervalMs: number = BROKER_WATCHDOG_INTERVAL_MS): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      this.watchdogTick().catch((e: unknown) => {
        log.debug("broker watchdog tick failed", { error: errMsg(e) });
      });
    }, intervalMs);
    // Don't keep the event loop alive just for the watchdog; the server's
    // listener is the canonical liveness anchor.
    if (typeof this.watchdogTimer.unref === "function") this.watchdogTimer.unref();
  }

  /** Test-only: drive a single watchdog cycle without waiting for the timer. */
  async _watchdogTickForTest(): Promise<void> {
    if (!process.env.WOLFPACK_TEST) throw new Error("_watchdogTickForTest is test-only");
    await this.watchdogTick();
  }

  /** Test-only: install the watchdog (with optional fast interval). */
  _startWatchdogForTest(intervalMs: number = BROKER_WATCHDOG_INTERVAL_MS): void {
    if (!process.env.WOLFPACK_TEST) throw new Error("_startWatchdogForTest is test-only");
    this.startWatchdog(intervalMs);
  }

  private async watchdogTick(): Promise<void> {
    if (this._brokerAvailable) return;
    if (this.watchdogInFlight) return;
    if (!checkBrokerSocketExists(this.brokerSocketPath)) return;
    this.watchdogInFlight = true;
    try {
      // recheckBroker starts the client if the socket appeared. If the
      // socket was already present (the wedge case: file exists, daemon
      // unresponsive) but `_brokerAvailable` is false because a previous
      // handshake tore the client down, we need to restart the client
      // ourselves so verifyBrokerHandshake has something to probe.
      if (!this.brokerClient) {
        try {
          this.startBrokerClient();
        } catch (e: unknown) {
          log.debug("broker watchdog: client start failed", { error: errMsg(e) });
          this.teardownBrokerClient();
          return;
        }
      }
      const ok = await this.verifyBrokerHandshake();
      if (ok) {
        this._brokerAvailable = true;
        log.info("broker recovered", { socketPath: this.brokerSocketPath });
      }
    } finally {
      this.watchdogInFlight = false;
    }
  }

  private stopWatchdog(): void {
    if (!this.watchdogTimer) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private teardownBrokerClient(): void {
    if (this.brokerClient) {
      try { this.brokerClient.close(); } catch (e: unknown) {
        log.debug("broker client close failed", { error: errMsg(e) });
      }
    }
    this.brokerClient = null;
    this.broker = null;
    this._brokerAvailable = false;
  }

  /** Returns the active broker backend. Throws if the broker is unavailable. */
  private requireBroker(): BrokerBackend {
    if (!this.broker) throw new Error("broker backend unavailable");
    return this.broker;
  }

  isBrokerAvailable(): boolean { return this._brokerAvailable; }
  getBrokerSocketPath(): string { return this.brokerSocketPath; }

  /** Re-probe the broker socket. Starts the client if it appeared.
   *  Disappearance is a fatal condition for the broker session pool —
   *  next operation will surface a 4001 to the client. */
  recheckBroker(): boolean {
    const exists = checkBrokerSocketExists(this.brokerSocketPath);
    if (exists && !this.broker) {
      try {
        this.startBrokerClient();
        this._brokerAvailable = true;
        log.info("broker backend initialized (socket appeared)");
      } catch (e: unknown) {
        log.warn("broker client start failed during recheck", { error: errMsg(e) });
        this.teardownBrokerClient();
      }
    } else if (!exists && this.broker) {
      log.error("broker socket disappeared", { socketPath: this.brokerSocketPath });
      this.teardownBrokerClient();
    }
    return this._brokerAvailable;
  }

  /**
   * Async handshake probe: waits for the broker connection to come up, then
   * issues `list_sessions` with a tight timeout. On failure, tears the client
   * down. Returns whether the handshake succeeded.
   */
  async verifyBrokerHandshake(): Promise<boolean> {
    if (!this.brokerClient) return false;
    const client = this.brokerClient;

    // Wait for socket connect or short timeout. BrokerClient.start() returns
    // immediately; the connect event fires asynchronously.
    const connectDeadline = Date.now() + BROKER_CONNECT_TIMEOUT_MS;
    while (!client.isConnected() && Date.now() < connectDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!client.isConnected()) {
      log.warn("broker handshake: connect timed out", { socketPath: this.brokerSocketPath });
      this.teardownBrokerClient();
      return false;
    }

    try {
      const resp = (await client.request(
        "list_sessions",
        {},
        { timeoutMs: BROKER_HANDSHAKE_TIMEOUT_MS },
      )) as { status?: string; error?: { code?: string; message?: string } };
      if (resp.status !== "ok") {
        log.warn("broker handshake: list_sessions returned error", {
          code: resp.error?.code,
          message: resp.error?.message,
        });
        this.teardownBrokerClient();
        return false;
      }
      log.info("broker handshake ok", { socketPath: this.brokerSocketPath });
      return true;
    } catch (e: unknown) {
      log.warn("broker handshake failed", { error: errMsg(e) });
      this.teardownBrokerClient();
      return false;
    }
  }

  // ── Streaming-backend accessor (for websocket.ts) ──

  /** Streaming backend that can serve a `/ws/pty` attach for the given session. */
  getStreamingBackendForSession(_name: string): (SessionBackend & PtyBackendMethods) | null {
    return this.broker;
  }

  // ── Session counts (for daemon stop warning) ──

  async getSessionCounts(): Promise<{ broker: number }> {
    const sessions = this.broker ? await this.broker.list() : [];
    return { broker: sessions.length };
  }

  // ── SessionBackend interface — all routed to broker ──

  async list(): Promise<string[]> {
    const sessions = this.broker ? await this.broker.list() : [];
    return [...sessions].sort();
  }

  async listIdentities(): Promise<Record<string, PublicSessionIdentity>> {
    if (!this.broker) return {};
    return this.broker.listIdentities();
  }

  async createSession(
    name: string,
    cwd: string,
    cmd: string | undefined,
    loadSettings: () => { agentCmd: string },
    identity?: {
      agentKind?: AgentKind | string;
      externalAgent?: CaptureSessionIdentityInput["externalAgent"];
    },
  ): Promise<void> {
    const broker = this.requireBroker();
    const existing = await broker.list();
    if (existing.includes(name)) {
      throw new DuplicateSessionError(name);
    }
    await broker.createSession(name, cwd, cmd, loadSettings, identity);
    log.info("session created via router", { name, backend: "broker" });
  }

  async killSession(name: string): Promise<void> {
    await this.requireBroker().killSession(name);
  }

  async hasSession(name: string): Promise<boolean> {
    return this.requireBroker().hasSession(name);
  }

  async capturePane(name: string): Promise<string> {
    return this.requireBroker().capturePane(name);
  }

  async capturePaneForTriage(name: string): Promise<string> {
    return this.requireBroker().capturePaneForTriage(name);
  }

  async resize(name: string, cols: number, rows: number): Promise<void> {
    return this.requireBroker().resize(name, cols, rows);
  }

  async send(name: string, text: string, noEnter?: boolean): Promise<void> {
    return this.requireBroker().send(name, text, noEnter);
  }

  async sendKey(name: string, key: string): Promise<void> {
    return this.requireBroker().sendKey(name, key);
  }

  sessionDir(name: string): string | undefined {
    return this.broker?.sessionDir(name);
  }

  async cleanupOrphans(): Promise<void> {
    if (this.broker) await this.broker.cleanupOrphans();
  }

  /** Test-only: inject a backend in place of the broker so getRouter() works
   *  for routes that drill into broker-specific surfaces. Gated on
   *  WOLFPACK_TEST so production callers can't hot-swap the broker. */
  __setBrokerForTest(backend: SessionBackend & Partial<{ ingestEvent: (e: unknown) => void; onSessionLifecycle: (n: string, cb: (e: unknown) => void) => (() => void) | null }>): void {
    if (!process.env.WOLFPACK_TEST) throw new Error("__setBrokerForTest() is only available in test mode");
    // Cast through unknown — the test backends (MockBackend) implement enough
    // of the BrokerBackend surface for streaming-attach paths via duck typing.
    this.broker = backend as unknown as BrokerBackend;
    this._brokerAvailable = true;
  }
}

// ── Module-level singleton ──

let _router: BackendRouter | null = null;
// Test-mode direct backend override — bypasses router for backward compat
let _testBackend: SessionBackend | null = null;

/** Initialize the backend router. Call once at server startup. */
export function initBackend(): SessionBackend {
  _testBackend = null;
  _router = new BackendRouter();
  return _router;
}

/** Get the backend (router in production, direct mock in tests). */
export function getBackend(): SessionBackend {
  if (_testBackend) return _testBackend;
  if (!_router) return initBackend();
  return _router;
}

/** Get the typed router for router-specific methods. */
export function getRouter(): BackendRouter {
  if (!_router) initBackend();
  return _router!;
}

/** Test-only: reset singleton for test isolation. */
export function __resetBackend(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__resetBackend() is only available in test mode");
  _router = null;
  _testBackend = null;
}

/** Test-only: inject a custom backend (e.g. MockBackend) as the singleton.
 *  Also creates a router that wraps the mock so getRouter() works in tests. */
export function __setTestBackend(backend: SessionBackend): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__setTestBackend() is only available in test mode");
  _testBackend = backend;
  // Construct router (skips broker startup under WOLFPACK_TEST), then inject
  // the mock as the broker backend so getRouter() works.
  _router = new BackendRouter();
  _router.__setBrokerForTest(backend);
}
