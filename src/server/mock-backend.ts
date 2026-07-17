/**
 * MockBackend — SessionBackend implementation for integration tests.
 *
 * Provides a fully controllable backend that can be injected via
 * __setTestBackend(). No real broker daemon needed.
 */
import type { SessionBackend, SessionLaunchOptions } from "./backend.js";
import { DuplicateSessionError } from "./backend.js";
import { stripAnsi } from "./strip-ansi.js";
import { inferAgentKind } from "./session-identity.js";
import type {
  ParentSessionIdentity,
  PublicSessionIdentity,
} from "./session-identity.js";

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
  private readonly _parentSessions = new Map<string, ParentSessionIdentity>();
  /** Per-session alive override — when set, isSessionAlive() returns this
   *  instead of `_sessions.has(name)`. Used by tests to simulate a session
   *  that's listed (so WS upgrade passes) but whose backing process has
   *  already died (so attachStreamingBackend returns 4001). */
  private _aliveOverride = new Map<string, boolean>();

  /** Last arguments passed to createSession (name, cwd, cmd). */
  lastCreateArgs: {
    name: string;
    cwd: string;
    cmd: string | undefined;
    agentKind?: string;
    parentSession?: ParentSessionIdentity;
    initialPrompt?: string;
  } | null = null;
  /** Last arguments passed to resize (name, cols, rows). */
  lastResizeArgs: { name: string; cols: number; rows: number } | null = null;
  /** Last arguments passed to send (name, text, noEnter). */
  lastSendArgs: { name: string; text: string; noEnter: boolean | undefined } | null = null;
  private readonly _outputSubscribers = new Map<string, Set<(data: Uint8Array) => void>>();
  private readonly _outputHistory = new Map<string, Array<{ seq: bigint; data: Uint8Array }>>();
  private _nextOutputSeq = 1n;
  private _onAfterPrefill: ((name: string, seq: bigint) => void) | null = null;

  constructor(opts: MockBackendOptions = {}) {
    this._sessions = new Set(opts.sessions ?? []);
    this._capturePane = opts.capturePane ?? (async () => "");
    this._onBeforeCreate = opts.onBeforeCreate ?? null;
  }

  /** Override the session list at runtime (useful for per-test setup). */
  setSessions(sessions: string[]): void {
    this._sessions = new Set(sessions);
    for (const name of this._parentSessions.keys()) {
      if (!this._sessions.has(name)) this._parentSessions.delete(name);
    }
  }

  /** Override capturePane at runtime. */
  setCapturePane(fn: (session: string) => Promise<string>): void {
    this._capturePane = fn;
  }

  setOnAfterPrefill(fn: ((name: string, seq: bigint) => void) | null): void {
    this._onAfterPrefill = fn;
  }

  async list(): Promise<string[]> {
    return Array.from(this._sessions);
  }

  async listIdentities(): Promise<Record<string, PublicSessionIdentity>> {
    const now = new Date(0).toISOString();
    const out: Record<string, PublicSessionIdentity> = {};
    for (const name of this._sessions) {
      out[name] = {
        wolfpackSessionId: `mock:${name}`,
        wolfpackSessionName: name,
        projectPath: "",
        agentKind: "unknown",
        createdAt: now,
        updatedAt: now,
        ...(this._parentSessions.get(name) && { parentSession: this._parentSessions.get(name) }),
      };
    }
    return out;
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
    options?: SessionLaunchOptions,
  ): Promise<PublicSessionIdentity> {
    this.lastCreateArgs = {
      name,
      cwd,
      cmd,
      agentKind: options?.agentKind ?? inferAgentKind(cmd),
      parentSession: options?.parentSession,
      initialPrompt: options?.initialPrompt,
    };
    if (this._onBeforeCreate) this._onBeforeCreate(name);
    if (this._sessions.has(name)) {
      throw new DuplicateSessionError(name);
    }
    this._sessions.add(name);
    if (options?.parentSession) this._parentSessions.set(name, options.parentSession);
    const now = new Date(0).toISOString();
    return {
      wolfpackSessionId: `mock:${name}`,
      wolfpackSessionName: name,
      projectPath: cwd,
      agentKind: options?.agentKind ?? inferAgentKind(cmd),
      createdAt: now,
      updatedAt: now,
      ...(options?.parentSession && { parentSession: options.parentSession }),
    };
  }

  async killSession(name: string): Promise<void> {
    this._sessions.delete(name);
    this._parentSessions.delete(name);
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

  async send(name: string, text: string, noEnter?: boolean): Promise<void> {
    this.lastSendArgs = { name, text, noEnter };
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
    name: string,
    cb: (data: Uint8Array) => void,
    opts: { sinceSeq?: bigint; onSubscribeError: (err: unknown) => void },
  ): (() => void) | null {
    if (!this._sessions.has(name)) return null;
    if (opts.sinceSeq !== undefined) {
      for (const event of this._outputHistory.get(name) ?? []) {
        if (event.seq > opts.sinceSeq) queueMicrotask(() => cb(event.data));
      }
    }
    let subscribers = this._outputSubscribers.get(name);
    if (!subscribers) {
      subscribers = new Set();
      this._outputSubscribers.set(name, subscribers);
    }
    subscribers.add(cb);
    return () => {
      const current = this._outputSubscribers.get(name);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) this._outputSubscribers.delete(name);
    };
  }

  emitSessionData(name: string, text: string): void {
    const data = new TextEncoder().encode(text);
    const seq = this._nextOutputSeq++;
    const history = this._outputHistory.get(name) ?? [];
    history.push({ seq, data });
    this._outputHistory.set(name, history);
    for (const cb of this._outputSubscribers.get(name) ?? []) cb(data);
  }

  writeToTerminal(_name: string, _data: Buffer | string): boolean {
    return true;
  }

  async getSessionPrefill(name: string, _cols?: number, _options?: { scrollbackLines?: number }): Promise<{ data: Buffer; seq?: bigint }> {
    const seq = this._nextOutputSeq - 1n;
    const data = Buffer.from(this._sessions.has(name) ? stripAnsi(await this._capturePane(name)) : "");
    this._onAfterPrefill?.(name, seq);
    return { data, seq };
  }

  onSessionLifecycle(_name: string, _cb: (event: unknown) => void): (() => void) | null {
    return () => {};
  }
}
