/**
 * PtyBackend — SessionBackend implementation using raw Bun PTY processes.
 *
 * Each session is a direct PTY child process (no tmux). Output is captured
 * into a per-session RingBuffer so capturePane/capturePaneForTriage work
 * without an external multiplexer.
 */
import type { SessionBackend } from "./backend.js";
import { RingBuffer } from "./ring-buffer.js";
import { SHELL, injectAgentContext } from "./tmux.js";
import { createLogger, errMsg } from "../log.js";

const log = createLogger("pty-backend");

/** Default ring buffer capacity per session — 512 KB covers ~5000 lines of output. */
const DEFAULT_BUFFER_CAPACITY = 512 * 1024;

/** Triage cache TTL — avoids re-reading the ring buffer on rapid polling. */
const TRIAGE_CACHE_TTL_MS = 500;

/** Tmux-style key names → raw byte sequences for PTY input. */
const KEY_MAP: Record<string, string> = {
  Enter: "\r",
  Tab: "\t",
  Escape: "\x1b",
  BSpace: "\x7f",
  DC: "\x1b[3~",
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PPage: "\x1b[5~",
  NPage: "\x1b[6~",
  BTab: "\x1b[Z",
  // Ctrl-key combos (C-a through C-z)
  "C-a": "\x01", "C-b": "\x02", "C-c": "\x03", "C-d": "\x04",
  "C-e": "\x05", "C-f": "\x06", "C-g": "\x07", "C-h": "\x08",
  "C-k": "\x0b", "C-l": "\x0c", "C-n": "\x0e", "C-p": "\x10",
  "C-r": "\x12", "C-u": "\x15", "C-w": "\x17", "C-z": "\x1a",
};

interface PtySession {
  proc: ReturnType<typeof Bun.spawn>;
  buffer: RingBuffer;
  cwd: string;
  alive: boolean;
  dataListeners: Set<(data: Uint8Array) => void>;
}

export class PtyBackend implements SessionBackend {
  private sessions = new Map<string, PtySession>();
  private triageCache = new Map<string, { content: string; ts: number }>();

  async list(): Promise<string[]> {
    return Array.from(this.sessions.keys());
  }

  async createSession(
    name: string,
    cwd: string,
    cmd: string | undefined,
    loadSettings: () => { agentCmd: string },
  ): Promise<void> {
    if (this.sessions.has(name)) {
      const err = new Error(`duplicate session: ${name}`);
      (err as any).code = "DUPLICATE_SESSION";
      throw err;
    }

    const agentCmd = cmd || loadSettings().agentCmd || "claude";
    let shellCmd: string;
    if (agentCmd === "shell") {
      shellCmd = SHELL;
    } else {
      const fullCmd = injectAgentContext(agentCmd);
      shellCmd = `${fullCmd}; exec ${SHELL}`;
    }

    const buffer = new RingBuffer(DEFAULT_BUFFER_CAPACITY);
    const dataListeners = new Set<(data: Uint8Array) => void>();

    // Capture references for the exit callback closure (must precede Bun.spawn)
    const sessions = this.sessions;
    const triageCache = this.triageCache;

    const proc = Bun.spawn([SHELL, "-lic", shellCmd], {
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        WOLFPACK_PROJECT_DIR: cwd,
        // Strip vars that cause agent confusion (consistent with TmuxBackend's env -u)
        CLAUDECODE: undefined,
        CLAUDE_CODE_ENTRYPOINT: undefined,
      },
      terminal: {
        cols: 120,
        rows: 40,
        data(_terminal: unknown, data: Uint8Array) {
          buffer.write(data);
          for (const cb of dataListeners) {
            try { cb(data); } catch { /* listener error — ignore */ }
          }
        },
        exit(_terminal: unknown, _code: number, _signal: string | null) {
          const session = sessions.get(name);
          if (session) {
            session.alive = false;
            sessions.delete(name);
            triageCache.delete(name);
            log.info("session exited", { name });
          }
        },
      },
    });

