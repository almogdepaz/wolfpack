/**
 * WebSocket handler for `/ws/pty` — binary PTY stream backed by the broker.
 *
 * Forwards broker output bytes to the viewer and viewer input back to
 * the broker. Handles takeover (a new viewer displaces the old one with
 * close code 4002), prefill replay from snapshot, and replay-truncated
 * resets when the broker's per-session ring overflows.
 */
import type { WebSocket } from "ws";
import {
  clampCols,
  clampRows,
} from "../validation.js";
import {
  CLOSE_CODE_NORMAL,
  CLOSE_CODE_POLICY_VIOLATION,
  CLOSE_CODE_SERVER_ERROR,
  CLOSE_CODE_SESSION_UNAVAILABLE,
  CLOSE_CODE_DISPLACED,
  PTY_BINARY_FRAME_MAX_BYTES,
  WS_CLOSE_REASONS,
} from "../ws-constants.js";
import { getBackend, getRouter } from "./backend.js";
import type { SessionBackend, PtyBackendMethods } from "./backend.js";
import { createRateLimiter, isAllowedSession } from "./http.js";
import { createLogger, errMsg } from "../log.js";
import { shouldFlushCoalescedOutput } from "../output-coalescing.js";
import {
  isTerminalLoadTimingEnabled,
  terminalLoadModeFromPrefill,
  terminalLoadTimingFields,
  type TerminalLoadMode,
} from "../terminal-load-timing.js";

const log = createLogger("ws");
const PTY_BINARY_BYTES_PER_SEC = PTY_BINARY_FRAME_MAX_BYTES * 60;
const TERMINAL_LOAD_TIMING_ENABLED = isTerminalLoadTimingEnabled(process.env);

interface ServerTerminalLoadTiming {
  readonly session: string;
  mode: TerminalLoadMode;
  readonly startMs: number;
  mark(event: string, extra?: Record<string, unknown>): void;
}

function createServerTerminalLoadTiming(session: string, mode: TerminalLoadMode = "unknown"): ServerTerminalLoadTiming | null {
  if (!TERMINAL_LOAD_TIMING_ENABLED) return null;
  const timing: ServerTerminalLoadTiming = {
    session,
    mode,
    startMs: performance.now(),
    mark(event: string, extra?: Record<string, unknown>): void {
      log.info("terminal_load", terminalLoadTimingFields({
        event,
        session: timing.session,
        mode: timing.mode,
        nowMs: performance.now(),
        startMs: timing.startMs,
        extra,
      }));
    },
  };
  return timing;
}

function testPrefillDelayMs(): number {
  if (!process.env.WOLFPACK_TEST) return 0;
  const raw = process.env.WOLFPACK_TEST_PREFILL_DELAY_MS;
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.round(n), 10_000);
}

// ── PTY session tracking ──

interface PtyEntry {
  viewer: WebSocket | null;
  pendingViewer: WebSocket | null;
  proc: ReturnType<typeof Bun.spawn> | null;
  alive: boolean;
  unsubscribe?: (() => void) | null;
  unsubscribeLifecycle?: (() => void) | null;
}

const VALID_PREFILL_MODES = ["full", "viewport", "none"] as const;
type PrefillMode = typeof VALID_PREFILL_MODES[number];

/** Shared state for a single attach lifecycle. `requestedSize.current` is
 *  mutated by the outer ws message handler (resize/attach frames) and read
 *  by the settle / quiescence loops — wrapped in a holder so all parties
 *  see the latest value. */
interface PtyEntryContext {
  readonly entry: PtyEntry;
  readonly session: string;
  readonly ws: WebSocket;
  readonly backend: SessionBackend & PtyBackendMethods;
  readonly requestedSize: { current: { cols: number; rows: number } | null };
  readonly layoutStable: { current: { cols: number; rows: number } | null };
  readonly timing: ServerTerminalLoadTiming | null;
}

export const activePtySessions = new Map<string, PtyEntry>();

const ptySpawnAttempts = new Map<string, number>();

function sameSize(a: { cols: number; rows: number } | null, b: { cols: number; rows: number } | null): boolean {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows;
}

// ── Constants ──
const DESKTOP_PREFILL_MAX_BYTES = 256 * 1024;
const VIEWPORT_PREFILL_SCROLLBACK_LINES = 0;
const PREFILL_CHUNK_SIZE = 32 * 1024;
const PREFILL_CHUNK_DELAY_MS = 8;
const PREFILL_OVERLAP_LIMIT = 32 * 1024;
const POLL_INTERVAL_MS = 50;
const POST_INPUT_DELAY_MS = 50;
const MAX_WS_MESSAGE_BYTES = 4096;
const PING_INTERVAL_MS = 25_000;
const RATE_LIMIT_PER_SEC = 60;
const RESIZE_DEBOUNCE_MS = 80;
const RAPID_EXIT_THRESHOLD_MS = 3_000;
const POST_SPAWN_RESIZE_DELAY_MS = 100;
// Pre-snapshot resize-settle wait: avoids the "scrollback flash" where each
// of the client's resize messages causes the shell (e.g. claude) to redraw
// its full screen on SIGWINCH — those redraws are then replayed via
// subscription as a streaming burst onto an already-revealed canvas.
//
// Strategy: defer ALL backend resizes until dims settle, then apply once at
// final dims. The shell sees one SIGWINCH and emits one redraw, captured by
// the snapshot. Cost: ~100-200ms of latency before prefill arrives. Worth
// it — eliminates the burst entirely instead of just hiding it on client.
const PRE_SNAPSHOT_RESIZE_SETTLE_MS = 100;
// Wait this long for the FIRST resize before assuming none is coming.
// Full prefill still needs a window for late layout settle, but desktop attach
// dims are already fit before attach. Keep this above viewport's 60ms while
// avoiding a fixed 200ms tax on every full switch.
const PRE_SNAPSHOT_RESIZE_INITIAL_WAIT_MS = 80;
const PRE_SNAPSHOT_RESIZE_TIMEOUT_MS = 400;
// Grid viewport attaches are already mounted in stable cells and fetch no
// broker scrollback, so they use a shorter resize settle budget than full
// desktop attaches while still coalescing same-turn resize frames.
const VIEWPORT_PRE_SNAPSHOT_RESIZE_SETTLE_MS = 40;
const VIEWPORT_PRE_SNAPSHOT_RESIZE_INITIAL_WAIT_MS = 60;
const VIEWPORT_PRE_SNAPSHOT_RESIZE_TIMEOUT_MS = 160;
// After applying the settled resize, wait for the shell's SIGWINCH-triggered
// redraw to fully land in the broker output stream so it's captured in the
// snapshot — NOT replayed via `sinceSeq` to a viewer whose canvas is already
// revealed.
//
// The naive 60ms blind sleep was wrong for heavy TUIs: claude's full-screen
// repaint takes 200-600ms wall-clock and emits 1000+ kernel-rate output
// chunks. With the old 60ms wait, the snapshot captured ~partial state and
// the rest streamed as 1.5MB of post-snapshot replay frames, painting
// mid-redraw fragments on the visible canvas (the "scrolldown" symptom).
//
// New strategy: observe broker output bytes via a temporary subscription and
// snapshot only when we see <QUIESCE_BYTE_THRESHOLD bytes in a rolling
// QUIESCE_WINDOW_MS window. Cap at QUIESCE_TIMEOUT_MS so a never-quiet
// session (animated spinner, log tail) still gets a snapshot in bounded
// time. Floor at QUIESCE_MIN_WAIT_MS so SIGWINCH has time to actually
// trigger redraws — if we snapshot before bytes start, we'd capture
// pre-redraw state and the redraw would still arrive as replay.
const QUIESCE_WINDOW_MS = 100;
const QUIESCE_BYTE_THRESHOLD = 1024;
const QUIESCE_TIMEOUT_MS = 800;
const QUIESCE_MIN_WAIT_MS = 50;
// Hard cap for sessions that never quiesce (animated TUIs: spinners,
// progress bars, htop, watch). Without this, an always-busy session waits
// the full QUIESCE_TIMEOUT_MS (800ms) before snapshotting, producing a
// visibly garbled mid-redraw prefill that the live stream then has to
// overwrite. Capping at 200ms cuts the worst-case prefill-garble window
// by 4x for animated sessions while leaving the common quiet-path
// behavior unchanged: real apps quiet inside QUIESCE_WINDOW_MS well
// before this cap is reached. Issue #129.
const QUIESCE_ANIMATED_CAP_MS = 160;

