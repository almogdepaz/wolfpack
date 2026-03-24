/**
 * MockBackend — SessionBackend implementation for integration tests.
 *
 * Replaces __setTestOverrides by providing a fully controllable backend
 * that can be injected via __setTestBackend(). No tmux or real PTY needed.
 */
import type { SessionBackend } from "./backend.js";

export interface MockBackendOptions {
  sessions?: string[];
  capturePane?: (session: string) => Promise<string>;
}

export class MockBackend implements SessionBackend {
  private _sessions: Set<string>;
  private _capturePane: (session: string) => Promise<string>;

  constructor(opts: MockBackendOptions = {}) {
    this._sessions = new Set(opts.sessions ?? []);
    this._capturePane = opts.capturePane ?? (async () => "");
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

  async createSession(name: string): Promise<void> {
    if (this._sessions.has(name)) {
      const err = new Error(`duplicate session: ${name}`);
      (err as any).code = "DUPLICATE_SESSION";
      throw err;
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
    return this._capturePane(name);
  }

  async capturePaneForTriage(name: string): Promise<string> {
    return this.capturePane(name);
  }

  async resize(): Promise<void> {
    // no-op in mock
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

  // ── PtyBackend-compatible methods ──
  // websocket.ts casts backend to PtyBackend and calls these directly.
  // MockBackend provides no-op/stub versions so tests don't crash.

  isSessionAlive(name: string): boolean {
    return this._sessions.has(name);
  }

  onSessionData(_name: string, _cb: (data: Uint8Array) => void): (() => void) | null {
    // No real data stream — return a no-op unsubscribe
    return () => {};
  }

  writeToTerminal(_name: string, _data: Buffer | string): void {
    // no-op in mock
  }

  getSessionPrefill(_name: string): Buffer {
    return Buffer.alloc(0);
  }
}
