/**
 * SessionBackend interface — abstraction over tmux vs raw-PTY session management.
 *
 * BackendRouter holds both backends simultaneously and routes operations
 * to the correct one based on session ownership. New sessions use the
 * current default backend; existing sessions keep their original backend.
 */
import { execSync } from "node:child_process";
import { createLogger, errMsg } from "../log.js";

const log = createLogger("backend");

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

export type BackendType = "pty" | "tmux";

export const DEFAULT_BACKEND: BackendType = "pty";

// ── PtyBackend-specific methods needed by websocket.ts ──

export interface PtyBackendMethods {
  onSessionData(name: string, cb: (data: Uint8Array) => void): (() => void) | null;
  writeToTerminal(name: string, data: Buffer | string): void;
  getSessionPrefill(name: string): Buffer;
  isSessionAlive(name: string): boolean;
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

export class BackendRouter implements SessionBackend {
  private pty: SessionBackend & PtyBackendMethods;
  private tmux: SessionBackend | null;
  private ownership = new Map<string, BackendType>();
  private _defaultBackend: BackendType;
  private _tmuxAvailable: boolean;

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

    // Fall back to pty if tmux requested but unavailable
    this._defaultBackend = (defaultBackend === "tmux" && !this._tmuxAvailable)
      ? "pty"
      : defaultBackend;
  }

  // ── Routing helpers ──

  private backendFor(name: string): SessionBackend {
    const type = this.ownership.get(name);
    if (type === "tmux" && this.tmux) return this.tmux;
    return this.pty;
  }

  getBackendForSession(name: string): SessionBackend {
    return this.backendFor(name);
  }

  getBackendTypeForSession(name: string): BackendType {
    return this.ownership.get(name) ?? this._defaultBackend;
  }

  // ── Default backend management ──

  getDefaultBackend(): BackendType { return this._defaultBackend; }

  setDefaultBackend(type: BackendType): void {
    if (type === "tmux" && !this._tmuxAvailable) {
      throw new Error("tmux is not available");
    }
    this._defaultBackend = type;
    log.info("default backend changed", { type });
  }

  isTmuxAvailable(): boolean { return this._tmuxAvailable; }

  /** Re-check tmux availability (e.g. after install). */
  recheckTmux(): boolean {
    const was = this._tmuxAvailable;
    this._tmuxAvailable = checkTmuxAvailable();
    if (this._tmuxAvailable && !this.tmux) {
      const { TmuxBackend } = require("./tmux-backend.js");
      this.tmux = new TmuxBackend();
      log.info("tmux backend initialized (now available)");
    }
    if (was !== this._tmuxAvailable) {
      log.info("tmux availability changed", { available: this._tmuxAvailable });
    }
    return this._tmuxAvailable;
  }

  // ── PtyBackend-specific accessors (for websocket.ts) ──

  getPtyBackend(): SessionBackend & PtyBackendMethods { return this.pty; }

  // ── Session counts (for daemon stop warning) ──

  async getSessionCounts(): Promise<{ pty: number; tmux: number }> {
    const ptySessions = await this.pty.list();
    const tmuxSessions = this.tmux ? await this.tmux.list() : [];
    return { pty: ptySessions.length, tmux: tmuxSessions.length };
  }

  // ── SessionBackend interface ──

  async list(): Promise<string[]> {
    const ptySessions = await this.pty.list();
    const tmuxSessions = this.tmux ? await this.tmux.list() : [];

    // Reconcile ownership map
    const all = new Set<string>();
    for (const name of ptySessions) {
      all.add(name);
      this.ownership.set(name, "pty");
    }
    for (const name of tmuxSessions) {
      all.add(name);
      this.ownership.set(name, "tmux");
    }
    // Prune stale entries
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
    // Check uniqueness across both backends
    const [ptyList, tmuxList] = await Promise.all([
      this.pty.list(),
      this.tmux ? this.tmux.list() : [],
    ]);
    if (ptyList.includes(name) || tmuxList.includes(name)) {
      const err = new Error(`duplicate session: ${name}`);
      (err as any).code = "DUPLICATE_SESSION";
      throw err;
    }

    const backend = this._defaultBackend === "tmux" && this.tmux
      ? this.tmux
      : this.pty;
    const type = backend === this.tmux ? "tmux" : "pty";

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
  // Create a router and inject the mock as both backends so getRouter() works
  _router = new BackendRouter(type ?? "pty");
  (_router as any).pty = backend;
  (_router as any).tmux = type === "tmux" ? backend : null;
  (_router as any)._defaultBackend = type ?? "pty";
  (_router as any)._tmuxAvailable = type === "tmux";
}