/**
 * Pure decision for the quiescence loop. Returns one of:
 *  - "continue" — keep observing
 *  - "quiet"     — recent byte rate below threshold, safe to snapshot
 *  - "animated_cap" — byte rate stayed high through the animated-cap
 *    window; we snapshot a (potentially mid-redraw) frame rather than
 *    wait the full timeout
 *  - "timeout"  — absolute settle timeout reached
 *
 * Exported for unit tests. The loop's setTimeout(16) wait and the resize
 * side-effects live at the call site.
 */
export function quiescenceDecision(args: {
  samples: Array<{ t: number; bytes: number }>;
  now: number;
  lastResizeAt: number;
  settleStart: number;
}): "continue" | "quiet" | "animated_cap" | "timeout" {
  const { samples, now, lastResizeAt, settleStart } = args;
  const elapsedTotal = now - settleStart;
  if (elapsedTotal >= QUIESCE_TIMEOUT_MS) return "timeout";
  const elapsedSinceResize = now - lastResizeAt;
  if (elapsedSinceResize < QUIESCE_MIN_WAIT_MS) return "continue";
  const cutoff = now - QUIESCE_WINDOW_MS;
  let recentBytes = 0;
  for (const s of samples) if (s.t >= cutoff) recentBytes += s.bytes;
  if (recentBytes < QUIESCE_BYTE_THRESHOLD) return "quiet";
  // Byte rate stayed high through the entire animated-cap window measured
  // from settle start. This is the always-busy TUI signature — don't wait
  // out the full 800ms timeout.
  if (elapsedTotal >= QUIESCE_ANIMATED_CAP_MS) return "animated_cap";
  return "continue";
}
// Adaptive coalescing of broker output frames before forwarding to viewer.
// See call site for full reasoning.
const COALESCE_FLUSH_MS = 16;
const COALESCE_HARD_MS = 150;
const COALESCE_MAX_BYTES = 128 * 1024;
// The browser can recover any dropped stream by reconnecting from the broker's
// canonical snapshot. Keeping more than 1 MiB queued for one throttled viewer
// therefore only risks process-wide memory pressure without improving fidelity.
const MAX_VIEWER_BUFFERED_BYTES = 1024 * 1024;

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

function sendPrefillDone(entry: { viewer: WebSocket | null; alive: boolean }, session: string): boolean {
  return safeViewerSend(entry, session, JSON.stringify({ type: "prefill_done" }));
}

function sendPtyReady(entry: { viewer: WebSocket | null; alive: boolean }, session: string): boolean {
  return safeViewerSend(entry, session, JSON.stringify({ type: "pty_ready" }));
}

/** True when `entry` is still the live, current owner of `session` and `ws`
 *  is still its active viewer. After every `await`, the entry may have been
 *  torn down, replaced by a takeover, or had its viewer displaced — bail
 *  if any of that happened. */
function entryStillCurrent(
  entry: { alive: boolean; viewer: WebSocket | null },
  session: string,
  ws: WebSocket,
): boolean {
  return entry.alive
    && (activePtySessions.get(session) as unknown) === entry
    && entry.viewer === ws;
}

/** Try-close a WebSocket and log failures at debug. The close codes used
 *  here (DISPLACED/SESSION_UNAVAILABLE/PTY_TEARDOWN/SERVER_ERROR/NORMAL)
 *  always succeed in practice; the try/catch exists to guard against the
 *  socket already being in a non-OPEN state. */
function tryWsClose(
  target: WebSocket,
  code: number,
  reason: string,
  logMsg: string,
  session: string,
): void {
  try { target.close(code, reason); }
  catch (e: unknown) { log.debug(logMsg, { session, error: errMsg(e) }); }
}

function viewerFrameBytes(data: Buffer | string): number {
  return typeof data === "string" ? Buffer.byteLength(data) : data.length;
}

/**
 * The broker snapshot is authoritative, so a viewer that cannot drain output
 * is closed rather than accumulating an unbounded server-side websocket queue.
 */