    const session: PtySession = { proc, buffer, cwd, alive: true, dataListeners };
    this.sessions.set(name, session);
    log.info("session created", { name, cwd, cmd: agentCmd });
  }

  async killSession(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) return;
    session.alive = false;
    this.sessions.delete(name);
    this.triageCache.delete(name);
    try {
      session.proc.kill();
    } catch (e: unknown) {
      log.debug("killSession: proc.kill failed", { name, error: errMsg(e) });
    }
  }

  async hasSession(name: string): Promise<boolean> {
    const session = this.sessions.get(name);
    return !!session && session.alive;
  }

  async capturePane(name: string): Promise<string> {
    const session = this.sessions.get(name);
    if (!session) return "";
    return session.buffer.read();
  }

  async capturePaneForTriage(name: string): Promise<string> {
    const cached = this.triageCache.get(name);
    if (cached && Date.now() - cached.ts < TRIAGE_CACHE_TTL_MS) return cached.content;
    const content = await this.capturePane(name);
    this.triageCache.set(name, { content, ts: Date.now() });
    return content;
  }

  async resize(name: string, cols: number, rows: number): Promise<void> {
    const session = this.sessions.get(name);
    if (!session || !session.alive) return;
    try {
      session.proc.terminal!.resize(cols, rows);
    } catch (e: unknown) {
      log.debug("resize failed", { name, error: errMsg(e) });
    }
  }

  // Raw PTY write — equivalent to typing on a keyboard. No shell interpretation.
  // Unlike TmuxBackend's tmuxSend (which uses `send-keys -l` literal mode),
  // this goes directly to the terminal fd. Safe because input is user-initiated
  // via the classic terminal WS handler, gated by WS_ALLOWED_KEYS for key messages.
  async send(name: string, text: string, noEnter?: boolean): Promise<void> {
    const session = this.sessions.get(name);
    if (!session || !session.alive) return;
    const terminal = session.proc.terminal!;
    terminal.write(text);
    if (!noEnter) {
      terminal.write("\r");
    }
  }

  async sendKey(name: string, key: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session || !session.alive) return;
    const seq = KEY_MAP[key];
    if (seq) {
      session.proc.terminal!.write(seq);
    } else if (key.length === 1) {
      // Single printable character — send as-is
      session.proc.terminal!.write(key);
    } else {
      log.warn("sendKey: unknown key", { name, key });
    }
  }

  sessionDir(name: string): string | undefined {
    return this.sessions.get(name)?.cwd;
  }

  async cleanupOrphans(): Promise<void> {
    // No external processes to clean up — all sessions are children of this process.
    // Kill any sessions that are no longer alive.
    for (const [name, session] of this.sessions) {
      if (!session.alive) {
        this.sessions.delete(name);
        this.triageCache.delete(name);
      }
    }
  }

  // ── WS attachment helpers (used by handlePtyWs for direct terminal I/O) ──

  /** Subscribe to terminal output for a session. Returns unsubscribe function. */
  onSessionData(name: string, cb: (data: Uint8Array) => void): (() => void) | null {
    const session = this.sessions.get(name);
    if (!session || !session.alive) return null;
    session.dataListeners.add(cb);
    return () => { session.dataListeners.delete(cb); };
  }

  /** Write raw input bytes to a session's terminal. */
  writeToTerminal(name: string, data: Buffer | string): void {
    const session = this.sessions.get(name);
    if (!session || !session.alive) return;
    session.proc.terminal!.write(data);
  }

  /** Get prefill buffer contents for a session. */
  getSessionPrefill(name: string): Buffer {
    const session = this.sessions.get(name);
    if (!session) return Buffer.alloc(0);
    return session.buffer.readBuffer();
  }

  /** Check if a session's process is alive. */
  isSessionAlive(name: string): boolean {
    const session = this.sessions.get(name);
    return !!session && session.alive;
  }

  /** Expose internal session state for tests. */
  __getSession(name: string): PtySession | undefined {
    if (!process.env.WOLFPACK_TEST) throw new Error("__getSession() is only available in test mode");
    return this.sessions.get(name);
  }
}
