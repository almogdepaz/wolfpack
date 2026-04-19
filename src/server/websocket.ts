/**
 * WebSocket handlers — PTY (ghostty-web WASM) + classic terminal (text polling).
 *
 * Backend-agnostic: works with both TmuxBackend (spawns `tmux attach-session`)
 * and PtyBackend (pipes WS directly to session terminal I/O).
 */
import type { WebSocket } from "ws";
import {
  WS_ALLOWED_KEYS,
  clampCols,
  clampRows,
} from "../validation.js";
import {
  CLOSE_CODE_NORMAL,
  CLOSE_CODE_SESSION_UNAVAILABLE,
  CLOSE_CODE_DISPLACED,
  WS_CLOSE_REASONS,
} from "../ws-constants.js";
import {
  TMUX,
  DESKTOP_PREFILL_HISTORY_LINES,
  exec,
} from "./tmux.js";
import { getBackend, getBackendTypeForSession, getRouter } from "./backend.js";
import { createRateLimiter, isAllowedSession } from "./http.js";
import { createLogger, errMsg } from "../log.js";

const log = createLogger("ws");

// ── PTY session tracking ──

export const activePtySessions = new Map<string, {
  viewer: WebSocket | null;
  pendingViewer: WebSocket | null;
  proc: ReturnType<typeof Bun.spawn> | null;
  alive: boolean;
  unsubscribe?: (() => void) | null;
}>();

const ptySpawnAttempts = new Map<string, number>();

// ── Constants ──
const DESKTOP_PREFILL_MAX_BYTES = 256 * 1024;
const PREFILL_CHUNK_SIZE = 32 * 1024;
const PREFILL_CHUNK_DELAY_MS = 8;
const PREFILL_OVERLAP_LIMIT = 32 * 1024;
const POLL_INTERVAL_MS = 50;
const POST_INPUT_DELAY_MS = 50;
const MAX_WS_MESSAGE_BYTES = 4096;
const PING_INTERVAL_MS = 25_000;
const RATE_LIMIT_PER_SEC = 60;
const MAX_PTY_BINARY_BYTES = 16_384;
const RESIZE_DEBOUNCE_MS = 80;
const RAPID_EXIT_THRESHOLD_MS = 3_000;
const POST_SPAWN_RESIZE_DELAY_MS = 100;

function bufferStartsWithPrefillSuffix(prefillTail: Buffer, attachPrefix: Buffer, overlap: number): boolean {
  const prefillStart = prefillTail.length - overlap;
  for (let i = 0; i < overlap; i++) {
    if (prefillTail[prefillStart + i] !== attachPrefix[i]) return false;
  }
  return true;
}

export function __stripInitialPtyOverlap(
  prefill: Buffer,
  attachPrefix: Buffer,
): { awaitingMore: boolean; data: Buffer } {
  if (!prefill.length || !attachPrefix.length) {
    return { awaitingMore: false, data: attachPrefix };
  }

  const prefillTail = prefill.subarray(Math.max(0, prefill.length - PREFILL_OVERLAP_LIMIT));
  const maxOverlap = Math.min(prefillTail.length, attachPrefix.length);

  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (!bufferStartsWithPrefillSuffix(prefillTail, attachPrefix, overlap)) continue;
    if (overlap === attachPrefix.length) {
      return { awaitingMore: true, data: Buffer.alloc(0) };
    }
    return {
      awaitingMore: false,
      data: attachPrefix.subarray(overlap),
    };
  }

  return { awaitingMore: false, data: attachPrefix };
}

function sendPrefillDone(entry: { viewer: WebSocket | null; alive: boolean }): boolean {
  if (!entry.alive || !entry.viewer || entry.viewer.readyState !== 1) return false;
  entry.viewer.send(JSON.stringify({ type: "prefill_done" }));
  return true;
}

function sendPtyReady(entry: { viewer: WebSocket | null; alive: boolean }): boolean {
  if (!entry.alive || !entry.viewer || entry.viewer.readyState !== 1) return false;
  entry.viewer.send(JSON.stringify({ type: "pty_ready" }));
  return true;
}

