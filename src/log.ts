/**
 * Minimal structured logger.
 *
 * Format: `{ ts, level, component, session?, msg, ...extra }`
 * Levels: debug, info, warn, error
 * Controlled by WOLFPACK_LOG_LEVEL env var (default: info).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Component = "pty" | "pty-backend" | "ws" | "http" | "ralph" | "auth" | "service" | "config" | "setup" | "tmux" | "tmux-backend" | "server" | "worktree" | "routes";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function currentLevel(): LogLevel {
  const env = process.env.WOLFPACK_LOG_LEVEL?.toLowerCase();
  if (env && env in LEVEL_ORDER) return env as LogLevel;
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel()];
}

interface LogEntry {
  ts: string;
  level: LogLevel;
  component: Component;
  session?: string;
  msg: string;
  [key: string]: unknown;
}

const RESERVED_KEYS = new Set(["ts", "level", "component", "msg"]);

function emit(level: LogLevel, component: Component, msg: string, extra?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  // Spread extra first, then override with reserved fields so callers
  // can't accidentally corrupt structured log entries (ISS-13).
  const safe = extra ? Object.fromEntries(Object.entries(extra).filter(([k]) => !RESERVED_KEYS.has(k))) : undefined;
  const entry: LogEntry = {
    ...safe,
    ts,
    level,
    component,
    msg,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export function createLogger(component: Component) {
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => emit("debug", component, msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => emit("info", component, msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => emit("warn", component, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => emit("error", component, msg, extra),
  };
}

/** Convenience: extract message from unknown catch value. Re-exported from process-cleanup. */
export { errMsg } from "./shared/process-cleanup.js";
