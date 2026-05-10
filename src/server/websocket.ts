/**
 * WebSocket handlers — PTY (ghostty-web WASM) + classic terminal (text polling).
 *
 * Backend-agnostic: works with both TmuxBackend (spawns `tmux attach-session`)
 * and PtyBackend (pipes WS directly to session terminal I/O).
 */
import type { WebSocket } from "ws";
import {
  clampCols,
  clampRows,
} from "../validation.js";
import {
  CLOSE_CODE_NORMAL,
  CLOSE_CODE_SERVER_ERROR,
  CLOSE_CODE_SESSION_UNAVAILABLE,
  CLOSE_CODE_DISPLACED,
  WS_CLOSE_REASONS,
} from "../ws-constants.js";
import { getBackend, getRouter } from "./backend.js";
import type { SessionBackend, PtyBackendMethods } from "./backend.js";
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
  unsubscribeLifecycle?: (() => void) | null;
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
// Covers session-open CSS transitions (~200ms total) + WS jitter.
const PRE_SNAPSHOT_RESIZE_INITIAL_WAIT_MS = 200;
const PRE_SNAPSHOT_RESIZE_TIMEOUT_MS = 400;
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
const QUIESCE_MIN_WAIT_MS = 80;
// Adaptive coalescing of broker output frames before forwarding to viewer.
// See call site for full reasoning.
const COALESCE_FLUSH_MS = 16;
const COALESCE_HARD_MS = 150;

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

