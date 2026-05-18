/**
 * MockBackend — SessionBackend implementation for integration tests.
 *
 * Provides a fully controllable backend that can be injected via
 * __setTestBackend(). No real broker daemon needed.
 */
import type { SessionBackend } from "./backend.js";
import { DuplicateSessionError } from "./backend.js";
import { stripAnsi } from "./strip-ansi.js";

export interface MockBackendOptions {
  sessions?: string[];
  capturePane?: (session: string) => Promise<string>;
  /** Hook called inside createSession before adding to set — use to simulate TOCTOU races. */
  onBeforeCreate?: (name: string) => void;
}

export class MockBackend implements SessionBackend {
  private _sessions: Set<string>;
  private _capturePane: (session: string) => Promise<string>;
  private _onBeforeCreate: ((name: string) => void) | null;
  /** Per-session alive override — when set, isSessionAlive() returns this
   *  instead of `_sessions.has(name)`. Used by tests to simulate a session
   *  that's listed (so WS upgrade passes) but whose backing process has
   *  already died (so attachStreamingBackend returns 4001). */
  private _aliveOverride = new Map<string, boolean>();

  /** Last arguments passed to createSession (name, cwd, cmd). */
  lastCreateArgs: { name: string; cwd: string; cmd: string | undefined } | null = null;
  /** Last arguments passed to resize (name, cols, rows). */
  lastResizeArgs: { name: string; cols: number; rows: number } | null = null;

  constructor(opts: MockBackendOptions = {}) {
    this._sessions = new Set(opts.sessions ?? []);
    this._capturePane = opts.capturePane ?? (async () => "");
    this._onBeforeCreate = opts.onBeforeCreate ?? null;
  }

  /** Override the session list at runtime (useful for per-test setup). */
  setSessions(sessions: string[]): void {
    this._sessions = new Set(sessions);
  }

  /** Override capturePane at runtime. */
  setCapturePane(fn: (session: string) => Promise<string>): void {
    this._capturePane = fn;
  }

  async list(): Promise<string[]> {
    return Array.from(this._sessions);
  }

  /** Set hook called inside createSession before adding to set. */
  setOnBeforeCreate(fn: ((name: string) => void) | null): void {
    this._onBeforeCreate = fn;
  }

  async createSession(
    name: string,
    cwd: string,
    cmd: string | undefined,
    _loadSettings: () => { agentCmd: string },
  ): Promise<void> {
    this.lastCreateArgs = { name, cwd, cmd };
    if (this._onBeforeCreate) this._onBeforeCreate(name);
    if (this._sessions.has(name)) {
      throw new DuplicateSessionError(name);
    }
    this._sessions.add(name);
  }

  async killSession(name: string): Promise<void> {
    this._sessions.delete(name);
  }

  async hasSession(name: string): Promise<boolean> {
    return this._sessions.has(name);
  }

  async capturePane(name: string): Promise<string> {
    if (!this._sessions.has(name)) return "";
    return stripAnsi(await this._capturePane(name));
  }

  async capturePaneForTriage(name: string): Promise<string> {
    return this.capturePane(name);
  }

  async resize(name: string, cols: number, rows: number): Promise<void> {
    this.lastResizeArgs = { name, cols, rows };
  }

  async send(): Promise<void> {
    // no-op in mock
  }

  async sendKey(): Promise<void> {
    // no-op in mock
  }

  sessionDir(): string | undefined {
    return undefined;
  }

  async cleanupOrphans(): Promise<void> {
    // no-op in mock
  }

  // ── Streaming attach surface (PtyBackendMethods) ──
  // websocket.ts casts the streaming backend and calls these directly.
  // MockBackend provides no-op/stub versions so WS-attach tests don't crash.

  isSessionAlive(name: string): boolean {
    const override = this._aliveOverride.get(name);
    if (override !== undefined) return override;
    return this._sessions.has(name);
  }

  /** Force isSessionAlive(name) to return `alive`. Pass `null` to clear. */
  setSessionAlive(name: string, alive: boolean | null): void {
    if (alive === null) this._aliveOverride.delete(name);
    else this._aliveOverride.set(name, alive);
  }

  onSessionData(
    _name: string,
    _cb: (data: Uint8Array) => void,
    _opts: { sinceSeq?: bigint; onSubscribeError: (err: unknown) => void },
  ): (() => void) | null {
    // No real data stream — return a no-op unsubscribe
    return () => {};
  }

  writeToTerminal(_name: string, _data: Buffer | string): void {
    // no-op in mock
  }

  getSessionPrefill(_name: string, _cols?: number): { data: Buffer; seq?: bigint } {
    return { data: Buffer.alloc(0) };
  }

  onSessionLifecycle(_name: string, _cb: (event: unknown) => void): (() => void) | null {
    return () => {};
  }
}