function safeViewerSend(
  entry: { viewer: WebSocket | null; alive: boolean },
  session: string,
  data: Buffer | string,
): boolean {
  const viewer = entry.viewer;
  if (!entry.alive || !viewer || viewer.readyState !== 1) return false;
  if (viewer.bufferedAmount + viewerFrameBytes(data) > MAX_VIEWER_BUFFERED_BYTES) {
    log.warn("slow terminal viewer exceeded output queue", {
      session,
      bufferedAmount: viewer.bufferedAmount,
      frameBytes: viewerFrameBytes(data),
      maxBufferedBytes: MAX_VIEWER_BUFFERED_BYTES,
    });
    tryWsClose(viewer, CLOSE_CODE_SERVER_ERROR, WS_CLOSE_REASONS.SLOW_VIEWER, "slow-viewer close failed", session);
    return false;
  }
  try {
    viewer.send(data);
    return true;
  } catch (e: unknown) {
    log.debug("terminal viewer send failed", { session, error: errMsg(e) });
    return false;
  }
}

export function notifySubSessionOpened(parentSession: string, session: string): boolean {
  const entry = activePtySessions.get(parentSession);
  if (!entry) return false;
  return safeViewerSend(entry, parentSession, JSON.stringify({
    type: "sub_session_opened",
    parentSession,
    session,
  }));
}

/** Send prefill buffer in 32KB chunks with short delays to avoid stalling mobile connections.
 *  Sends `prefill_done` message at the end so the client exits buffering state. */
async function sendPrefillChunked(
  entry: { viewer: WebSocket | null; alive: boolean },
  prefill: Buffer,
  session: string,
  timing?: ServerTerminalLoadTiming | null,
): Promise<boolean> {
  let offset = 0;
  let chunkIndex = 0;
  while (offset < prefill.length) {
    if (!entry.alive || !entry.viewer || entry.viewer.readyState !== 1) return false;
    const end = Math.min(offset + PREFILL_CHUNK_SIZE, prefill.length);
    if (!safeViewerSend(entry, session, prefill.subarray(offset, end))) return false;
    timing?.mark("prefill_chunk.send", { chunkIndex, bytes: end - offset });
    chunkIndex++;
    offset = end;
    if (offset < prefill.length) {
      await new Promise(resolve => setTimeout(resolve, PREFILL_CHUNK_DELAY_MS));
    }
  }
  return sendPrefillDone(entry, session);
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

export function teardownPty(session: string): void {
  const entry = activePtySessions.get(session);
  if (!entry) return;
  entry.alive = false;
  // Tear down sub/proc state BEFORE deleting from the map. Kill failures
  // are logged at warn (not debug) so an orphan PTY surfaces in the log
  // stream rather than silently accumulating. The map delete still happens
  // unconditionally in finally so a thrown kill never strands the entry —
  // a re-attach is always possible.
  try {
    if (entry.unsubscribe) {
      try { entry.unsubscribe(); } catch (e: unknown) { log.debug(`teardownPty: unsubscribe failed`, { session, error: errMsg(e) }); }
      entry.unsubscribe = null;
    }
    if (entry.unsubscribeLifecycle) {
      try { entry.unsubscribeLifecycle(); } catch (e: unknown) { log.debug(`teardownPty: unsubscribeLifecycle failed`, { session, error: errMsg(e) }); }
      entry.unsubscribeLifecycle = null;
    }
    if (entry.viewer) {
      tryWsClose(entry.viewer, CLOSE_CODE_NORMAL, WS_CLOSE_REASONS.PTY_TEARDOWN, "teardownPty: viewer close failed", session);
      entry.viewer = null;
    }
    if (entry.pendingViewer) {
      tryWsClose(entry.pendingViewer, CLOSE_CODE_NORMAL, WS_CLOSE_REASONS.PTY_TEARDOWN, "teardownPty: pendingViewer close failed", session);
      entry.pendingViewer = null;
    }
    if (entry.proc) {
      try { entry.proc.terminal!.close(); } catch (e: unknown) { log.debug(`teardownPty: terminal close failed`, { session, error: errMsg(e) }); }
      try { entry.proc.kill(); } catch (e: unknown) {
        // Warn (not debug): a swallowed kill failure means a zombie PTY
        // process is still running with no map reference — the operator
        // needs to see this to chase it down.
        log.warn(`teardownPty: proc kill failed; PTY may be orphaned`, { session, pid: entry.proc.pid, error: errMsg(e) });
      }
    }
  } finally {
    activePtySessions.delete(session);
  }
}

export function handlePtyWs(ws: WebSocket, session: string, reset = false): void {
  const initialTiming = createServerTerminalLoadTiming(session);
  initialTiming?.mark("upgrade.accepted", { reset });
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
        tryWsClose(oldViewer, CLOSE_CODE_DISPLACED, WS_CLOSE_REASONS.DISPLACED, "takeover: oldViewer close failed", session);
      }
      if (existing.unsubscribe) {
        existing.unsubscribe();
        existing.unsubscribe = null;
      }
      if (existing.unsubscribeLifecycle) {
        existing.unsubscribeLifecycle();
        existing.unsubscribeLifecycle = null;
      }
      const oldProc = existing.proc;
      existing.alive = false;
      activePtySessions.delete(session);
      if (oldProc) {
        try { oldProc.terminal!.close(); } catch (e: unknown) { log.debug(`takeover: terminal close failed`, { session, error: errMsg(e) }); }
        try { oldProc.kill(); } catch (e: unknown) { log.debug(`takeover: proc kill failed`, { session, error: errMsg(e) }); }
      }
      if (existing.pendingViewer) {
        tryWsClose(existing.pendingViewer, CLOSE_CODE_DISPLACED, WS_CLOSE_REASONS.DISPLACED, "displaced pendingViewer close failed", session);
        existing.pendingViewer = null;
      }
      setupNewPtyEntry(ws, session, dims, initialTiming);
      safeViewerSend({ viewer: ws, alive: true }, session, JSON.stringify({ type: "control_granted" }));
    }

    // Session occupied — send conflict, hold connection open as pending
    safeViewerSend({ viewer: ws, alive: true }, session, JSON.stringify({ type: "viewer_conflict" }));

    // If there's already a pending viewer, close it
    if (existing.pendingViewer) {
      tryWsClose(existing.pendingViewer, CLOSE_CODE_DISPLACED, WS_CLOSE_REASONS.DISPLACED, "displaced pendingViewer close failed", session);
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
        tryWsClose(existing.pendingViewer, CLOSE_CODE_DISPLACED, WS_CLOSE_REASONS.DISPLACED, "cleanupPending: displaced other pending", session);
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
          if (initialTiming) initialTiming.mode = terminalLoadModeFromPrefill(pm || "full");
          initialTiming?.mark("attach.parsed", {
            cols: clampCols(msg.cols),
            rows: clampRows(msg.rows),
            prefillMode: pm || "full",
          });
          if (msg.takeControl) {
            cleanupPending();
            performImmediateTakeover(pendingAttachDims);
            return;
          }
          safeViewerSend({ viewer: ws, alive: true }, session, JSON.stringify({ type: "attach_ack" }));
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
  setupNewPtyEntry(ws, session, undefined, initialTiming);
}

