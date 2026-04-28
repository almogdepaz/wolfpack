/**
 * SessionBackend interface — abstraction over tmux vs raw-PTY session management.
 *
 * BackendRouter holds pty/tmux/broker backends simultaneously and routes
 * operations to the correct one based on session ownership. New sessions
 * use the current default backend; existing sessions keep their original
 * backend.
 */
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createLogger, errMsg } from "../log.js";
import { defaultBrokerSocketPath } from "../broker/client.js";
import type { BrokerBackend } from "./broker-backend.js";
import type { EventBody } from "../broker/codec.js";

const log = createLogger("backend");

const BROKER_HANDSHAKE_TIMEOUT_MS = 1000;
const BROKER_CONNECT_TIMEOUT_MS = 1500;

export interface SessionBackend {
  list(): Promise<string[]>;
  createSession(
    name: string,
    cwd: string,
    cmd: string | undefined,
    loadSettings: () => { agentCmd: string },
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

export type BackendType = "pty" | "tmux" | "broker";

export const DEFAULT_BACKEND: BackendType = "pty";

// ── PtyBackend-specific methods needed by websocket.ts ──

/**
 * Lifecycle event delivered to `onSessionLifecycle` subscribers. Currently
 * only "exited" — the broker fires this when a session's child reaps.
 */
export type SessionLifecycleEvent = {
  kind: "exited";
  exitCode?: number;
  signal?: number;
};

export interface PtyBackendMethods {
  onSessionData(name: string, cb: (data: Uint8Array) => void): (() => void) | null;
  writeToTerminal(name: string, data: Buffer | string): void;
  /**
   * Returns ANSI bytes the WS attach handler can stream to prefill the
   * client. Sync for in-process backends (PTY); async for backends that
   * source the prefill from a remote snapshot RPC (broker).
   */
  getSessionPrefill(name: string): Buffer | Promise<Buffer>;
  isSessionAlive(name: string): boolean;
  /**
   * Register a lifecycle callback for a session (currently: exit only).
   * Returns null when the backend cannot resolve the name (e.g. broker
   * cache cold or session unknown). PtyBackend's stub never fires.
   */
  onSessionLifecycle(
    name: string,
    cb: (event: SessionLifecycleEvent) => void,
  ): (() => void) | null;
}

// ── Backend Router ──

function checkTmuxAvailable(): boolean {
  try {
    execSync("tmux -V", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Sync probe: does the broker socket file exist? Cheap; never opens it. */
export function checkBrokerSocketExists(socketPath: string = defaultBrokerSocketPath()): boolean {
  try {
    return existsSync(socketPath);
  } catch {
    return false;
  }
}

export class BackendRouter implements SessionBackend {
  private pty: SessionBackend & PtyBackendMethods;
  private tmux: SessionBackend | null;
  private broker: BrokerBackend | null;
  // Reference to the underlying BrokerClient (typed loose to keep
  // backend.ts free of a hard `BrokerClient` dependency at compile time).
  private brokerClient: { close(): void; isConnected(): boolean; request: (m: string, p?: unknown, o?: { timeoutMs?: number }) => Promise<unknown>; start(): void } | null;
  private brokerSocketPath: string;
  private ownership = new Map<string, BackendType>();
  private _defaultBackend: BackendType;
  private _tmuxAvailable: boolean;
  private _brokerAvailable: boolean;

  constructor(defaultBackend: BackendType) {
    const { PtyBackend } = require("./pty-backend.js");
    this.pty = new PtyBackend();

    this._tmuxAvailable = checkTmuxAvailable();
    if (this._tmuxAvailable) {
      const { TmuxBackend } = require("./tmux-backend.js");
      this.tmux = new TmuxBackend();
    } else {
      this.tmux = null;
    }

    // Broker is only constructed when explicitly requested as the default —
    // even if the socket exists, spinning up a real Unix-socket client and
    // its reconnect loop on every router instantiation (incl. tests) is too
    // costly. Tmux's probe is a fork+exec; broker's would be a live socket.
    this.brokerSocketPath = defaultBrokerSocketPath();
    this.broker = null;
    this.brokerClient = null;
    this._brokerAvailable = false;
    // Skip live broker startup under WOLFPACK_TEST so tests that instantiate
    // a router don't accidentally connect to a real broker socket on the
    // developer's machine. Test code injects its own mock via `__setTestBackend`.
    if (defaultBackend === "broker" && !process.env.WOLFPACK_TEST) {
      if (checkBrokerSocketExists(this.brokerSocketPath)) {
        try {
          this.startBrokerClient();
          this._brokerAvailable = true;
        } catch (e: unknown) {
          log.warn("broker client start failed; falling back to pty", { error: errMsg(e) });
        }
      } else {
        log.warn("broker requested but socket missing; falling back to pty", { socketPath: this.brokerSocketPath });
      }
    }

    // Fall back to pty when the requested backend isn't available.
    if (defaultBackend === "tmux" && !this._tmuxAvailable) {
      this._defaultBackend = "pty";
    } else if (defaultBackend === "broker" && !this._brokerAvailable) {
      this._defaultBackend = "pty";
    } else {
      this._defaultBackend = defaultBackend;
    }
  }

  private startBrokerClient(): void {
    const { BrokerClient } = require("../broker/client.js");
    const { createBrokerBackend } = require("./broker-backend.js");
    const client = new BrokerClient({
      socketPath: this.brokerSocketPath,
      onEvent: (event: EventBody) => {
        this.broker?.ingestEvent(event);
      },
    });
    client.start();
    this.brokerClient = client;
    this.broker = createBrokerBackend(client);
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

  // ── Routing helpers ──

  private backendFor(name: string): SessionBackend {
    const type = this.ownership.get(name);
    if (type === "tmux" && this.tmux) return this.tmux;
    if (type === "broker" && this.broker) return this.broker;
    if (!type) log.debug("no ownership for session, falling back to pty", { session: name });
    return this.pty;
  }

  getBackendForSession(name: string): SessionBackend {
    return this.backendFor(name);
  }

  getBackendTypeForSession(name: string): BackendType {
    const b = this.backendFor(name);
    if (this.tmux && b === this.tmux) return "tmux";
    if (this.broker && b === this.broker) return "broker";
    return "pty";
  }

  // ── Default backend management ──

  getDefaultBackend(): BackendType { return this._defaultBackend; }

  setDefaultBackend(type: BackendType): void {
    if (type === "tmux" && !this._tmuxAvailable) {
      throw new Error("tmux is not available");
    }
    if (type === "broker" && !this._brokerAvailable) {
      throw new Error("broker is not available");
    }
    this._defaultBackend = type;
    log.info("default backend changed", { type });
  }

  isTmuxAvailable(): boolean { return this._tmuxAvailable; }
  isBrokerAvailable(): boolean { return this._brokerAvailable; }
  getBrokerSocketPath(): string { return this.brokerSocketPath; }

  /** Re-probe the broker socket. Starts/stops the client to match. Sync only. */
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
      const orphaned = [...this.ownership.entries()]
        .filter(([, t]) => t === "broker")
        .map(([n]) => n);
      if (orphaned.length > 0) {
        log.warn("broker sessions orphaned (socket disappeared)", { sessions: orphaned });
        for (const name of orphaned) this.ownership.delete(name);
      }
      this.teardownBrokerClient();
      if (this._defaultBackend === "broker") {
        this._defaultBackend = "pty";
        log.warn("broker no longer available, default backend reverted to pty");
      }
    }
    return this._brokerAvailable;
  }

  /**
   * Async handshake probe: waits for the broker connection to come up, then
   * issues `list_sessions` with a tight timeout. On failure, tears the client
   * down and demotes the default backend to pty so subsequent session-creates
   * don't try a dead broker. Returns whether the handshake succeeded.
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
      log.warn("broker handshake: connect timed out; falling back", { socketPath: this.brokerSocketPath });
      this.demoteBroker();
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
        this.demoteBroker();
        return false;
      }
      log.info("broker handshake ok", { socketPath: this.brokerSocketPath });
      return true;
    } catch (e: unknown) {
      log.warn("broker handshake failed; falling back to pty", { error: errMsg(e) });
      this.demoteBroker();
      return false;
    }
  }

  private demoteBroker(): void {
    this.teardownBrokerClient();
    if (this._defaultBackend === "broker") {
      this._defaultBackend = "pty";
    }
  }

  /** Re-check tmux availability (e.g. after install). */
  recheckTmux(): boolean {
    const was = this._tmuxAvailable;
    this._tmuxAvailable = checkTmuxAvailable();
    if (this._tmuxAvailable && !this.tmux) {
      const { TmuxBackend } = require("./tmux-backend.js");
      this.tmux = new TmuxBackend();
      log.info("tmux backend initialized (now available)");
    } else if (!this._tmuxAvailable && this.tmux) {
      // tmux was uninstalled — tear down the stale backend
      // Log orphaned tmux sessions before nulling the backend
      const orphaned = [...this.ownership.entries()]
        .filter(([, t]) => t === "tmux")
        .map(([n]) => n);
      if (orphaned.length > 0) {
        log.warn("tmux sessions orphaned (tmux no longer available)", { sessions: orphaned });
        for (const name of orphaned) this.ownership.delete(name);
      }
      this.tmux = null;
      if (this._defaultBackend === "tmux") {
        this._defaultBackend = "pty";
        log.warn("tmux no longer available, default backend reverted to pty");
      }
    }
    if (was !== this._tmuxAvailable) {
      log.info("tmux availability changed", { available: this._tmuxAvailable });
    }
    return this._tmuxAvailable;
  }

  // ── PtyBackend-specific accessors (for websocket.ts) ──

  getPtyBackend(): SessionBackend & PtyBackendMethods { return this.pty; }

  /** Streaming backend that can serve a `/ws/pty` attach for the given session.
   *  Mirrors `backendFor`'s fallback so it agrees with
   *  `getBackendTypeForSession`. Returns null when the session's backend is
   *  tmux (which uses its own attach path) or unavailable. */
  getStreamingBackendForSession(name: string): (SessionBackend & PtyBackendMethods) | null {
    const b = this.backendFor(name);
    if (this.broker && b === this.broker) return this.broker;
    if (b === this.pty) return this.pty;
    return null;
  }

  // ── Session counts (for daemon stop warning) ──

  async getSessionCounts(): Promise<{ pty: number; tmux: number; broker: number }> {
    const ptySessions = await this.pty.list();
    const tmuxSessions = this.tmux ? await this.tmux.list() : [];
    const brokerSessions = this.broker ? await this.broker.list() : [];
    return { pty: ptySessions.length, tmux: tmuxSessions.length, broker: brokerSessions.length };
  }

  // ── SessionBackend interface ──

  async list(): Promise<string[]> {
    const [ptySessions, tmuxSessions, brokerSessions] = await Promise.all([
      this.pty.list(),
      this.tmux ? this.tmux.list() : Promise.resolve<string[]>([]),
      this.broker ? this.broker.list() : Promise.resolve<string[]>([]),
    ]);

    // Reconcile ownership map. Precedence for same-named sessions:
    //   pty > broker > tmux. PTY is in-process authoritative; broker is
    //   broker-owned authoritative; tmux entries may be stale orphans.
    const all = new Set<string>();
    const ptySet = new Set(ptySessions);
    const brokerSet = new Set(brokerSessions);
    for (const name of ptySessions) {
      all.add(name);
      this.ownership.set(name, "pty");
    }
    for (const name of brokerSessions) {
      all.add(name);
      if (!ptySet.has(name)) this.ownership.set(name, "broker");
    }
    for (const name of tmuxSessions) {
      all.add(name);
      if (!ptySet.has(name) && !brokerSet.has(name)) {
        this.ownership.set(name, "tmux");
      }
    }
    for (const name of this.ownership.keys()) {
      if (!all.has(name)) this.ownership.delete(name);
    }

    return Array.from(all).sort();
  }

  async createSession(
    name: string,
    cwd: string,
    cmd: string | undefined,
    loadSettings: () => { agentCmd: string },
  ): Promise<void> {
    const [ptyList, tmuxList, brokerList] = await Promise.all([
      this.pty.list(),
      this.tmux ? this.tmux.list() : Promise.resolve<string[]>([]),
      this.broker ? this.broker.list() : Promise.resolve<string[]>([]),
    ]);
    if (ptyList.includes(name) || tmuxList.includes(name) || brokerList.includes(name)) {
      const err = new Error(`duplicate session: ${name}`);
      (err as any).code = "DUPLICATE_SESSION";
      throw err;
    }

    let backend: SessionBackend;
    let type: BackendType;
    if (this._defaultBackend === "broker" && this.broker) {
      backend = this.broker;
      type = "broker";
    } else if (this._defaultBackend === "tmux" && this.tmux) {
      backend = this.tmux;
      type = "tmux";
    } else {
      backend = this.pty;
      type = "pty";
    }

    // Set ownership before async create to close TOCTOU window —
    // getBackendTypeForSession() returns correct type during creation.
    // Rolled back on failure.
    this.ownership.set(name, type);
    try {
      await backend.createSession(name, cwd, cmd, loadSettings);
    } catch (e) {
      this.ownership.delete(name);
      throw e;
    }
    log.info("session created via router", { name, backend: type });
  }

  async killSession(name: string): Promise<void> {
    await this.backendFor(name).killSession(name);
    this.ownership.delete(name);
  }

  async hasSession(name: string): Promise<boolean> {
    return this.backendFor(name).hasSession(name);
  }

  async capturePane(name: string): Promise<string> {
    return this.backendFor(name).capturePane(name);
  }

  async capturePaneForTriage(name: string): Promise<string> {
    return this.backendFor(name).capturePaneForTriage(name);
  }

  async resize(name: string, cols: number, rows: number): Promise<void> {
    return this.backendFor(name).resize(name, cols, rows);
  }

  async send(name: string, text: string, noEnter?: boolean): Promise<void> {
    return this.backendFor(name).send(name, text, noEnter);
  }

  async sendKey(name: string, key: string): Promise<void> {
    return this.backendFor(name).sendKey(name, key);
  }

  sessionDir(name: string): string | undefined {
    return this.backendFor(name).sessionDir(name);
  }

  async cleanupOrphans(): Promise<void> {
    await this.pty.cleanupOrphans();
    if (this.tmux) await this.tmux.cleanupOrphans();
    if (this.broker) await this.broker.cleanupOrphans();
  }
}

// ── Module-level singleton ──

let _router: BackendRouter | null = null;
// Test-mode direct backend override — bypasses router for backward compat
let _testBackend: SessionBackend | null = null;
let _testBackendType: BackendType = DEFAULT_BACKEND;

/** Initialize the backend router. Call once at server startup. */
export function initBackend(type?: BackendType): SessionBackend {
  _testBackend = null;
  _router = new BackendRouter(type ?? DEFAULT_BACKEND);
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

/** Get the default backend type (for new sessions). */
export function getBackendType(): BackendType {
  if (_testBackend) return _testBackendType;
  if (!_router) initBackend();
  return _router!.getDefaultBackend();
}

/** Get the backend type that owns a specific session. */
export function getBackendTypeForSession(name: string): BackendType {
  if (_testBackend) return _testBackendType;
  if (!_router) initBackend();
  return _router!.getBackendTypeForSession(name);
}

/** Test-only: reset singleton for test isolation. */
export function __resetBackend(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__resetBackend() is only available in test mode");
  _router = null;
  _testBackend = null;
  _testBackendType = DEFAULT_BACKEND;
}

/** Test-only: inject a custom backend (e.g. MockBackend) as the singleton.
 *  Optionally override the backend type (defaults to "tmux" for backward compat with existing tests).
 *  Also creates a router that wraps the mock so getRouter() works in tests. */
export function __setTestBackend(backend: SessionBackend, type?: BackendType): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__setTestBackend() is only available in test mode");
  _testBackend = backend;
  _testBackendType = type ?? "tmux";
  // Create a router and inject the mock as the matching backend so getRouter() works
  _router = new BackendRouter(type ?? "pty");
  (_router as any).pty = backend;
  (_router as any).tmux = type === "tmux" ? backend : null;
  (_router as any).broker = type === "broker" ? backend : null;
  (_router as any)._defaultBackend = type ?? "pty";
  (_router as any)._tmuxAvailable = type === "tmux";
  (_router as any)._brokerAvailable = type === "broker";
}
