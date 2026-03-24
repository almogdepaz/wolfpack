/**
 * SessionBackend interface — abstraction over tmux vs raw-PTY session management.
 */

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

// ── Backend singleton ──

let _backend: SessionBackend | null = null;
let _backendType: BackendType = DEFAULT_BACKEND;

/** Initialize the backend singleton. Call once at server startup. */
export function initBackend(type?: BackendType): SessionBackend {
  _backendType = type ?? DEFAULT_BACKEND;
  if (_backendType === "pty") {
    const { PtyBackend } = require("./pty-backend.js");
    _backend = new PtyBackend() as SessionBackend;
  } else {
    const { TmuxBackend } = require("./tmux-backend.js");
    _backend = new TmuxBackend() as SessionBackend;
  }
  return _backend!;
}

/** Get the current backend singleton. Throws if not initialized. */
export function getBackend(): SessionBackend {
  if (!_backend) {
    // Auto-init with default for backward compatibility
    return initBackend();
  }
  return _backend;
}

/** Get the current backend type. */
export function getBackendType(): BackendType {
  return _backendType;
}

/** Test-only: reset singleton for test isolation. */
export function __resetBackend(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("__resetBackend() is only available in test mode");
  _backend = null;
  _backendType = DEFAULT_BACKEND;
}