/** Returns true iff the helper should bail because the entry is no longer
 *  current. Convenience wrapper around {@link entryStillCurrent}. */
function bail(ctx: PtyEntryContext): boolean {
  return !entryStillCurrent(ctx.entry, ctx.session, ctx.ws);
}

/** Wait for the client's pre-snapshot resize messages to settle so we apply
 *  a single backend.resize at final dims (one SIGWINCH, one redraw, one
 *  snapshot capture). See call site comments at L477 for full reasoning.
 *  Returns the settled size, or `null` if the entry was torn down. */
async function waitForResizeSettle(
  ctx: PtyEntryContext,
  initialSize: { cols: number; rows: number },
  options?: { readonly initialWaitMs?: number; readonly settleMs?: number; readonly timeoutMs?: number },
): Promise<{ cols: number; rows: number } | null> {
  const initialWaitMs = options?.initialWaitMs ?? PRE_SNAPSHOT_RESIZE_INITIAL_WAIT_MS;
  const settleMs = options?.settleMs ?? PRE_SNAPSHOT_RESIZE_SETTLE_MS;
  const timeoutMs = options?.timeoutMs ?? PRE_SNAPSHOT_RESIZE_TIMEOUT_MS;
  let pendingSize = initialSize;
  ctx.timing?.mark("resize_settle.start", { cols: initialSize.cols, rows: initialSize.rows });
  const settleStart = Date.now();
  let lastChangeAt = -1;
  while (true) {
    if (bail(ctx)) return null;
    const elapsedTotal = Date.now() - settleStart;
    if (elapsedTotal >= timeoutMs) break;
    if (sameSize(ctx.layoutStable.current, pendingSize)) {
      break;
    }
    if (lastChangeAt < 0) {
      if (elapsedTotal >= initialWaitMs) break;
    } else {
      const elapsedSinceChange = Date.now() - lastChangeAt;
      if (elapsedSinceChange >= settleMs) break;
    }
    await new Promise(resolve => setTimeout(resolve, 16));
    const latest = ctx.requestedSize.current;
    if (latest && (latest.cols !== pendingSize.cols || latest.rows !== pendingSize.rows)) {
      pendingSize = latest;
      lastChangeAt = Date.now();
    }
  }
  ctx.timing?.mark("resize_settle.end", { cols: pendingSize.cols, rows: pendingSize.rows });
  return pendingSize;
}

/** Apply settled dims and wait for the SIGWINCH-triggered shell redraw to
 *  land in the broker stream so the snapshot captures it (not the live
 *  replay). Re-resizes mid-loop if the client sends another dim change.
 *  Returns the final applied size, or `null` if the entry was torn down.
 *  See call site comments at L553 for full reasoning. */
async function waitForOutputQuiescence(
  ctx: PtyEntryContext,
  pendingSize: { cols: number; rows: number },
): Promise<{ cols: number; rows: number } | null> {
  let appliedSize = pendingSize;
  const samples: Array<{ t: number; bytes: number }> = [];
  ctx.timing?.mark("quiescence_wait.start", { cols: pendingSize.cols, rows: pendingSize.rows });
  const observe = ctx.backend.onSessionData(ctx.session, (data: Uint8Array) => {
    samples.push({ t: Date.now(), bytes: data.length });
  }, {
    // Probe-only observer for the resize-settle window. If the
    // subscribe RPC fails here, the main per-viewer subscription
    // (registered after settle) carries its own teardown handler;
    // this probe just stops collecting samples — settle will time
    // out naturally and we move on.
    onSubscribeError: (err: unknown) => {
      log.debug("resize-settle observer subscribe failed", { session: ctx.session, error: errMsg(err) });
    },
  });
  try {
    await ctx.backend.resize(ctx.session, appliedSize.cols, appliedSize.rows);
    let lastResizeAt = Date.now();
    const settleStart = lastResizeAt;
    while (true) {
      if (bail(ctx)) break;
      // Dim changed since we last applied? Re-resize and restart the
      // quiescence clock so we capture this redraw too.
      const latest = ctx.requestedSize.current;
      if (latest && (latest.cols !== appliedSize.cols || latest.rows !== appliedSize.rows)) {
        appliedSize = latest;
        await ctx.backend.resize(ctx.session, appliedSize.cols, appliedSize.rows);
        lastResizeAt = Date.now();
      }
      const now = Date.now();
      // Trim samples outside the rolling window so the array stays
      // bounded across long never-quiet sessions.
      const cutoff = now - QUIESCE_WINDOW_MS;
      while (samples.length > 0 && samples[0].t < cutoff) samples.shift();
      const decision = quiescenceDecision({ samples, now, lastResizeAt, settleStart });
      if (decision !== "continue") {
        if (decision === "animated_cap" || decision === "timeout") {
          log.debug("quiescence loop exited without quiet", { session: ctx.session, reason: decision, elapsedMs: now - settleStart });
        }
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 16));
    }
  } finally {
    if (observe) observe();
  }
  ctx.timing?.mark("quiescence_wait.end", { cols: appliedSize.cols, rows: appliedSize.rows });
  return bail(ctx) ? null : appliedSize;
}

/** Full prefill can overlap the initial resize-settle window with the
 *  SIGWINCH redraw wait: apply the attach dims immediately, observe output
 *  while still waiting for late client resize messages, and snapshot only
 *  once both dimensions are stable and output has quiesced. */
