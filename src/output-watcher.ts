import { watchFile, unwatchFile, readFileSync, writeFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { stripAnsi } from "./ansi.js";
import {
  LOG_DIR,
  LOG_FILE_PREFIX,
  DEFAULT_QUIET_TIMEOUT_MS,
  DEFAULT_OUTPUT_PREFIX,
  WHATSAPP_TEXT_CHUNK_LIMIT,
  ECHO_TTL_MS,
} from "./constants.js";
import { tmuxStartPipePane, tmuxStopPipePane, tmuxSessionExists } from "./tmux-io.js";

interface WatcherHandle {
  tmuxSession: string;
  groupJid: string;
  logPath: string;
  lastSize: number;
  buffer: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

interface OutputWatcherConfig {
  outputPrefix?: string;
  quietTimeoutMs?: number;
  maxOutputChars?: number;
}

type SendMessageFn = (groupJid: string, text: string) => Promise<void>;
type LogFn = (msg: string) => void;

const watchers = new Map<string, WatcherHandle>();

// Track recently sent messages to prevent echo loops
const recentlySent = new Map<string, number>();

type OutputCallbackFn = (tmuxSession: string, text: string) => void;

let sendMessage: SendMessageFn | null = null;
let logInfo: LogFn = console.log;
let logError: LogFn = console.error;
let config: OutputWatcherConfig = {};
let onOutputFn: OutputCallbackFn | null = null;

function logPath(tmuxSession: string): string {
  return join(LOG_DIR, `${LOG_FILE_PREFIX}${tmuxSession}.log`);
}

function getPrefix(): string {
  return config.outputPrefix ?? DEFAULT_OUTPUT_PREFIX;
}

function getQuietTimeout(): number {
  return config.quietTimeoutMs ?? DEFAULT_QUIET_TIMEOUT_MS;
}

function getMaxChars(): number {
  return config.maxOutputChars ?? 12000;
}

/**
 * Record a message hash to prevent echo loops.
 */
export function recordSentMessage(content: string): void {
  const key = content.slice(0, 200); // Use first 200 chars as key
  recentlySent.set(key, Date.now());
}

/**
 * Check if a message was recently sent by the output watcher (echo detection).
 */
export function wasRecentlySent(content: string): boolean {
  const key = content.slice(0, 200);
  const sentAt = recentlySent.get(key);
  if (!sentAt) return false;
  if (Date.now() - sentAt > ECHO_TTL_MS) {
    recentlySent.delete(key);
    return false;
  }
  return true;
}

/**
 * Clean up expired echo entries.
 */
function cleanEchoCache(): void {
  const now = Date.now();
  for (const [key, sentAt] of recentlySent) {
    if (now - sentAt > ECHO_TTL_MS) {
      recentlySent.delete(key);
    }
  }
}

/**
 * Flush accumulated buffer for a session to WhatsApp.
 */
async function flushBuffer(sessionKey: string): Promise<void> {
  const handle = watchers.get(sessionKey);
  if (!handle || !handle.buffer || !sendMessage) return;

  handle.flushTimer = null;
  let text = handle.buffer;
  handle.buffer = "";

  // Strip ANSI codes
  text = stripAnsi(text);

  // Trim whitespace and skip empty output
  text = text.trim();
  if (!text) return;

  // Truncate if too long
  const maxChars = getMaxChars();
  if (text.length > maxChars) {
    text = text.slice(-maxChars); // Keep the tail (most recent output)
    text = `[...truncated]\n${text}`;
  }

  // Notify PWA poll buffer
  if (onOutputFn) {
    try { onOutputFn(handle.tmuxSession, text); } catch {}
  }

  const prefix = getPrefix();

  // Chunk at WhatsApp limit
  const chunks = chunkText(`${prefix} ${text}`, WHATSAPP_TEXT_CHUNK_LIMIT);

  for (const chunk of chunks) {
    try {
      recordSentMessage(chunk);
      await sendMessage(handle.groupJid, chunk);
    } catch (err) {
      logError(`Failed to send output to ${handle.groupJid}: ${err}`);
    }
  }
}

/**
 * Split text into chunks at a max character limit.
 * Tries to split at newlines when possible.
 */
function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) {
      splitAt = limit; // Hard split if no newline found
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }

  return chunks;
}

/**
 * Handle new data appearing in a log file.
 */