export function teardownPty(session: string): void {
  const entry = activePtySessions.get(session);
  if (!entry) return;
  entry.alive = false;
  activePtySessions.delete(session);
  if (entry.unsubscribe) {
    entry.unsubscribe();
    entry.unsubscribe = null;
  }
  if (entry.unsubscribeLifecycle) {
    entry.unsubscribeLifecycle();
    entry.unsubscribeLifecycle = null;
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
    unsubscribeLifecycle: null as (() => void) | null,
  };
  activePtySessions.set(session, entry as any);
  let spawning = false;
  let latestRequestedSize: { cols: number; rows: number } | null = null;
  const VALID_PREFILL_MODES = ["full", "viewport", "none"] as const;
  type PrefillMode = typeof VALID_PREFILL_MODES[number];
  let pendingPrefillMode: PrefillMode = "full";

  // Streaming attach path: snapshot prefill + subscribe to broker output stream.
  const streamingBackend: (SessionBackend & PtyBackendMethods) | null =
    getRouter().getStreamingBackendForSession(session);

  if (!streamingBackend) {
    log.warn("ws attach: streaming backend unavailable", { session });
    try { ws.close(CLOSE_CODE_SESSION_UNAVAILABLE, WS_CLOSE_REASONS.SESSION_UNAVAILABLE); } catch (e: unknown) {
      log.debug("streaming backend missing close failed", { session, error: errMsg(e) });
    }
    activePtySessions.delete(session);
    return;
  }

  // ── Snapshot + subscribe attach path (PTY backend in-process, broker over RPC) ──
  async function attachStreamingBackend(
    backend: SessionBackend & PtyBackendMethods,
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
      if (!backend.isSessionAlive(session)) {
        entry.alive = false;
        activePtySessions.delete(session);
        if (entry.viewer) {
          try { entry.viewer.close(CLOSE_CODE_SESSION_UNAVAILABLE, WS_CLOSE_REASONS.SESSION_UNAVAILABLE); } catch (e: unknown) { log.debug(`session unavailable: viewer close failed`, { session, error: errMsg(e) }); }
          entry.viewer = null;
        }
        return;
      }

      if (!entry.alive || activePtySessions.get(session) !== entry || entry.viewer !== ws) return;

      // Skip settle wait when there's no snapshot to take — the only purpose
      // of waiting is to capture the SIGWINCH redraw in the snapshot, but
      // prefillMode:"none" means we don't snapshot.
      const skipSettle = prefillMode === "none";

      // Wait for client's resize messages to settle before applying any
      // resize to the backend, so the SHELL only sees ONE SIGWINCH at the
      // final settled dims.
      //
      // The common case: clicking a session triggers CSS layout transitions
      // (sidebar margin-left 200ms + view transform 280ms) and the terminal
      // container width shifts over ~200ms. The client sends a resize per
      // animation frame during that window (typically 3-4 resizes).
      //
      // Naive approach (one backend.resize per client resize) creates two
      // problems:
      //   1. Each backend.resize forwards SIGWINCH to the PTY child. TUI
      //      apps like claude redraw their full screen on every SIGWINCH —
      //      so 4 resizes → 4 full redraws sent to the broker output stream.
      //   2. Once we subscribe with sinceSeq, broker replays those redraws
      //      to the client, who paints them sequentially → visible streaming.
      //
      // Better: don't apply ANY resize until dims settle. Then apply once
      // at final dims. SIGWINCH fires once → one redraw → one snapshot capture.
      //
      // Loop until either:
      //   (a) we've seen at least one resize AND PRE_SNAPSHOT_RESIZE_SETTLE_MS
      //       has passed since the most recent one — dims have settled.
      //   (b) we've seen NO resize but waited PRE_SNAPSHOT_RESIZE_INITIAL_WAIT_MS
      //       — client probably has no resize coming.
      //   (c) PRE_SNAPSHOT_RESIZE_TIMEOUT_MS hard cap.
      let pendingSize = { cols, rows };
      if (!skipSettle) {
        const settleStart = Date.now();
        let lastChangeAt = -1;
        while (true) {
          if (!entry.alive || activePtySessions.get(session) !== entry || entry.viewer !== ws) return;
          const elapsedTotal = Date.now() - settleStart;
          if (elapsedTotal >= PRE_SNAPSHOT_RESIZE_TIMEOUT_MS) break;
          if (lastChangeAt < 0) {
            if (elapsedTotal >= PRE_SNAPSHOT_RESIZE_INITIAL_WAIT_MS) break;
          } else {
            const elapsedSinceChange = Date.now() - lastChangeAt;
            if (elapsedSinceChange >= PRE_SNAPSHOT_RESIZE_SETTLE_MS) break;
          }
          await new Promise(resolve => setTimeout(resolve, 16));
          if (
            latestRequestedSize &&
            (latestRequestedSize.cols !== pendingSize.cols || latestRequestedSize.rows !== pendingSize.rows)
          ) {
            pendingSize = latestRequestedSize;
            lastChangeAt = Date.now();
          }
        }
      }

      if (!entry.alive || activePtySessions.get(session) !== entry || entry.viewer !== ws) return;

      // Apply settled dims and wait for the SIGWINCH-triggered redraw to
      // fully land in the broker output stream BEFORE snapshotting.
      //
      // CRITICAL: this loop also handles dim changes that arrive AFTER our
      // initial resize. The client commonly sends a forced refit on
      // attach_ack (one rAF after we ack the attach) — if that arrives
      // after we resize but before we snapshot, the snapshot captures dims
      // and partial redraw; then the post-snapshot reconciliation resize
      // would trigger ANOTHER full SIGWINCH redraw which streams as 1MB+
      // of mid-redraw replay (the visible scrolldown).
      //
      // Strategy: every time `latestRequestedSize` differs from what we
      // last applied, resize and reset the quiescence clock. Only exit
      // when dims are stable AND broker has been quiet for one window.
      // The temporary observer subscription does NOT forward bytes to the
      // client — those bytes are captured by the snapshot.
      //
      // Skip when not snapshotting (prefillMode="none"): no snapshot, no
      // replay window, no scrolldown surface.
      let appliedSize = pendingSize;
      if (!skipSettle) {
        const samples: Array<{ t: number; bytes: number }> = [];
        const observe = backend.onSessionData(session, (data: Uint8Array) => {
          samples.push({ t: Date.now(), bytes: data.length });
        });
        try {
          await backend.resize(session, appliedSize.cols, appliedSize.rows);
          let lastResizeAt = Date.now();
          const settleStart = lastResizeAt;
          while (true) {
            if (!entry.alive || activePtySessions.get(session) !== entry || entry.viewer !== ws) break;
            // Dim changed since we last applied? Re-resize and restart the
            // quiescence clock so we capture this redraw too.
            if (
              latestRequestedSize &&
              (latestRequestedSize.cols !== appliedSize.cols || latestRequestedSize.rows !== appliedSize.rows)
            ) {
              appliedSize = latestRequestedSize;
              await backend.resize(session, appliedSize.cols, appliedSize.rows);
              lastResizeAt = Date.now();
            }
            const elapsedTotal = Date.now() - settleStart;
            if (elapsedTotal >= QUIESCE_TIMEOUT_MS) break;
            const elapsedSinceResize = Date.now() - lastResizeAt;
            if (elapsedSinceResize >= QUIESCE_MIN_WAIT_MS) {
              const cutoff = Date.now() - QUIESCE_WINDOW_MS;
              while (samples.length > 0 && samples[0].t < cutoff) samples.shift();
              const recentBytes = samples.reduce((s, x) => s + x.bytes, 0);
              if (recentBytes < QUIESCE_BYTE_THRESHOLD) break;
            }
            await new Promise(resolve => setTimeout(resolve, 16));
          }
        } finally {
          if (observe) observe();
        }
      } else {
        await backend.resize(session, appliedSize.cols, appliedSize.rows);
      }

      // Snapshot AFTER resize so scrollback is reflowed to client cols.
      let prefillSeq: bigint | undefined;
      if (prefillMode !== "none") {
        const prefill = await backend.getSessionPrefill(session, appliedSize.cols);
        prefillSeq = prefill.seq;
        if (prefill.data.length > 0 && entry.viewer && entry.viewer.readyState === 1) {
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

      if (!entry.alive || activePtySessions.get(session) !== entry || entry.viewer !== ws) return;

      // Final reconciliation catches resize frames that arrived while the
      // snapshot bytes were being fetched/sent. The resulting SIGWINCH
      // redraw lands in the live stream with seq > prefillSeq; the coalesce
      // logic below holds it through ghostty's render cycle so it never
      // paints as mid-redraw fragments.
      if (
        latestRequestedSize &&
        (latestRequestedSize.cols !== appliedSize.cols || latestRequestedSize.rows !== appliedSize.rows)
      ) {
        appliedSize = latestRequestedSize;
        await backend.resize(session, appliedSize.cols, appliedSize.rows);
        if (!entry.alive || activePtySessions.get(session) !== entry || entry.viewer !== ws) return;
      }

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
      let _coalesceTimer: NodeJS.Timeout | null = null;
      let _coalesceFirstPushAt = 0;
      const flushCoalesce = () => {
        if (_coalesceTimer) { clearTimeout(_coalesceTimer); _coalesceTimer = null; }
        if (!_coalesceBuf.length) return;
        const merged = _coalesceBuf.length === 1 ? _coalesceBuf[0] : Buffer.concat(_coalesceBuf);
        _coalesceBuf = [];
        _coalesceFirstPushAt = 0;
        if (entry.viewer && entry.viewer.readyState === 1) {
          try { entry.viewer.send(merged); } catch (e: unknown) { log.debug(`PTY data send failed`, { session, error: errMsg(e) }); }
        }
      };
      const unsub = backend.onSessionData(session, (data: Uint8Array) => {
        if (!entry.alive) return;
        if (!entry.viewer || entry.viewer.readyState !== 1) return;
        const now = Date.now();
        if (_coalesceBuf.length === 0) _coalesceFirstPushAt = now;
        _coalesceBuf.push(Buffer.from(data));
        const heldFor = now - _coalesceFirstPushAt;
        if (heldFor >= COALESCE_HARD_MS) {
          flushCoalesce();
          return;
        }
        if (_coalesceTimer) clearTimeout(_coalesceTimer);
        _coalesceTimer = setTimeout(flushCoalesce, COALESCE_FLUSH_MS);
      }, {
        sinceSeq: prefillSeq,
        // HIGH finding from .context/reports/issues.md: when the broker
        // `subscribe` RPC fails after onSessionData returns, the backend
        // unwinds locally but the WS would otherwise stay open with no
        // data stream. Tear down so the client gets a 1011 close and can
        // surface an error / retry, instead of staring at a dead viewer.
        onSubscribeError: (err: unknown) => {
          log.warn("subscribe rpc failed — tearing down viewer", { session, error: errMsg(err) });
          if (!entry.alive) return;
          if (entry.viewer && entry.viewer.readyState === 1) {
            try { entry.viewer.close(CLOSE_CODE_SERVER_ERROR, WS_CLOSE_REASONS.SUBSCRIBE_FAILED); } catch (e: unknown) {
              log.debug("subscribe-error: viewer close failed", { session, error: errMsg(e) });
            }
          }
          teardownPty(session);
        },
      });
      if (!unsub) {
        log.warn("onSessionData returned null — session vanished", { session });
        entry.alive = false;
        activePtySessions.delete(session);
        if (entry.viewer) {
          try { entry.viewer.close(CLOSE_CODE_SESSION_UNAVAILABLE, WS_CLOSE_REASONS.SESSION_UNAVAILABLE); } catch (e: unknown) { log.debug(`onSessionData null: viewer close failed`, { session, error: errMsg(e) }); }
          entry.viewer = null;
        }
        return;
      }
      // Wrap unsub so the coalesce timer + buffer don't leak past detach.
      // Drop the buffer rather than flushing: viewer is gone, no point.
      entry.unsubscribe = () => {
        if (_coalesceTimer) { clearTimeout(_coalesceTimer); _coalesceTimer = null; }
        _coalesceBuf = [];
        unsub();
      };

      // Lifecycle: broker fires `session_exited` when the child reaps.
      // Close the viewer with 4001 so the client distinguishes a remote-side
      // session death from a normal disconnect. PtyBackend's stub no-ops.
      const lifecycleUnsub = backend.onSessionLifecycle(session, (event) => {
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
          try { entry.viewer.close(CLOSE_CODE_SESSION_UNAVAILABLE, WS_CLOSE_REASONS.SESSION_UNAVAILABLE); } catch (e: unknown) { log.debug(`lifecycle exit: viewer close failed`, { session, error: errMsg(e) }); }
          entry.viewer = null;
        }
        if (entry.pendingViewer) {
          try { entry.pendingViewer.close(CLOSE_CODE_SESSION_UNAVAILABLE, WS_CLOSE_REASONS.SESSION_UNAVAILABLE); } catch (e: unknown) { log.debug(`lifecycle exit: pendingViewer close failed`, { session, error: errMsg(e) }); }
          entry.pendingViewer = null;
        }
      });
      if (lifecycleUnsub) entry.unsubscribeLifecycle = lifecycleUnsub;

      sendPtyReady(entry);
    } finally {
      spawning = false;
    }
  }


  // Backend-uniform spawn — both PTY and broker use attachStreamingBackend.
  const spawnPty = (cols: number, rows: number, options?: { prefillMode?: PrefillMode; skipPrefill?: boolean }) => {
    let prefillMode: PrefillMode | undefined = options?.prefillMode;
    if (!prefillMode && options?.skipPrefill === true) prefillMode = "none";
    return attachStreamingBackend(streamingBackend, cols, rows, prefillMode ? { prefillMode } : undefined);
  };

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
          const isAttached = !!entry.unsubscribe;
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
          const isAttached = !!entry.unsubscribe;
          if (!isAttached) {
            spawnPty(cols, rows);
          } else {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              resizeTimer = null;
              if (!entry.alive) return;
              streamingBackend.resize(session, cols, rows).catch((e: unknown) => {
                log.debug(`streaming backend resize failed`, { session, error: errMsg(e) });
              });
            }, RESIZE_DEBOUNCE_MS);
          }
        }
      } else {
        // Binary data — write to terminal via the streaming backend.
        if (Buffer.isBuffer(raw) && raw.length > MAX_PTY_BINARY_BYTES) return;
        streamingBackend.writeToTerminal(session, raw as Buffer);
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