async function waitForSettledResizeAndOutputQuiescence(
  ctx: PtyEntryContext,
  initialSize: { cols: number; rows: number },
  options?: { readonly initialWaitMs?: number; readonly settleMs?: number; readonly timeoutMs?: number },
): Promise<{ cols: number; rows: number } | null> {
  const initialWaitMs = options?.initialWaitMs ?? PRE_SNAPSHOT_RESIZE_INITIAL_WAIT_MS;
  const settleMs = options?.settleMs ?? PRE_SNAPSHOT_RESIZE_SETTLE_MS;
  const timeoutMs = options?.timeoutMs ?? PRE_SNAPSHOT_RESIZE_TIMEOUT_MS;
  let pendingSize = initialSize;
  let appliedSize = initialSize;
  let lastChangeAt = -1;
  const samples: Array<{ t: number; bytes: number }> = [];

  ctx.timing?.mark("resize_settle.start", { cols: initialSize.cols, rows: initialSize.rows });
  ctx.timing?.mark("quiescence_wait.start", { cols: initialSize.cols, rows: initialSize.rows });

  const observe = ctx.backend.onSessionData(ctx.session, (data: Uint8Array) => {
    samples.push({ t: Date.now(), bytes: data.length });
  }, {
    onSubscribeError: (err: unknown) => {
      log.debug("resize-settle observer subscribe failed", { session: ctx.session, error: errMsg(err) });
    },
  });

  let lastResizeAt = Date.now();
  const settleStart = lastResizeAt;
  try {
    await ctx.backend.resize(ctx.session, appliedSize.cols, appliedSize.rows);
    lastResizeAt = Date.now();

    while (true) {
      if (bail(ctx)) break;
      const latest = ctx.requestedSize.current;
      if (latest && (latest.cols !== pendingSize.cols || latest.rows !== pendingSize.rows)) {
        pendingSize = latest;
        lastChangeAt = Date.now();
      }
      if (pendingSize.cols !== appliedSize.cols || pendingSize.rows !== appliedSize.rows) {
        appliedSize = pendingSize;
        await ctx.backend.resize(ctx.session, appliedSize.cols, appliedSize.rows);
        lastResizeAt = Date.now();
      }

      const now = Date.now();
      const elapsedTotal = now - settleStart;
      const resizeStable = elapsedTotal >= timeoutMs
        || sameSize(ctx.layoutStable.current, pendingSize)
        || (lastChangeAt < 0 ? elapsedTotal >= initialWaitMs : now - lastChangeAt >= settleMs);

      const cutoff = now - QUIESCE_WINDOW_MS;
      while (samples.length > 0 && samples[0].t < cutoff) samples.shift();
      const decision = quiescenceDecision({ samples, now, lastResizeAt, settleStart });
      const outputStable = decision !== "continue";
      if (outputStable && (decision === "animated_cap" || decision === "timeout")) {
        log.debug("quiescence loop exited without quiet", { session: ctx.session, reason: decision, elapsedMs: now - settleStart });
      }
      if (resizeStable && outputStable) break;
      await new Promise(resolve => setTimeout(resolve, 16));
    }
  } finally {
    if (observe) observe();
  }

  ctx.timing?.mark("resize_settle.end", { cols: appliedSize.cols, rows: appliedSize.rows });
  ctx.timing?.mark("quiescence_wait.end", { cols: appliedSize.cols, rows: appliedSize.rows });
  return bail(ctx) ? null : appliedSize;
}

/** Take a broker snapshot at `appliedSize.cols` and stream it to the viewer.
 *  Returns the prefill seq (used as `sinceSeq` for live subscribe) or
 *  undefined when no snapshot is required (prefillMode === "none" or
 *  empty data). */
async function sendSnapshotPrefill(
  ctx: PtyEntryContext,
  appliedSize: { cols: number; rows: number },
  prefillMode: PrefillMode,
): Promise<bigint | undefined> {
  if (prefillMode === "none") {
    ctx.timing?.mark("prefill_send.start", { bytes: 0, prefillMode });
    ctx.timing?.mark("prefill_send.end", { bytes: 0, prefillMode });
    return undefined;
  }
  const scrollbackLines = prefillMode === "viewport" ? VIEWPORT_PREFILL_SCROLLBACK_LINES : undefined;
  ctx.timing?.mark("snapshot_fetch.start", { cols: appliedSize.cols, rows: appliedSize.rows, scrollbackLines });
  const prefill = await ctx.backend.getSessionPrefill(ctx.session, appliedSize.cols, { scrollbackLines });
  ctx.timing?.mark("snapshot_fetch.end", { bytes: prefill.data.length, scrollbackLines });
  const prefillSeq = prefill.seq;
  ctx.timing?.mark("prefill_send.start", { bytes: prefill.data.length, prefillMode });
  const delayMs = testPrefillDelayMs();
  if (delayMs > 0) {
    ctx.timing?.mark("prefill_delay.start", { delayMs });
    await new Promise(resolve => setTimeout(resolve, delayMs));
    ctx.timing?.mark("prefill_delay.end", { delayMs });
  }
  if (prefill.data.length > 0 && ctx.entry.viewer && ctx.entry.viewer.readyState === 1) {
    let sendBuf: Buffer;
    if (prefill.data.length > DESKTOP_PREFILL_MAX_BYTES) {
      let start = prefill.data.length - DESKTOP_PREFILL_MAX_BYTES;
      while (start < prefill.data.length && prefill.data[start] !== 0x0a) start++;
      if (start < prefill.data.length) start++;
      sendBuf = prefill.data.subarray(start);
    } else {
      sendBuf = prefill.data;
    }

    if (prefillMode === "viewport") {
      if (!safeViewerSend(ctx.entry, ctx.session, sendBuf)) return prefillSeq;
      ctx.timing?.mark("prefill_chunk.send", { chunkIndex: 0, bytes: sendBuf.length });
      if (!safeViewerSend(ctx.entry, ctx.session, JSON.stringify({ type: "prefill_viewport" }))) return prefillSeq;
      sendPrefillDone(ctx.entry, ctx.session);
    } else {
      await sendPrefillChunked(ctx.entry, sendBuf, ctx.session, ctx.timing);
    }
  } else {
    sendPrefillDone(ctx.entry, ctx.session);
  }
  ctx.timing?.mark("prefill_send.end", { bytes: prefill.data.length, prefillMode });
  return prefillSeq;
}