/** Send prefill buffer in 32KB chunks with short delays to avoid stalling mobile connections.
 *  Sends `prefill_done` message at the end so the client exits buffering state. */
async function sendPrefillChunked(
  entry: { viewer: WebSocket | null; alive: boolean },
  prefill: Buffer,
  session: string,
): Promise<boolean> {
  let offset = 0;
  while (offset < prefill.length) {
    if (!entry.alive || !entry.viewer || entry.viewer.readyState !== 1) return false;
    const end = Math.min(offset + PREFILL_CHUNK_SIZE, prefill.length);
    entry.viewer.send(prefill.subarray(offset, end));
    offset = end;
    if (offset < prefill.length) {
      await new Promise(resolve => setTimeout(resolve, PREFILL_CHUNK_DELAY_MS));
    }
  }
  return sendPrefillDone(entry);
}

/** Test hook: expose PTY internal state for assertions */
export function __getTestState(): {
  activePtySessions: typeof activePtySessions;
  ptySpawnAttempts: Map<string, number>;
  sendPrefillChunked: typeof sendPrefillChunked;
  PREFILL_CHUNK_SIZE: number;
} {
  if (!process.env.WOLFPACK_TEST) throw new Error("__getTestState() is only available in test mode (WOLFPACK_TEST=1)");
  return { activePtySessions, ptySpawnAttempts, sendPrefillChunked, PREFILL_CHUNK_SIZE };
}

// ── Classic terminal WS handler (text polling for mobile) ──

export function handleTerminalWs(ws: WebSocket, session: string): void {
  const backend = getBackend();
  let prev = "";
  let alive = true;
  let sized = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let updating = false;
  let nextSessionCheckAt = 0;

  async function sendUpdate() {
    if (!alive || updating) return;
    updating = true;
    try {
      const now = Date.now();
      if (now >= nextSessionCheckAt) {
        nextSessionCheckAt = now + 1000;
        if (!(await backend.hasSession(session))) {
          alive = false;
          updating = false;
          try { ws.close(CLOSE_CODE_SESSION_UNAVAILABLE, WS_CLOSE_REASONS.SESSION_ENDED); } catch (e: unknown) { log.debug(`ws.close failed`, { session, error: errMsg(e) }); }
          return;
        }
      }
      const pane = await backend.capturePane(session);
      if (pane !== prev) {
        prev = pane;
        ws.send(JSON.stringify({ type: "output", data: pane }));
      }
    } catch (e: unknown) {
      log.warn("sendUpdate failed", { session, error: errMsg(e) });
    }
    updating = false;
    schedulePoll();
  }

  function schedulePoll() {
    if (!alive) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(sendUpdate, POLL_INTERVAL_MS);
  }

  schedulePoll();

  const pingTimer = setInterval(() => {
    if (alive && ws.readyState === 1) {
      try { ws.ping(); } catch (e: unknown) { log.debug(`ws ping failed`, { session, error: errMsg(e) }); }
    } else {
      clearInterval(pingTimer);
    }
  }, PING_INTERVAL_MS);

  const rl = createRateLimiter(RATE_LIMIT_PER_SEC);

  ws.on("message", async (raw) => {
    if (!rl.allow()) return;

    try {
      const str = String(raw);
      if (str.length > MAX_WS_MESSAGE_BYTES) return;
      const msg = JSON.parse(str);
      if (msg.type === "input" && typeof msg.data === "string") {
        await backend.send(session, msg.data, true);
        setTimeout(sendUpdate, POST_INPUT_DELAY_MS);
      } else if (msg.type === "key" && typeof msg.key === "string") {
        if (WS_ALLOWED_KEYS.has(msg.key)) {
          await backend.sendKey(session, msg.key);
          setTimeout(sendUpdate, POST_INPUT_DELAY_MS);
        }
      } else if (
        msg.type === "resize" &&
        typeof msg.cols === "number" &&
        typeof msg.rows === "number"
      ) {
        if (!activePtySessions.has(session)) {
          await backend.resize(session, clampCols(msg.cols), clampRows(msg.rows));
        }
        if (!sized) {
          sized = true;
          setTimeout(sendUpdate, POLL_INTERVAL_MS);
        }
      }
    } catch (e: unknown) {
      if (e instanceof SyntaxError) return;
      log.warn("WS error", { session, error: errMsg(e) });
    }
  });

  ws.on("close", () => {
    alive = false;
    clearInterval(pingTimer);
    if (pollTimer) clearTimeout(pollTimer);
  });

  ws.on("error", () => {
    alive = false;
    clearInterval(pingTimer);
    if (pollTimer) clearTimeout(pollTimer);
  });
}

