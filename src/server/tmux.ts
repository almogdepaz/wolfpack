/**
 * tmux helpers — exec wrappers, test hooks, capture-pane.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";
import { shellEscape } from "../validation.js";
import { INTERACTIVE_CONTEXT } from "../wolfpack-context.js";
import { createLogger, errMsg } from "../log.js";

const log = createLogger("tmux");

const _realExec = promisify(execFile);
let _execOverride: typeof _realExec | null = null;
const exec: typeof _realExec = (...args: Parameters<typeof _realExec>) =>
  (_execOverride || _realExec)(...args);

export const TMUX = "tmux";
export const MOBILE_CAPTURE_HISTORY_LINES = 2000;
export const DESKTOP_PREFILL_HISTORY_LINES = 5000;

export let DEV_DIR =
  process.env.WOLFPACK_DEV_DIR || join(homedir(), "Dev");

/** Test-only: override the cached DEV_DIR value. */
export function __setDevDir(dir: string): void { DEV_DIR = dir; }

// resolve user's shell — Ubuntu defaults to bash, macOS to zsh
export const SHELL = (() => {
  const envShell = process.env.SHELL;
  if (envShell) {
    try { execFileSync("test", ["-x", envShell]); return envShell; } catch { /* probe — shell not executable */ }
  }
  for (const p of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    try { execFileSync("test", ["-x", p]); return p; } catch { /* probe — shell not found */ }
  }
  return "/bin/sh";
})();

// ── Test mode assertion ──

function assertTestMode(hook: string): void {
  if (!process.env.WOLFPACK_TEST) throw new Error(`${hook}() is only available in test mode (WOLFPACK_TEST=1)`);
}

// ── tmuxList ──

/** Returns true if dir is DEV_DIR itself or a child of DEV_DIR (proper path boundary).
 *  Reads DEV_DIR at call time so env overrides in tests take effect. */
export function isUnderDevDir(dir: string): boolean {
  const normalizePath = (path: string): string =>
    path.length > 1 ? path.replace(/\/+$/, "") : path;
  const devDir = process.env.WOLFPACK_DEV_DIR || DEV_DIR;
  const baseDir = normalizePath(devDir);
  const candidate = normalizePath(dir);
  return candidate === baseDir || candidate.startsWith(baseDir + "/");
}

/** Maps session name → project directory. Set at creation time by tmuxNewSession(),
 *  backfilled by tmuxList() only for pre-existing sessions (never overwrites). */
export const sessionDirMap = new Map<string, string>();

const WOLFPACK_DIR_ENV = "WOLFPACK_PROJECT_DIR";

// hookable primitives for _realTmuxList — overridable in tests
let _listSessionsRaw: () => Promise<string> = async () => {
  const { stdout } = await exec(TMUX, ["list-sessions", "-F", "#{session_name}|||#{pane_current_path}"]);
  return stdout;
};

let _showEnvironment: (session: string) => Promise<string> = async (session) => {
  const { stdout } = await exec(TMUX, ["show-environment", "-t", session, WOLFPACK_DIR_ENV]);
  return stdout;
};

async function _realTmuxList(): Promise<string[]> {
  try {
    const stdout = await _listSessionsRaw();
    const SEP = "|||";
    const sessions: string[] = [];
    const backfillQueue: { name: string; dir: string }[] = [];
    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      const idx = line.indexOf(SEP);
      if (idx === -1) continue;
      const name = line.substring(0, idx);
      const dir = line.substring(idx + SEP.length);
      if (name.startsWith("wp_")) continue;
      if (!isUnderDevDir(dir)) continue;
      sessions.push(name);
      if (!sessionDirMap.has(name)) {
        const cached = _backfillCacheMap.get(name);
        if (!cached || Date.now() - cached.ts >= BACKFILL_CACHE_TTL_MS) {
          backfillQueue.push({ name, dir });
        } else {
          // use cached dir without spawning show-environment
          sessionDirMap.set(name, cached.dir);
        }
      }
    }
    // backfill missing sessionDirMap entries in parallel
    if (backfillQueue.length > 0) {
      await Promise.all(backfillQueue.map(async ({ name, dir }) => {
        let resolved = dir;
        try {
          const envOut = await _showEnvironment(name);
          const eqIdx = envOut.indexOf("=");
          const val = eqIdx !== -1 ? envOut.substring(eqIdx + 1).trim() : "";
          if (val && isUnderDevDir(val)) resolved = val;
        } catch (e: unknown) {
          log.warn("tmuxList: failed to read tmux env for session", { session: name, error: errMsg(e) });
        }
        sessionDirMap.set(name, resolved);
        _backfillCacheMap.set(name, { dir: resolved, ts: Date.now() });
      }));
    }
    // prune stale entries for sessions that no longer exist
    const liveSet = new Set(sessions);
    for (const key of sessionDirMap.keys()) {
      if (!liveSet.has(key)) sessionDirMap.delete(key);
    }
    for (const key of _triageCacheMap.keys()) {
      if (!liveSet.has(key)) _triageCacheMap.delete(key);
    }
    for (const key of _backfillCacheMap.keys()) {
      if (!liveSet.has(key)) _backfillCacheMap.delete(key);
    }
    return sessions;
  } catch (e: unknown) {
    log.warn("tmuxList: failed to list sessions", { error: errMsg(e) });
    return [];
  }
}