/** Subscribe to the broker's live output stream and wire it to the viewer
 *  with adaptive coalescing (see comments below for rationale). Also sets
 *  up the lifecycle subscription. Mutates `ctx.entry.unsubscribe` and
 *  `ctx.entry.unsubscribeLifecycle`. Returns `true` if the subscription
 *  was established, `false` if the session vanished and the viewer was
 *  closed. */
function subscribeWithCoalescing(
  ctx: PtyEntryContext,
  prefillSeq: bigint | undefined,
): boolean {
  const { entry, session, backend } = ctx;

  // Subscribe after prefill. sinceSeq: prefillSeq replays any broker output
  // (e.g. post-resize redraws) that arrived after the snapshot was taken.
  //
  // ── Adaptive coalescing ──
  // Broker forwards every PTY-read chunk as a separate output frame.
  // macOS PTY delivers ~1KB clusters during heavy TUI redraws (claude
  // SIGWINCH repaint = 1500 chunks @ 1024 bytes). Without coalescing,
  // each chunk = one ws.send = one browser macrotask = one ghostty parse
  // pass; ghostty paints between chunks as rAF fires, so the user sees
  // mid-redraw fragments scrolling/painting incrementally.
  //
  // Strategy: append to a buffer + arm a flush timer for COALESCE_FLUSH_MS
  // (one rAF). Each new chunk resets the timer. Hard cap at
  // COALESCE_HARD_MS so continuous streams don't stall. Result: ghostty
  // sees one larger atomic write per logical TUI frame, never mid-redraw.
  //
  // Latency cost: ~16ms on output (single keystroke echo: 25 → ~41ms).
  // Imperceptible vs the visual mess of mid-redraw scrolldown.
  let _coalesceBuf: Buffer[] = [];
  let _coalesceBytes = 0;
  let _coalesceTimer: NodeJS.Timeout | null = null;
  let _coalesceFirstPushAt = 0;
  let _sawFirstOutputForward = false;
  const sendOutputBuffer = (buf: Buffer): void => {
    if (!entry.viewer || entry.viewer.readyState !== 1) return;
    if (!_sawFirstOutputForward) {
      _sawFirstOutputForward = true;
      ctx.timing?.mark("first_output.forward", { bytes: buf.length });
    }
    for (let offset = 0; offset < buf.length; offset += COALESCE_MAX_BYTES) {
      const chunk = buf.subarray(offset, Math.min(offset + COALESCE_MAX_BYTES, buf.length));
      if (!safeViewerSend(entry, session, chunk)) return;
    }
  };
  const flushCoalesce = (): void => {
    if (_coalesceTimer) { clearTimeout(_coalesceTimer); _coalesceTimer = null; }
    if (!_coalesceBuf.length) return;
    const merged = _coalesceBuf.length === 1 ? _coalesceBuf[0] : Buffer.concat(_coalesceBuf, _coalesceBytes);
    _coalesceBuf = [];
    _coalesceBytes = 0;
    _coalesceFirstPushAt = 0;
    sendOutputBuffer(merged);
  };
  ctx.timing?.mark("subscribe.start", { sinceSeq: typeof prefillSeq === "bigint" ? prefillSeq.toString() : undefined });
  const unsub = backend.onSessionData(session, (data: Uint8Array) => {
    if (!entry.alive) return;
    if (!entry.viewer || entry.viewer.readyState !== 1) return;
    const now = Date.now();
    const next = Buffer.from(data);
    const heldFor = _coalesceFirstPushAt ? now - _coalesceFirstPushAt : 0;
    if (_coalesceBuf.length > 0 && shouldFlushCoalescedOutput({
      queuedBytes: _coalesceBytes,
      nextBytes: next.length,
      maxBytes: COALESCE_MAX_BYTES,
      heldMs: heldFor,
      hardMs: COALESCE_HARD_MS,
    })) {
      flushCoalesce();
    }
    if (next.length >= COALESCE_MAX_BYTES) {
      sendOutputBuffer(next);
      return;
    }
    if (_coalesceBuf.length === 0) _coalesceFirstPushAt = now;
    _coalesceBuf.push(next);
    _coalesceBytes += next.length;
    if (_coalesceTimer) clearTimeout(_coalesceTimer);
    _coalesceTimer = setTimeout(flushCoalesce, COALESCE_FLUSH_MS);
  }, {
    sinceSeq: prefillSeq,
    // When the broker `subscribe` RPC fails after onSessionData
    // returns, the backend unwinds locally but the WS would otherwise
    // stay open with no data stream. Tear down so the client gets a
    // 1011 close and can surface an error / retry, instead of staring
    // at a dead viewer.
    onSubscribeError: (err: unknown) => {
      log.warn("subscribe rpc failed — tearing down viewer", { session, error: errMsg(err) });
      if (!entry.alive) return;
      if (entry.viewer && entry.viewer.readyState === 1) {
        tryWsClose(entry.viewer, CLOSE_CODE_SERVER_ERROR, WS_CLOSE_REASONS.SUBSCRIBE_FAILED, "subscribe-error: viewer close failed", session);
      }
      teardownPty(session);
    },
  });
  if (!unsub) {
    log.warn("onSessionData returned null — session vanished", { session });
    entry.alive = false;
    activePtySessions.delete(session);
    if (entry.viewer) {
      tryWsClose(entry.viewer, CLOSE_CODE_SESSION_UNAVAILABLE, WS_CLOSE_REASONS.SESSION_UNAVAILABLE, "onSessionData null: viewer close failed", session);
      entry.viewer = null;
    }
    return false;
  }
  ctx.timing?.mark("subscribe.success");
  // Wrap unsub so the coalesce timer + buffer don't leak past detach.
  // Drop the buffer rather than flushing: viewer is gone, no point.
  entry.unsubscribe = () => {
    if (_coalesceTimer) { clearTimeout(_coalesceTimer); _coalesceTimer = null; }
    _coalesceBuf = [];
    _coalesceBytes = 0;
    unsub();
  };

  // Lifecycle: broker fires `session_exited` when the child reaps.
  // Close the viewer with 4001 so the client distinguishes a remote-side
  // session death from a normal disconnect. PtyBackend's stub no-ops.
  const lifecycleUnsub = backend.onSessionLifecycle(session, (event) => {
    if (event.kind === "replay_truncated") {
      // Broker ring overran during a lag window — our cached prefill
      // and any bytes since are out of sync with broker truth. Tear
      // the viewer down with 1011 so the client reconnects and
      // re-prefills from a fresh snapshot, instead of staring at stale
      // terminal content.
      if (!entry.alive) return;
      log.warn("replay_truncated — forcing client reconnect for fresh snapshot", { session });
      if (entry.viewer && entry.viewer.readyState === 1) {
        tryWsClose(entry.viewer, CLOSE_CODE_SERVER_ERROR, WS_CLOSE_REASONS.SUBSCRIBE_FAILED, "replay_truncated: viewer close failed", session);
      }
      teardownPty(session);
      return;
    }
    if (event.kind !== "exited") return;
    if (!entry.alive) return;
    entry.alive = false;
    if (activePtySessions.get(session) === entry) {
      activePtySessions.delete(session);
    }
    if (entry.unsubscribe) {
      try { entry.unsubscribe(); } catch (e: unknown) { log.debug(`lifecycle exit: data unsub failed`, { session, error: errMsg(e) }); }
      entry.unsubscribe = null;
    }
    // Don't invoke our own unsub here — broker drops the lifecycle set on
    // exit anyway, and we're inside the callback. Just null the ref.
    entry.unsubscribeLifecycle = null;
    if (entry.viewer) {
      tryWsClose(entry.viewer, CLOSE_CODE_SESSION_UNAVAILABLE, WS_CLOSE_REASONS.SESSION_UNAVAILABLE, "lifecycle exit: viewer close failed", session);
      entry.viewer = null;
    }
    if (entry.pendingViewer) {
      tryWsClose(entry.pendingViewer, CLOSE_CODE_SESSION_UNAVAILABLE, WS_CLOSE_REASONS.SESSION_UNAVAILABLE, "lifecycle exit: pendingViewer close failed", session);
      entry.pendingViewer = null;
    }
  });
  if (lifecycleUnsub) entry.unsubscribeLifecycle = lifecycleUnsub;
  return true;
}