function onFileChange(sessionKey: string): void {
  const handle = watchers.get(sessionKey);
  if (!handle) return;

  try {
    if (!existsSync(handle.logPath)) return;

    const stat = statSync(handle.logPath);
    const newSize = stat.size;

    if (newSize <= handle.lastSize) return;

    // Read only the new bytes using positional read
    const bytesToRead = newSize - handle.lastSize;
    const buf = Buffer.alloc(bytesToRead);
    const fd = openSync(handle.logPath, "r");
    try {
      readSync(fd, buf, 0, bytesToRead, handle.lastSize);
    } finally {
      closeSync(fd);
    }
    const newData = buf.toString("utf-8");
    handle.lastSize = newSize;

    if (!newData) return;

    // Accumulate in buffer
    handle.buffer += newData;

    // Push raw output to PWA poll buffer immediately
    if (onOutputFn) {
      const cleaned = stripAnsi(newData).trim();
      if (cleaned) {
        try { onOutputFn(handle.tmuxSession, cleaned); } catch {}
      }
    }

    // Reset quiet timer
    if (handle.flushTimer) {
      clearTimeout(handle.flushTimer);
    }
    handle.flushTimer = setTimeout(() => flushBuffer(sessionKey), getQuietTimeout());
  } catch (err) {
    logError(`Error reading log for ${sessionKey}: ${err}`);
  }
}

/**
 * Start watching a tmux session's output.
 */
export async function addSession(
  sessionKey: string,
  tmuxSession: string,
  groupJid: string
): Promise<void> {
  // Validate groupJid — must be a WhatsApp group JID (@g.us)
  if (!groupJid || !groupJid.endsWith("@g.us")) {
    logError(`BLOCKED: refusing to watch session with non-group JID: ${groupJid}`);
    return;
  }

  // Don't double-watch
  if (watchers.has(sessionKey)) {
    await removeSession(sessionKey);
  }

  const path = logPath(tmuxSession);

  // Ensure log file exists (pipe-pane needs it)
  if (!existsSync(path)) {
    writeFileSync(path, "");
  }

  // Check tmux session exists before starting pipe-pane
  if (!(await tmuxSessionExists(tmuxSession))) {
    logError(`tmux session '${tmuxSession}' not found, skipping pipe-pane`);
    // Still create the watcher handle so it can be connected later
  } else {
    try {
      await tmuxStartPipePane(tmuxSession, path);
      logInfo(`Started pipe-pane for tmux session '${tmuxSession}' -> ${path}`);
    } catch (err) {
      logError(`Failed to start pipe-pane for '${tmuxSession}': ${err}`);
    }
  }

  // Get current file size (start watching from end)
  const currentSize = existsSync(path) ? statSync(path).size : 0;

  const handle: WatcherHandle = {
    tmuxSession,
    groupJid,
    logPath: path,
    lastSize: currentSize,
    buffer: "",
    flushTimer: null,
  };

  watchers.set(sessionKey, handle);

  // Watch for changes — using watchFile (polling) for reliability with appended files
  watchFile(path, { interval: 500 }, () => onFileChange(sessionKey));

  logInfo(`Watching output for session '${tmuxSession}' (${sessionKey})`);
}

/**
 * Stop watching a tmux session's output.
 */
export async function removeSession(sessionKey: string): Promise<void> {
  const handle = watchers.get(sessionKey);
  if (!handle) return;

  // Clear pending flush
  if (handle.flushTimer) {
    clearTimeout(handle.flushTimer);
    // Flush remaining buffer before removing
    await flushBuffer(sessionKey);
  }

  // Stop file watcher
  unwatchFile(handle.logPath);

  // Stop pipe-pane
  try {
    await tmuxStopPipePane(handle.tmuxSession);
  } catch {
    // Session might already be gone
  }

  watchers.delete(sessionKey);
  logInfo(`Stopped watching session '${handle.tmuxSession}' (${sessionKey})`);
}

/**
 * Initialize the output watcher system.
 */
export function init(params: {
  sendMessageFn: SendMessageFn;
  logInfoFn: LogFn;
  logErrorFn: LogFn;
  config: OutputWatcherConfig;
  onOutputFn?: OutputCallbackFn;
}): void {
  sendMessage = params.sendMessageFn;
  logInfo = params.logInfoFn;
  logError = params.logErrorFn;
  config = params.config;
  onOutputFn = params.onOutputFn ?? null;

  // Periodically clean echo cache
  setInterval(cleanEchoCache, ECHO_TTL_MS);
}

/**
 * Stop all watchers.
 */
export async function stopAll(): Promise<void> {
  const keys = [...watchers.keys()];
  for (const key of keys) {
    await removeSession(key);
  }
  recentlySent.clear();
}