let _tmuxListFn: () => Promise<string[]> = _realTmuxList;

/** Test hook: override tmux functions to avoid requiring real tmux */
export function __setTestOverrides(overrides: Partial<{
  tmuxList: () => Promise<string[]>;
  tmuxResize: (session: string, cols: number, rows: number) => Promise<void>;
  capturePane: (session: string) => Promise<string>;
  tmuxSend: (session: string, text: string, noEnter?: boolean) => Promise<void>;
  tmuxSendKey: (session: string, key: string) => Promise<void>;
  listSessionsRaw: () => Promise<string>;
  showEnvironment: (session: string) => Promise<string>;
  exec: typeof _realExec;
}>): void {
  assertTestMode("__setTestOverrides");
  if (overrides.tmuxList) _tmuxListFn = overrides.tmuxList;
  if (overrides.tmuxResize) _tmuxResizeFn = overrides.tmuxResize;
  if (overrides.capturePane) _capturePane = overrides.capturePane;
  if (overrides.tmuxSend) _tmuxSendFn = overrides.tmuxSend;
  if (overrides.tmuxSendKey) _tmuxSendKeyFn = overrides.tmuxSendKey;
  if (overrides.listSessionsRaw) _listSessionsRaw = overrides.listSessionsRaw;
  if (overrides.showEnvironment) _showEnvironment = overrides.showEnvironment;
  if (overrides.exec) _execOverride = overrides.exec;
}

/** Test hook: clear backfill cache for isolation between tests */
export function __clearBackfillCache(): void {
  assertTestMode("__clearBackfillCache");
  _backfillCacheMap.clear();
}

/** Test hook: expose backfill cache for assertions */
export function __getBackfillCacheSize(): number {
  assertTestMode("__getBackfillCacheSize");
  return _backfillCacheMap.size;
}

export async function tmuxList(): Promise<string[]> {
  return _tmuxListFn();
}

// ── tmuxSend / tmuxSendKey (classic mobile terminal) ──

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SEND_ENTER_DELAY_MS = 50;

async function _realTmuxSend(session: string, text: string, noEnter = false): Promise<void> {
  await exec(TMUX, ["send-keys", "-l", "-t", session, text]);
  if (!noEnter) {
    await sleep(SEND_ENTER_DELAY_MS);
    await exec(TMUX, ["send-keys", "-t", session, "Enter"]);
  }
}

async function _realTmuxSendKey(session: string, key: string): Promise<void> {
  await exec(TMUX, ["send-keys", "-t", session, key]);
}

let _tmuxSendFn: (session: string, text: string, noEnter?: boolean) => Promise<void> = _realTmuxSend;
let _tmuxSendKeyFn: (session: string, key: string) => Promise<void> = _realTmuxSendKey;

export async function tmuxSend(session: string, text: string, noEnter = false): Promise<void> {
  return _tmuxSendFn(session, text, noEnter);
}

export async function tmuxSendKey(session: string, key: string): Promise<void> {
  return _tmuxSendKeyFn(session, key);
}

// ── tmuxResize ──

async function _realTmuxResize(session: string, cols: number, rows: number): Promise<void> {
  await exec(TMUX, ["resize-window", "-t", session, "-x", String(cols), "-y", String(rows)]);
}

let _tmuxResizeFn: (session: string, cols: number, rows: number) => Promise<void> = _realTmuxResize;

export async function tmuxResize(session: string, cols: number, rows: number): Promise<void> {
  return _tmuxResizeFn(session, cols, rows);
}

// ── capturePane ──

let _capturePane: (session: string) => Promise<string> = async (session) => {
  try {
    const { stdout } = await exec(TMUX, [
      "capture-pane", "-t", session, "-p", "-S", `-${MOBILE_CAPTURE_HISTORY_LINES}`,
    ]);
    return stdout;
  } catch (e: unknown) {
    log.debug(`capturePane failed`, { session, error: errMsg(e) });
    return "";
  }
};

