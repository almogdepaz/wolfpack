/**
 * tmux helpers — exec wrappers, test hooks, capture-pane.
 *
 * Shared utilities (SHELL, exec, injectAgentContext, RALPH_AGENTS, DEV_DIR
 * family) live in `./shell.ts` and `./dev-dir.ts`. This module is the
 * tmux-specific surface only.
 */
import { shellEscape } from "../validation.js";
import { createLogger, errMsg } from "../log.js";
import { exec, SHELL, injectAgentContext, __setExecOverride, type ExecFn } from "./shell.js";
import { isUnderDevDir, sessionDirMap } from "./dev-dir.js";

const log = createLogger("tmux");

export const TMUX = "tmux";
export const MOBILE_CAPTURE_HISTORY_LINES = 2000;
export const DESKTOP_PREFILL_HISTORY_LINES = 5000;

// ── Test mode assertion ──

function assertTestMode(hook: string): void {
  if (!process.env.WOLFPACK_TEST) throw new Error(`${hook}() is only available in test mode (WOLFPACK_TEST=1)`);
}

// ── tmuxList ──

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
  listSessionsRaw: () => Promise<string>;
  showEnvironment: (session: string) => Promise<string>;
  exec: ExecFn;
}>): void {
  assertTestMode("__setTestOverrides");
  if (overrides.tmuxList) _tmuxListFn = overrides.tmuxList;
  if (overrides.tmuxResize) _tmuxResizeFn = overrides.tmuxResize;
  if (overrides.capturePane) _capturePane = overrides.capturePane;
  if (overrides.listSessionsRaw) _listSessionsRaw = overrides.listSessionsRaw;
  if (overrides.showEnvironment) _showEnvironment = overrides.showEnvironment;
  if (overrides.exec) __setExecOverride(overrides.exec);
}

/** Test hook: reset _tmuxListFn back to _realTmuxList.
 *  Call in beforeEach for tests that need real list/backfill behavior, to undo
 *  any tmuxList override that integration test modules set at module-load time. */
export function __resetTmuxListFn(): void {
  assertTestMode("__resetTmuxListFn");
  _tmuxListFn = _realTmuxList;
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