// ── PTY WS handler (ghostty-web WASM direct) ──

export function teardownPty(session: string): void {
  const entry = activePtySessions.get(session);
  if (!entry) return;
  entry.alive = false;
  activePtySessions.delete(session);
  if (entry.unsubscribe) {
    entry.unsubscribe();
    entry.unsubscribe = null;
  }
  if (entry.viewer) {
    try { entry.viewer.close(CLOSE_CODE_NORMAL, WS_CLOSE_REASONS.PTY_TEARDOWN); } catch (e: unknown) { log.debug(`teardownPty: viewer close failed`, { session, error: errMsg(e) }); }
    entry.viewer = null;
  }
  if (entry.pendingViewer) {
    try { entry.pendingViewer.close(CLOSE_CODE_NORMAL, WS_CLOSE_REASONS.PTY_TEARDOWN); } catch (e: unknown) { log.debug(`teardownPty: pendingViewer close failed`, { session, error: errMsg(e) }); }
    entry.pendingViewer = null;
  }
  if (entry.proc) {
    try { entry.proc.terminal!.close(); } catch (e: unknown) { log.debug(`teardownPty: terminal close failed`, { session, error: errMsg(e) }); }
    try { entry.proc.kill(); } catch (e: unknown) { log.debug(`teardownPty: proc kill failed`, { session, error: errMsg(e) }); }
  }
}