function setupNewPtyEntry(
  ws: WebSocket,
  session: string,
  initialDims?: { cols: number; rows: number; prefillMode?: string } | null,
  timing?: ServerTerminalLoadTiming | null,
): void {
  const entry: PtyEntry = {
    viewer: ws as WebSocket | null,
    pendingViewer: null,
    proc: null,
    alive: true,
    unsubscribe: null,
    unsubscribeLifecycle: null,
  };
  activePtySessions.set(session, entry);
  let spawning = false;
  const requestedSize: { current: { cols: number; rows: number } | null } = { current: null };
  const layoutStable: { current: { cols: number; rows: number } | null } = { current: null };

  // Streaming attach path: snapshot prefill + subscribe to broker output stream.
  const streamingBackend: (SessionBackend & PtyBackendMethods) | null =
    getRouter().getStreamingBackendForSession(session);

  if (!streamingBackend) {
    log.warn("ws attach: streaming backend unavailable", { session });
    tryWsClose(ws, CLOSE_CODE_SESSION_UNAVAILABLE, WS_CLOSE_REASONS.SESSION_UNAVAILABLE, "streaming backend missing close failed", session);
    activePtySessions.delete(session);
    return;
  }

  // ── Snapshot + subscribe attach path (PTY backend in-process, broker over RPC) ──
  // Orchestrator only — sequencing logic lives in the helpers above:
  // settle dimensions/output → sendSnapshotPrefill → subscribeWithCoalescing.
  async function attachStreamingBackend(
    backend: SessionBackend & PtyBackendMethods,
    cols: number,
    rows: number,
    options?: { prefillMode?: PrefillMode },
  ): Promise<void> {
    const prefillMode = options?.prefillMode ?? "full";
    if (timing) timing.mode = terminalLoadModeFromPrefill(prefillMode);
    requestedSize.current = { cols, rows };
    if (entry.unsubscribe || spawning) return;
    spawning = true;
    if (process.env.WOLFPACK_TEST) {
      ptySpawnAttempts.set(session, (ptySpawnAttempts.get(session) || 0) + 1);
    }

    try {
      if (!backend.isSessionAlive(session)) {
        // Cache may be stale: BrokerBackend's isSessionAlive() only consults
        // the in-memory nameToId map, which lags behind broker truth after
        // a broker restart or out-of-band session creation. Refresh once
        // via list() and re-check before closing 4001 — legitimate live
        // sessions should not be rejected just because the local cache
        // hasn't seen them yet.
        try { await backend.list(); } catch (e: unknown) {
          log.debug("isSessionAlive miss: list() refresh failed", { session, error: errMsg(e) });
        }
        if (!backend.isSessionAlive(session)) {
          entry.alive = false;
          activePtySessions.delete(session);
          if (entry.viewer) {
            tryWsClose(entry.viewer, CLOSE_CODE_SESSION_UNAVAILABLE, WS_CLOSE_REASONS.SESSION_UNAVAILABLE, "session unavailable: viewer close failed", session);
            entry.viewer = null;
          }
          return;
        }
      }

      if (!entryStillCurrent(entry, session, ws)) return;

      const ctx: PtyEntryContext = { entry, session, ws, backend, requestedSize, layoutStable, timing: timing || null };

      if (prefillMode === "none") {
        if (!subscribeWithCoalescing(ctx, undefined)) return;
        const latest = requestedSize.current ?? { cols, rows };
        timing?.mark("resize_apply.start", { cols: latest.cols, rows: latest.rows, prefillMode });
        await backend.resize(session, latest.cols, latest.rows);
        timing?.mark("resize_apply.end", { cols: latest.cols, rows: latest.rows, prefillMode });
        if (!entryStillCurrent(entry, session, ws)) return;
        timing?.mark("pty_ready.send");
        sendPtyReady(entry, session);
        return;
      }

      // Both prefill modes snapshot after the resize-triggered redraw settles.
      // Viewport first coalesces dimensions, then observes output around one
      // final resize; applying attach dimensions immediately would produce a
      // second SIGWINCH when a same-turn cell fit arrives.
      let appliedSize: { cols: number; rows: number };
      if (prefillMode === "viewport") {
        const pending = await waitForResizeSettle(ctx, { cols, rows }, {
          initialWaitMs: VIEWPORT_PRE_SNAPSHOT_RESIZE_INITIAL_WAIT_MS,
          settleMs: VIEWPORT_PRE_SNAPSHOT_RESIZE_SETTLE_MS,
          timeoutMs: VIEWPORT_PRE_SNAPSHOT_RESIZE_TIMEOUT_MS,
        });
        if (pending === null) return;
        const settled = await waitForOutputQuiescence(ctx, pending);
        if (settled === null) return;
        appliedSize = settled;
      } else {
        const settled = await waitForSettledResizeAndOutputQuiescence(ctx, { cols, rows });
        if (settled === null) return;
        appliedSize = settled;
      }

      // Snapshot AFTER resize so scrollback is reflowed to client cols.
      const prefillSeq = await sendSnapshotPrefill(ctx, appliedSize, prefillMode);

      if (!entryStillCurrent(entry, session, ws)) return;

      // Final reconciliation catches resize frames that arrived while the
      // snapshot bytes were being fetched/sent. The resulting SIGWINCH
      // redraw lands in the live stream with seq > prefillSeq; the coalesce
      // logic in subscribeWithCoalescing holds it through ghostty's render
      // cycle so it never paints as mid-redraw fragments.
      const latest = requestedSize.current;
      if (latest && (latest.cols !== appliedSize.cols || latest.rows !== appliedSize.rows)) {
        appliedSize = latest;
        await backend.resize(session, appliedSize.cols, appliedSize.rows);
        if (!entryStillCurrent(entry, session, ws)) return;
      }

      if (!subscribeWithCoalescing(ctx, prefillSeq)) return;

      timing?.mark("pty_ready.send");
      sendPtyReady(entry, session);
    } finally {
      spawning = false;
    }
  }

  // Backend-uniform spawn — both PTY and broker use attachStreamingBackend.
  const spawnPty = (cols: number, rows: number, options?: { prefillMode?: PrefillMode; skipPrefill?: boolean }): Promise<void> => {
    let prefillMode: PrefillMode | undefined = options?.prefillMode;
    if (!prefillMode && options?.skipPrefill === true) prefillMode = "none";
    return attachStreamingBackend(streamingBackend, cols, rows, prefillMode ? { prefillMode } : undefined);
  };

  const rl = createRateLimiter(RATE_LIMIT_PER_SEC);
  const binaryInputLimiter = createRateLimiter(PTY_BINARY_BYTES_PER_SEC);
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  ws.on("message", (raw: Buffer | string, isBinary: boolean) => {
    if (!entry.alive) return;
    try {
      if (!isBinary) {
        if (!rl.allow()) return;
        if (raw.length > MAX_WS_MESSAGE_BYTES) return; // reject oversized JSON frames
        const msg = JSON.parse(String(raw));
        if (
          msg.type === "attach" &&
          typeof msg.cols === "number" &&
          typeof msg.rows === "number"
        ) {
          requestedSize.current = { cols: clampCols(msg.cols), rows: clampRows(msg.rows) };
          const isAttached = !!entry.unsubscribe;
          let prefillMode: PrefillMode = "full";
          if (typeof msg.prefillMode === "string" && VALID_PREFILL_MODES.includes(msg.prefillMode)) {
            prefillMode = msg.prefillMode as PrefillMode;
          } else if (msg.skipPrefill === true) {
            prefillMode = "none";
          }
          if (timing) {
            timing.mode = terminalLoadModeFromPrefill(prefillMode);
            timing.mark("attach.parsed", {
              cols: requestedSize.current.cols,
              rows: requestedSize.current.rows,
              prefillMode,
            });
          }
          if (entry.viewer && entry.viewer.readyState === 1) {
            safeViewerSend(entry, session, JSON.stringify({ type: "attach_ack" }));
          }
          if (!isAttached) {
            spawnPty(requestedSize.current.cols, requestedSize.current.rows, {
              prefillMode,
            });
          } else {
            sendPtyReady(entry, session);
            if (prefillMode !== "none") sendPrefillDone(entry, session);
          }
        } else if (msg.type === "layout_stable" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          layoutStable.current = { cols: clampCols(msg.cols), rows: clampRows(msg.rows) };
          timing?.mark("layout_stable", { cols: layoutStable.current.cols, rows: layoutStable.current.rows });
        } else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          const cols = clampCols(msg.cols);
          const rows = clampRows(msg.rows);
          requestedSize.current = { cols, rows };
          const isAttached = !!entry.unsubscribe;
          if (!isAttached) {
            spawnPty(cols, rows);
          } else {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              resizeTimer = null;
              if (!entry.alive) return;
              streamingBackend.resize(session, cols, rows).then(() => {
                if (!entryStillCurrent(entry, session, ws)) return;
              }).catch((e: unknown) => {
                if (!entryStillCurrent(entry, session, ws)) return;
                log.warn("streaming backend resize failed — reconnecting viewer", { session, error: errMsg(e) });
                tryWsClose(ws, CLOSE_CODE_SERVER_ERROR, WS_CLOSE_REASONS.RESIZE_FAILED, "resize failure viewer close failed", session);
              });
            }, RESIZE_DEBOUNCE_MS);
          }
        }
      } else {
        // Binary data — write to terminal via the streaming backend.
        if (Buffer.isBuffer(raw) && raw.length > PTY_BINARY_FRAME_MAX_BYTES) return;
        if (!binaryInputLimiter.allow(raw.length)) {
          tryWsClose(ws, CLOSE_CODE_POLICY_VIOLATION, WS_CLOSE_REASONS.INPUT_RATE_LIMITED, "input rate limit viewer close failed", session);
          return;
        }
        if (!streamingBackend.writeToTerminal(session, raw as Buffer)) {
          log.warn("terminal input write failed", { session });
          ws.close(CLOSE_CODE_SERVER_ERROR, WS_CLOSE_REASONS.WRITE_FAILED);
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
    if (entryStillCurrent(entry, session, ws)) {
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
    requestedSize.current = { cols: clampCols(initialDims.cols), rows: clampRows(initialDims.rows) };
    if (timing) {
      timing.mode = terminalLoadModeFromPrefill(prefillMode);
      timing.mark("attach.parsed", {
        cols: requestedSize.current.cols,
        rows: requestedSize.current.rows,
        prefillMode,
      });
    }
    spawnPty(requestedSize.current.cols, requestedSize.current.rows, { prefillMode });
    safeViewerSend(entry, session, JSON.stringify({ type: "attach_ack" }));
  }
}