export async function capturePane(session: string): Promise<string> {
  return _capturePane(session);
}

// TTL cache for show-environment backfill — prevents N tmux execs on startup/re-poll
const _backfillCacheMap = new Map<string, { dir: string; ts: number }>();
export const BACKFILL_CACHE_TTL_MS = 30_000;

// Separate cache for /api/sessions triage — avoids O(n) tmux execs on rapid polling
const _triageCacheMap = new Map<string, { content: string; ts: number }>();
const TRIAGE_CACHE_TTL_MS = 500;

export async function capturePaneForTriage(session: string): Promise<string> {
  const cached = _triageCacheMap.get(session);
  if (cached && Date.now() - cached.ts < TRIAGE_CACHE_TTL_MS) return cached.content;
  const content = await _capturePane(session);
  _triageCacheMap.set(session, { content, ts: Date.now() });
  return content;
}

// ── tmuxNewSession ──

const RALPH_AGENTS = new Set(["claude", "codex", "gemini", "cursor"]);

/** Detect which agent an agentCmd refers to */
export function detectAgent(agentCmd: string): "claude" | "gemini" | "codex" | "cursor" | null {
  for (const agent of RALPH_AGENTS) {
    if (new RegExp(`^${agent}\\b`).test(agentCmd)) return agent as "claude" | "gemini" | "codex" | "cursor";
  }
  return null;
}

/**
 * Build the full command with context injection for the detected agent.
 */
export function injectAgentContext(agentCmd: string): string {
  const agent = detectAgent(agentCmd);
  switch (agent) {
    case "claude": {
      const withCtx = agentCmd + " --append-system-prompt " + shellEscape(INTERACTIVE_CONTEXT);
      return withCtx + " || " + agentCmd;
    }
    case "gemini": {
      return agentCmd + " -i " + shellEscape(INTERACTIVE_CONTEXT);
    }
    default:
      return agentCmd;
  }
}

export async function tmuxNewSession(
  name: string,
  cwd: string,
  cmd: string | undefined,
  loadSettings: () => { agentCmd: string },
): Promise<void> {
  // Guard: if a tmux session with this name already exists, bail with a clear error
  try {
    await exec(TMUX, ["has-session", "-t", name], { timeout: 2000 });
    const err = new Error(`duplicate session: ${name}`);
    (err as any).code = "DUPLICATE_SESSION";
    throw err;
  } catch (e: any) {
    // has-session exits non-zero when session doesn't exist — that's the happy path
    if (e.code === "DUPLICATE_SESSION") throw e;
  }

  const agentCmd = cmd || loadSettings().agentCmd || "claude";
  if (agentCmd === "shell") {
    await exec(TMUX, ["new-session", "-d", "-s", name, "-c", cwd, SHELL]);
  } else {
    const fullCmd = injectAgentContext(agentCmd);
    const shellCmd = `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT ${SHELL} -lic ${shellEscape(fullCmd + "; exec " + SHELL)}`;
    await exec(TMUX, ["new-session", "-d", "-s", name, "-c", cwd, shellCmd]);
  }
  // enforce sane defaults for wolfpack sessions (scoped to this session only)
  await exec(TMUX, ["set-option", "-t", name, "mouse", "on"]).catch((e: unknown) => {
    log.warn("tmuxNewSession: failed to set mouse option", { session: name, error: errMsg(e) });
  });
  // cache only after successful creation to avoid poisoning map on failed attempts
  sessionDirMap.set(name, cwd);
  // persist project root in tmux session env — survives server restarts
  await exec(TMUX, ["set-environment", "-t", name, WOLFPACK_DIR_ENV, cwd]).catch((e: unknown) => {
    log.warn("tmuxNewSession: failed to persist project dir in tmux env", { session: name, error: errMsg(e) });
  });
}

// ── Cleanup ──

export async function cleanupOrphanPtySessions(): Promise<void> {
  try {
    const { stdout } = await exec(TMUX, ["list-sessions", "-F", "#{session_name}"], { timeout: 3000 });
    for (const name of stdout.split("\n")) {
      if (name.startsWith("wp_")) {
        await exec(TMUX, ["kill-session", "-t", name], { timeout: 2000 }).catch((e: unknown) => {
          log.warn("cleanupOrphanPtySessions: failed to kill session", { session: name, error: errMsg(e) });
        });
      }
    }
  } catch (e: unknown) {
    log.warn("cleanupOrphanPtySessions: failed to list sessions", { error: errMsg(e) });
  }
}

export { exec, RALPH_AGENTS };