export function handlePtyWs(ws: WebSocket, session: string, reset = false): void {
  // Force teardown existing PTY so a fresh one is spawned at the caller's dimensions
  if (reset) {
    const stale = activePtySessions.get(session);
    if (stale && stale.alive) {
      teardownPty(session);
    }
  }

  const maybeExisting = activePtySessions.get(session);

  if (maybeExisting && maybeExisting.alive) {
    const existing = maybeExisting; // const binding for closure narrowing

    // ── Fast path: immediate takeover ──
    function performImmediateTakeover(dims: { cols: number; rows: number; prefillMode?: string } | null) {
      const oldViewer = existing.viewer;
      existing.viewer = null;
      if (oldViewer) {
        try { oldViewer.close(CLOSE_CODE_DISPLACED, WS_CLOSE_REASONS.DISPLACED); } catch (e: unknown) { log.debug(`takeover: oldViewer close failed`, { session, error: errMsg(e) }); }
      }
      if (existing.unsubscribe) {
        existing.unsubscribe();
        existing.unsubscribe = null;
      }
      const oldProc = existing.proc;
      existing.alive = false;
      activePtySessions.delete(session);
      if (oldProc) {
        try { oldProc.terminal!.close(); } catch (e: unknown) { log.debug(`takeover: terminal close failed`, { session, error: errMsg(e) }); }
        try { oldProc.kill(); } catch (e: unknown) { log.debug(`takeover: proc kill failed`, { session, error: errMsg(e) }); }
      }
      if (existing.pendingViewer) {
        try { existing.pendingViewer.close(CLOSE_CODE_DISPLACED, WS_CLOSE_REASONS.DISPLACED); } catch (e: unknown) { log.debug(`displaced pendingViewer close failed`, { session, error: errMsg(e) }); }
        existing.pendingViewer = null;
      }
      setupNewPtyEntry(ws, session, dims);
      try { ws.send(JSON.stringify({ type: "control_granted" })); } catch (e: unknown) { log.warn("control_granted send failed", { session, error: errMsg(e) }); }
    }

    // Session occupied — send conflict, hold connection open as pending
    ws.send(JSON.stringify({ type: "viewer_conflict" }));

    // If there's already a pending viewer, close it
    if (existing.pendingViewer) {
      try { existing.pendingViewer.close(CLOSE_CODE_DISPLACED, WS_CLOSE_REASONS.DISPLACED); } catch (e: unknown) { log.debug(`displaced pendingViewer close failed`, { session, error: errMsg(e) }); }
    }
    existing.pendingViewer = ws;

    const pingTimer = setInterval(() => {
      if (ws.readyState === 1) { try { ws.ping(); } catch (e: unknown) { log.debug(`pending ws ping failed`, { session, error: errMsg(e) }); } }
      else clearInterval(pingTimer);
    }, PING_INTERVAL_MS);

    let pendingAttachDims: { cols: number; rows: number; prefillMode?: string } | null = null;

    function cleanupPending() {
      clearInterval(pingTimer);
      if (existing.pendingViewer && existing.pendingViewer !== ws) {
        try { existing.pendingViewer.close(CLOSE_CODE_DISPLACED, WS_CLOSE_REASONS.DISPLACED); } catch (e: unknown) { log.debug(`cleanupPending: displaced other pending`, { session, error: errMsg(e) }); }
      }
      ws.removeListener("message", pendingMessage);
      ws.removeListener("close", cleanup);
      ws.removeListener("error", cleanup);
      existing.pendingViewer = null;
    }

    function pendingMessage(raw: Buffer | string) {
      try {
        const str = String(raw);
        const msg = JSON.parse(str);
        if (msg.type === "attach" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          const pm = typeof msg.prefillMode === "string" ? msg.prefillMode : undefined;
          pendingAttachDims = { cols: msg.cols, rows: msg.rows, prefillMode: pm };
          if (msg.takeControl) {
            cleanupPending();
            performImmediateTakeover(pendingAttachDims);
            return;
          }
          try { ws.send(JSON.stringify({ type: "attach_ack" })); } catch (e: unknown) { log.debug(`pending attach_ack send failed`, { session, error: errMsg(e) }); }
          return;
        }
        if (msg.type === "take_control") {
          if (!pendingAttachDims) {
            log.warn("take_control without prior attach — ignoring", { session });
            return;
          }
          cleanupPending();
          performImmediateTakeover(pendingAttachDims);
        }
      } catch (e: unknown) {
        if (!(e instanceof SyntaxError)) log.warn("pendingMessage handler failed", { session, error: errMsg(e) });
      }
    }

    function cleanup() {
      clearInterval(pingTimer);
      ws.removeListener("message", pendingMessage);
      ws.removeListener("close", cleanup);
      ws.removeListener("error", cleanup);
      if (existing.pendingViewer === ws) {
        existing.pendingViewer = null;
      }
    }
    ws.on("message", pendingMessage);
    ws.on("close", cleanup);
    ws.on("error", cleanup);
    return;
  }

  // No active PTY — create new entry
  setupNewPtyEntry(ws, session);
}

