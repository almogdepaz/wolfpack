/**
 * Minimal structured logger.
 *
 * Format: `{ ts, level, component, session?, msg, ...extra }`
 * Levels: debug, info, warn, error
 * Controlled by WOLFPACK_LOG_LEVEL env var (default: info).
 */

import { writeSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Component = "pty" | "pty-backend" | "ws" | "http" | "auth" | "service" | "config" | "setup" | "broker-backend" | "backend" | "server" | "routes" | "doctor" | "push" | "session-observation" | "peer-notifications" | "task-relay" | "session-cascade" | "remote-ops";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let _cachedLevel: LogLevel | null = null;

function resolveLevelFromEnv(): LogLevel {
  const env = process.env.WOLFPACK_LOG_LEVEL?.toLowerCase();
  if (env && env in LEVEL_ORDER) return env as LogLevel;
  return "info";
}

function currentLevel(): LogLevel {
  if (_cachedLevel === null) {
    _cachedLevel = resolveLevelFromEnv();
  }
  return _cachedLevel;
}

// Runtime invalidation hook: `kill -HUP <pid>` re-reads WOLFPACK_LOG_LEVEL.
try {
  process.on("SIGHUP", () => {
    _cachedLevel = resolveLevelFromEnv();
  });
} catch {
  // Ignore if signals are unavailable in this runtime.
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

function formatRecord(level: LogLevel, component: Component, msg: string, extra?: Record<string, unknown>): string {
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
  return JSON.stringify(entry) + "\n";
}

function emit(level: LogLevel, component: Component, msg: string, extra: Record<string, unknown> | undefined, threshold: LogLevel): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) return;
  const line = formatRecord(level, component, msg, extra);
  if (level === "error") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

const FATAL_WRITE_TIMEOUT_MS = 2_000;

/** Complete the fatal record within the retry budget, or let the caller exit. */
export function writeFatalError(component: Component, msg: string, extra?: Record<string, unknown>): void {
  const deadline = performance.now() + FATAL_WRITE_TIMEOUT_MS;
  const bytes = Buffer.from(formatRecord("error", component, msg, extra));
  let offset = 0;
  while (offset < bytes.length) {
    if (performance.now() >= deadline) throw new Error("fatal log write deadline exceeded");
    try {
      const written = writeSync(2, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error("fatal log write made no progress");
      offset += written;
    } catch (error) {
      // Bun can leave stderr nonblocking after server startup. Wait only
      // within the deadline; a stalled reader must not prevent server exit.
      if (error instanceof Error && "code" in error && error.code === "EAGAIN") {
        Bun.sleepSync(Math.max(0, Math.min(10, deadline - performance.now())));
        continue;
      }
      throw error;
    }
  }
}

export function createLogger(component: Component, options: { readonly level?: () => LogLevel } = {}) {
  const level = options.level ?? currentLevel;
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => emit("debug", component, msg, extra, level()),
    info: (msg: string, extra?: Record<string, unknown>) => emit("info", component, msg, extra, level()),
    warn: (msg: string, extra?: Record<string, unknown>) => emit("warn", component, msg, extra, level()),
    error: (msg: string, extra?: Record<string, unknown>) => emit("error", component, msg, extra, level()),
  };
}

/** Extract a human-readable message from an unknown catch value. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