function setupNewPtyEntry(
  ws: WebSocket,
  session: string,
  initialDims?: { cols: number; rows: number; prefillMode?: string } | null,
): void {
  const entry = {
    viewer: ws as WebSocket | null,
    pendingViewer: null as WebSocket | null,
    proc: null as ReturnType<typeof Bun.spawn> | null,
    alive: true,
    unsubscribe: null as (() => void) | null,
  };
  activePtySessions.set(session, entry as any);
  let spawning = false;
  let latestRequestedSize: { cols: number; rows: number } | null = null;
  const VALID_PREFILL_MODES = ["full", "viewport", "none"] as const;
  type PrefillMode = typeof VALID_PREFILL_MODES[number];
  let pendingPrefillMode: PrefillMode = "full";

  // Entry is valid if still alive, still the registered session entry, and the
  // viewer WS hasn't been displaced by a takeover. Checked at every await
  // boundary during prefill/spawn so a late teardown doesn't send to a dead WS.
  const isCurrent = () =>
    entry.alive && activePtySessions.get(session) === entry && entry.viewer === ws;

  const backendType = getBackendTypeForSession(session);

  // ── PTY backend: attach WS directly to session's terminal I/O ──
  async function attachPtyBackend(
    cols: number,
    rows: number,
    options?: { prefillMode?: PrefillMode },
  ) {
    const prefillMode = options?.prefillMode ?? "full";
    latestRequestedSize = { cols, rows };
    if (entry.unsubscribe || spawning) return;
    spawning = true;
    if (process.env.WOLFPACK_TEST) {
      ptySpawnAttempts.set(session, (ptySpawnAttempts.get(session) || 0) + 1);
    }

    try {
      const ptyBackend = getRouter().getPtyBackend();

      if (!ptyBackend.isSessionAlive(session)) {
        entry.alive = false;
        activePtySessions.delete(session);
        if (entry.viewer) {
          try { entry.viewer.close(CLOSE_CODE_SESSION_UNAVAILABLE, WS_CLOSE_REASONS.SESSION_UNAVAILABLE); } catch (e: unknown) { log.debug(`session unavailable: viewer close failed`, { session, error: errMsg(e) }); }
          entry.viewer = null;
        }
        return;
      }

      if (!isCurrent()) return;

      // Send prefill from ring buffer (snapshot BEFORE resize so content is stable)
      if (prefillMode !== "none") {
        const prefill = ptyBackend.getSessionPrefill(session);
        if (prefill.length > 0 && entry.viewer && entry.viewer.readyState === 1) {
          let sendBuf: Buffer;
          if (prefill.length > DESKTOP_PREFILL_MAX_BYTES) {
            let start = prefill.length - DESKTOP_PREFILL_MAX_BYTES;
            while (start < prefill.length && prefill[start] !== 0x0a) start++;
            if (start < prefill.length) start++;
            sendBuf = prefill.subarray(start);
          } else {
            sendBuf = prefill;
          }

          if (prefillMode === "viewport") {
            entry.viewer.send(sendBuf);
            entry.viewer.send(JSON.stringify({ type: "prefill_viewport" }));
            sendPrefillDone(entry);
          } else {
            entry.viewer.send(JSON.stringify({ type: "prefill_viewport" }));
            await sendPrefillChunked(entry, sendBuf, session);
          }
        } else {
          sendPrefillDone(entry);
        }
      }

      if (!isCurrent()) return;

      // Subscribe to terminal output BEFORE resize — resize may trigger PTY
      // redraw output that must be forwarded to the viewer immediately.
      const unsub = ptyBackend.onSessionData(session, (data: Uint8Array) => {
        if (!entry.alive) return;
        if (entry.viewer && entry.viewer.readyState === 1) {
          try { entry.viewer.send(data); } catch (e: unknown) { log.debug(`PTY data send failed`, { session, error: errMsg(e) }); }
        }
      });
      entry.unsubscribe = unsub;

      // Resize to client dimensions — now that listener is attached, any
      // redraw output from the PTY will be forwarded to the viewer.
      await ptyBackend.resize(session, cols, rows);

      sendPtyReady(entry);
    } finally {
      spawning = false;
    }
  }

  // ── Tmux backend: spawn `tmux attach-session` as intermediate PTY ──
  async function spawnTmuxPty(
    cols: number,
    rows: number,
    options?: { prefillMode?: PrefillMode; skipPrefill?: boolean },
  ) {
    if (options?.prefillMode) pendingPrefillMode = options.prefillMode;
    else if (options?.skipPrefill === true) pendingPrefillMode = "none";
    latestRequestedSize = { cols, rows };
    if (entry.proc || spawning) return;
    spawning = true;
    if (process.env.WOLFPACK_TEST) {
      ptySpawnAttempts.set(session, (ptySpawnAttempts.get(session) || 0) + 1);
    }
    const prefillMode = pendingPrefillMode;
    pendingPrefillMode = "full";
    let prefill = Buffer.alloc(0);
    let pendingAttach = Buffer.alloc(0);
    let shouldDedupeInitialAttach = false;

    try {
      try {
        await exec(TMUX, ["has-session", "-t", session], { timeout: 2000 });
      } catch { /* expected: tmux session no longer exists */
        entry.alive = false;
        activePtySessions.delete(session);
        if (entry.viewer) {
          try { entry.viewer.close(CLOSE_CODE_SESSION_UNAVAILABLE, WS_CLOSE_REASONS.SESSION_UNAVAILABLE); } catch (e: unknown) { log.debug(`session unavailable: viewer close failed`, { session, error: errMsg(e) }); }
          entry.viewer = null;
        }
        return;
      }

      // Override window-size so resize-window works
      await exec(TMUX, ["set-option", "-t", session, "window-size", "latest"], { timeout: 2000 }).catch((e: unknown) => {
        log.debug(`tmux set-option window-size failed`, { session, error: errMsg(e) });
      });

      if (!isCurrent()) return;

      // Two-phase prefill:
      // Phase 1 (viewport): Send visible pane content for instant display.
      // Phase 2 (full only): Send full scrollback history.
      if (prefillMode !== "none") {
        // Phase 1: Viewport-only capture (no -S flag = visible pane only)
        try {
          const { stdout: viewportStdout } = await exec(TMUX, [
            "capture-pane", "-t", session, "-p", "-e",
          ], { timeout: 3000 });
          if (viewportStdout && entry.viewer && entry.viewer.readyState === 1) {
            const viewportBuf = Buffer.from(viewportStdout);
            entry.viewer.send(viewportBuf);
            entry.viewer.send(JSON.stringify({ type: "prefill_viewport" }));
            prefill = viewportBuf;
            shouldDedupeInitialAttach = true;
          }
        } catch (e: unknown) {
          log.warn("PTY viewport prefill capture failed", { session, error: errMsg(e) });
        }

        // Phase 2: Full scrollback (only if prefillMode === "full")
        if (prefillMode === "full" && entry.alive && entry.viewer && entry.viewer.readyState === 1) {
          let phase2Completed = false;
          try {
            const { stdout } = await exec(TMUX, [
              "capture-pane", "-t", session, "-p", "-e", "-S", `-${DESKTOP_PREFILL_HISTORY_LINES}`,
            ], { timeout: 3000 });
            if (stdout && entry.viewer && entry.viewer.readyState === 1) {
              const rawPrefill = Buffer.from(stdout);
              let fullPrefill: Buffer;
              if (rawPrefill.length > DESKTOP_PREFILL_MAX_BYTES) {
                let start = rawPrefill.length - DESKTOP_PREFILL_MAX_BYTES;
                while (start < rawPrefill.length && rawPrefill[start] !== 0x0a) start++;
                if (start < rawPrefill.length) start++;
                fullPrefill = rawPrefill.subarray(start);
              } else {
                fullPrefill = rawPrefill;
              }
              try {
                phase2Completed = await sendPrefillChunked(entry, fullPrefill, session);
                if (phase2Completed) prefill = fullPrefill;
              } catch (e: unknown) {
                log.error("PTY scrollback prefill send failed", { session, error: errMsg(e) });
              }
            }
          } catch (e: unknown) {
            log.warn("PTY scrollback prefill capture failed", { session, error: errMsg(e) });
          }
          if (!phase2Completed) sendPrefillDone(entry);
        } else if (prefillMode !== "full") {
          if (!sendPrefillDone(entry)) {
            log.debug("PTY viewport-only prefill_done not sent (WS closed)", { session });
          }
        }
      }

      if (!isCurrent()) return;

      const initialSize = latestRequestedSize || { cols, rows };
      const spawnedAt = Date.now();
      entry.proc = Bun.spawn([TMUX, "attach-session", "-t", session], {
        env: { ...process.env, TERM: "xterm-256color", LANG: "en_US.UTF-8" },
        terminal: {
          cols: initialSize.cols,
          rows: initialSize.rows,
          data(_terminal: unknown, data: Uint8Array) {
            if (!entry.alive) return;
            if (shouldDedupeInitialAttach) {
              pendingAttach = pendingAttach.length
                ? Buffer.concat([pendingAttach, data])
                : Buffer.from(data);
              const next = __stripInitialPtyOverlap(prefill, pendingAttach);
              if (next.awaitingMore) return;
              shouldDedupeInitialAttach = false;
              pendingAttach = Buffer.alloc(0);
              data = next.data;
              if (!data.length) return;
            }
            if (entry.viewer && entry.viewer.readyState === 1) {
              try { entry.viewer.send(data); } catch (e: unknown) { log.debug(`PTY data send failed`, { session, error: errMsg(e) }); }
            }
          },
          exit(_terminal: unknown, _code: number, _signal: string | null) {
            if (!entry.alive) return;
            entry.alive = false;
            activePtySessions.delete(session);
            const rapid = Date.now() - spawnedAt < RAPID_EXIT_THRESHOLD_MS;
            const code = rapid ? CLOSE_CODE_SESSION_UNAVAILABLE : CLOSE_CODE_NORMAL;
            const reason = rapid ? WS_CLOSE_REASONS.SESSION_UNAVAILABLE : WS_CLOSE_REASONS.PTY_EXITED;
            if (entry.viewer) {
              try { entry.viewer.close(code, reason); } catch (e: unknown) { log.debug(`pty exit: viewer close failed`, { session, error: errMsg(e) }); }
              entry.viewer = null;
            }
            if (entry.pendingViewer) {
              try { entry.pendingViewer.close(code, reason); } catch (e: unknown) { log.debug(`pty exit: pendingViewer close failed`, { session, error: errMsg(e) }); }
              entry.pendingViewer = null;
            }
          },
        }
      });
      activePtySessions.set(session, entry as any);
      sendPtyReady(entry);
      setTimeout(async () => {
        if (!entry.alive || !entry.proc) return;
        const latestSize = latestRequestedSize || initialSize;
        try {
          await exec(TMUX, ["set-option", "-t", session, "window-size", "latest"], { timeout: 2000 });
          await exec(TMUX, ["resize-window", "-t", session, "-x", String(latestSize.cols), "-y", String(latestSize.rows)], { timeout: 2000 });
        } catch (e: unknown) { log.debug(`post-spawn tmux resize failed`, { session, error: errMsg(e) }); }
        try {
          entry.proc.terminal!.resize(latestSize.cols, latestSize.rows);
        } catch (e: unknown) { log.debug(`post-spawn terminal resize failed`, { session, error: errMsg(e) }); }
      }, POST_SPAWN_RESIZE_DELAY_MS);
    } finally {
      spawning = false;
    }
  }

  // Select spawn function based on backend
  const spawnPty = backendType === "pty" ? attachPtyBackend : spawnTmuxPty;

  const rl = createRateLimiter(RATE_LIMIT_PER_SEC);
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  ws.on("message", (raw: Buffer | string, isBinary: boolean) => {
    if (!entry.alive) return;
    if (!rl.allow()) return;
    try {
      if (!isBinary) {
        if (raw.length > MAX_WS_MESSAGE_BYTES) return; // reject oversized JSON frames
        const msg = JSON.parse(String(raw));
        if (
          msg.type === "attach" &&
          typeof msg.cols === "number" &&
          typeof msg.rows === "number"
        ) {
          latestRequestedSize = { cols: clampCols(msg.cols), rows: clampRows(msg.rows) };
          const isAttached = backendType === "pty" ? !!entry.unsubscribe : !!entry.proc;
          if (!isAttached) {
            let prefillMode: PrefillMode = "full";
            if (typeof msg.prefillMode === "string" && VALID_PREFILL_MODES.includes(msg.prefillMode)) {
              prefillMode = msg.prefillMode as PrefillMode;
            } else if (msg.skipPrefill === true) {
              prefillMode = "none";
            }
            spawnPty(latestRequestedSize.cols, latestRequestedSize.rows, {
              prefillMode,
            });
          }
          if (entry.viewer && entry.viewer.readyState === 1) {
            try { entry.viewer.send(JSON.stringify({ type: "attach_ack" })); } catch (e: unknown) { log.debug(`attach_ack send failed`, { session, error: errMsg(e) }); }
            if (isAttached) {
              sendPtyReady(entry);
              sendPrefillDone(entry);
            }
          }
        } else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          const cols = clampCols(msg.cols);
          const rows = clampRows(msg.rows);
          latestRequestedSize = { cols, rows };
          const isAttached = backendType === "pty" ? !!entry.unsubscribe : !!entry.proc;
          if (!isAttached) {
            spawnPty(cols, rows);
          } else {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              resizeTimer = null;
              if (!entry.alive) return;
              if (backendType === "pty") {
                // Direct resize via backend
                getBackend().resize(session, cols, rows).catch((e: unknown) => {
                  log.debug(`pty backend resize failed`, { session, error: errMsg(e) });
                });
              } else {
                // Tmux: resize both the intermediate PTY and the tmux window
                if (!entry.proc) return;
                entry.proc.terminal!.resize(cols, rows);
                exec(TMUX, ["set-option", "-t", session, "window-size", "latest"], { timeout: 2000 })
                  .then(() => exec(TMUX, ["resize-window", "-t", session, "-x", String(cols), "-y", String(rows)], { timeout: 2000 }))
                  .catch((e: unknown) => { log.debug(`tmux resize failed`, { session, error: errMsg(e) }); });
              }
            }, RESIZE_DEBOUNCE_MS);
          }
        }
      } else {
        // Binary data — write to terminal
        if (Buffer.isBuffer(raw) && raw.length > MAX_PTY_BINARY_BYTES) return;
        if (backendType === "pty") {
          getRouter().getPtyBackend().writeToTerminal(session, raw as Buffer);
        } else if (entry.proc) {
          entry.proc.terminal!.write(raw as Buffer);
        }
      }
    } catch (e: unknown) {
      if (e instanceof SyntaxError) return;
      log.warn("PTY WS error", { session, error: errMsg(e) });
    }
  });

  const pingTimer = setInterval(() => {
    if (ws.readyState === 1) { try { ws.ping(); } catch (e: unknown) { log.debug(`pty ws ping failed`, { session, error: errMsg(e) }); } }
    else clearInterval(pingTimer);
  }, PING_INTERVAL_MS);

  function detach() {
    clearInterval(pingTimer);
    if (entry.alive && entry.viewer === ws && activePtySessions.get(session) === entry) {
      entry.viewer = null;
      teardownPty(session);
    }
  }
  ws.on("close", detach);
  ws.on("error", detach);

  // If initial dims were captured (e.g. from a pending viewer's attach before
  // take_control), spawn PTY immediately — saves a full round trip.
  if (initialDims && typeof initialDims.cols === "number" && typeof initialDims.rows === "number") {
    let prefillMode: PrefillMode = "full";
    if (typeof initialDims.prefillMode === "string" && VALID_PREFILL_MODES.includes(initialDims.prefillMode as PrefillMode)) {
      prefillMode = initialDims.prefillMode as PrefillMode;
    }
    latestRequestedSize = { cols: clampCols(initialDims.cols), rows: clampRows(initialDims.rows) };
    spawnPty(latestRequestedSize.cols, latestRequestedSize.rows, { prefillMode });
    if (entry.viewer && entry.viewer.readyState === 1) {
      try { entry.viewer.send(JSON.stringify({ type: "attach_ack" })); } catch (e: unknown) { log.debug(`immediate attach_ack send failed`, { session, error: errMsg(e) }); }
    }
  }
}
