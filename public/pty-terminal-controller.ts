import { captureLastCrash, __wfTraceEvent, __wfTraceGet, wfTraceEnabled, type TraceState } from "./app-debug";
import { createInitialHydrationController, type InitialHydrationController } from "./terminal-hydration";
import { resolveHydrationDebugTiming } from "../src/terminal-hydration-debug";
import { commitTerminalResizePreservingScroll, fitTerminalPreservingScroll, forceTerminalRepaint, syncTerminalLayout } from "./terminal-layout";
import { createTerminalResizeLifecycle } from "./terminal-resize-lifecycle";
import { type OrderedResizeSettlement } from "./ordered-resize";
import {
  createPtySocketClient,
  type PtySocketClient,
  type PtySocketClientDependencies,
  type PtySocketSendData,
} from "./pty-socket-client";
import { TERMINAL_PREFILL_MODE } from "../src/terminal-prefill";
import { resizeRehydrateScrollTarget } from "../src/terminal-buffer";
import {
  shouldReleaseScrollLockOnKeydown,
  terminalDataFromBeforeInput,
  terminalDataFromKeydownForBeforeInputDedupe,
} from "../src/terminal-input";
import {
  createTerminalConnectionLifecycle,
  TERMINAL_REHYDRATION_ACTION,
} from "../src/terminal-connection-lifecycle";
import { type LayoutStablePrefillMode } from "../src/terminal-layout-stable-debug";

export const INITIAL_HYDRATION_SETTLE_MS = 16;
export const INITIAL_HYDRATION_SILENCE_MS = 32;

export interface TerminalInstanceOptions {
  readonly fontSize?: number;
  readonly scrollback: number;
  readonly cursorBlink?: boolean;
  readonly disableStdin?: boolean;
  readonly sendInput: (data: Uint8Array) => void;
  readonly sendMessage: (message: string) => void;
  readonly canAcceptInput: () => boolean;
  readonly canSendResize?: () => boolean;
  readonly forwardResizeEvents?: boolean;
  readonly alwaysForwardWheel?: boolean;
  readonly trace?: TraceState | null;
  readonly onWheelScroll?: ((event: WheelEvent) => void) | null;
}

export interface TerminalInstance {
  readonly term: GhosttyTerminal;
  readonly fitAddon: GhosttyFitAddon;
}

export interface PtyTerminalControllerDependencies {
  readonly createTerminalInstance: (options: TerminalInstanceOptions) => Promise<TerminalInstance>;
  readonly shouldSuppressContainerResize: () => boolean;
  readonly getDebugStorage: () => Pick<Storage, "getItem"> | null;
  readonly socket: PtySocketClientDependencies;
}

const TERMINAL_BEFOREINPUT_DEDUPE_MS = 100;

function installTerminalTextareaInputBridge(
  term: GhosttyTerminal,
  sendInput: (data: Uint8Array) => void,
  canAcceptInput: () => boolean,
  trace: TraceState | null,
): void {
  const input = term.textarea;
  if (!input) return;

  let lastKeydownData: string | null = null;
  let lastKeydownAt = 0;
  let lastCompositionData: string | null = null;
  let lastCompositionAt = 0;
  const encoder = new TextEncoder();

  function now(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
  }

  function recentDuplicate(data: string, previousData: string | null, previousAt: number): boolean {
    return previousData === data && now() - previousAt < TERMINAL_BEFOREINPUT_DEDUPE_MS;
  }

  input.addEventListener("keydown", (event) => {
    const data = terminalDataFromKeydownForBeforeInputDedupe(event);
    if (!data) return;
    lastKeydownData = data;
    lastKeydownAt = now();
  });

  input.addEventListener("compositionend", (event) => {
    if (!event.data) return;
    lastCompositionData = event.data;
    lastCompositionAt = now();
  });

  input.addEventListener("beforeinput", (event) => {
    if (event.defaultPrevented || term.options.disableStdin || !canAcceptInput()) return;
    const data = terminalDataFromBeforeInput(event);
    if (!data) return;
    event.preventDefault();
    event.stopPropagation();
    if (recentDuplicate(data, lastKeydownData, lastKeydownAt)) {
      lastKeydownData = null;
      return;
    }
    if (event.data && recentDuplicate(event.data, lastCompositionData, lastCompositionAt)) {
      lastCompositionData = null;
      return;
    }
    __wfTraceEvent(trace, "terminal.textarea.beforeinput", { inputType: event.inputType });
    sendInput(encoder.encode(data));
  });
}

/**
 * createPtyTerminalController — composes terminal, hydration, and WebSocket
 * helpers into a single PTY terminal lifecycle controller.
 *
 * @param {object} opts
 * @param {string} opts.session - broker session name
 * @param {string} [opts.machine=""] - remote machine URL ("" for local)
 * @param {number} [opts.fontSize] - override font size
 * @param {number} opts.scrollback - terminal scrollback lines
 * @param {boolean} [opts.cursorBlink=true]
 * @param {boolean} [opts.disableStdin=false]
 * @param {() => boolean} [opts.shouldFocus] - hydration focus decision
 * @param {number} [opts.hydrationTimeoutMs] - hydration reveal timeout
 * @param {() => HTMLElement|null} [opts.getHydrationElement] - element to show/hide for hydration (defaults to mount container)
 * @param {boolean} [opts.resetPty] - append &reset=1 on first connect
 * @param {string} [opts.prefillMode] - "full" (default), "viewport", or "none"
 * @param {() => boolean} [opts.shouldReconnect] - guard for reconnect attempts
 * @param {() => boolean} [opts.canAcceptInput] - override stdin guard (default: ptyClient.isOpen)
 * @param {() => boolean} [opts.canSendResize] - override resize guard (default: canAcceptInput)
 * @param {(Uint8Array) => void} [opts.onOutput] - called after data written to term
 */

export interface PtyTerminalControllerOpts {
  readonly session: string;
  readonly machine?: string;
  readonly fontSize?: number;
  readonly scrollback: number;
  readonly cursorBlink?: boolean;
  readonly disableStdin?: boolean;
  readonly resetPty?: boolean;
  readonly prefillMode?: LayoutStablePrefillMode;
  readonly hydrationTimeoutMs?: number;
  readonly hydrationMinPendingMs?: number;
  readonly hydrationSettleMs?: number;
  readonly hydrationSilenceMs?: number;
  readonly shouldFocus?: () => boolean;
  readonly shouldReconnect?: () => boolean;
  readonly canAcceptInput?: () => boolean;
  readonly canSendResize?: () => boolean;
  readonly getHydrationElement?: () => HTMLElement | null;
  readonly onOpen?: (wasReconnect: boolean) => void;
  readonly onPtyReady?: () => void;
  readonly onOutput?: (data: Uint8Array<ArrayBuffer>) => void;
  readonly onViewerConflict?: () => void;
  readonly onControlGranted?: () => void;
  readonly onSubSessionOpened?: (parentSession: string, session: string) => void;
  readonly onDisconnected?: (code: number, reason: string) => void;
  readonly onReconnecting?: () => void;
  readonly onReconnectExhausted?: () => void;
  readonly onRouteUnavailable?: () => void;
  readonly onHydrationStart?: () => void;
  readonly onHydrated?: () => void;
}
export interface PtyTerminalController {
  mount(container: HTMLElement, mountOpts?: { readonly cached?: string | null }): Promise<void>;
  connect(connectOpts?: { readonly takeControl?: boolean }): void;
  focus(): void;
  scrollToBottom(): void;
  resize(): void | Promise<OrderedResizeSettlement>;
  readonly supportsOrderedResize: boolean;
  dispose(): void;
  scheduleReconnect(): void;
  sendTakeControl(): void;
  sendFitResize(options?: { readonly force?: boolean; readonly fit?: boolean }): Promise<OrderedResizeSettlement>;
  forceRepaint(): void;
  syncLayout(options?: { readonly forceSend?: boolean; readonly repaint?: boolean; readonly reason?: string }): Promise<void>;
  send(data: PtySocketSendData): boolean;
  resetRetry(): void;
  reconnect(reconnectOpts?: { readonly takeControl?: boolean }): void;
  readonly term: GhosttyTerminal | null;
  readonly fitAddon: GhosttyFitAddon | null;
  readonly ptyClient: PtySocketClient | null;
  readonly hydration: InitialHydrationController | null;
  readonly isConnected: boolean;
  readonly retryBlocked: boolean;
}

export function createPtyTerminalController(
  opts: PtyTerminalControllerOpts,
  dependencies: PtyTerminalControllerDependencies,
): PtyTerminalController {
  let _container: HTMLElement | null = null;
  let _term: GhosttyTerminal | null = null;
  let _fitAddon: GhosttyFitAddon | null = null;
  let _hydration: InitialHydrationController | null = null;
  let _ptyClient: PtySocketClient | null = null;
  let _hydrationStarted = false;
  const connectionLifecycle = createTerminalConnectionLifecycle();
  let _initialPrefillComplete = opts.prefillMode === TERMINAL_PREFILL_MODE.NONE;
  let _mounting = false;
  let _userScrolledUp = false;
  let _userRequestedScrollback = false;
  // Scrollback length snapshot captured when user enters scroll-lock. Used by
  // the patched scrollToBottom to compute per-write scrollback growth and bump
  // viewportY accordingly, so the visible window stays anchored to the same
  // absolute rows as new output streams in. -1 = no baseline (not scroll-locked).
  let _lastScrollbackLength = -1;
  let _scrollLockKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
  let _browserShortcutKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
  let _firstFitSeen = false;
  let _firstInputAccepted = false;

  const _canAcceptInput = opts.canAcceptInput || (() => !!(_ptyClient && _ptyClient.isOpen));
  const _canSendResize = opts.canSendResize || _canAcceptInput;
  const _getHydrationElement = opts.getHydrationElement || (() => _container);

  function _writeTermData(data: Uint8Array<ArrayBuffer>) {
    if (!_term) return;
    // Diag: capture wasm OOB on first crash so we can inspect bytes/dims
    // post-mortem via window.__wf_lastCrash. No behavioral change.
    const _diagTrace = __wfTraceGet(opts.session, opts.machine || "");
    const _diagPending = !!(_hydration && _hydration.pending);
    __wfTraceEvent(_diagTrace, "_writeTermData", { size: data.length, hydrating: _diagPending });
    // Notify hydration controller so the silenceMs gate sees this write
    // even when we're not in the hydrating-with-callback branch.
    if (_hydration) _hydration.notifyData();
    try {
      if (_hydration && _hydration.pending) {
        const writeEpoch = connectionLifecycle.beginHydrationWrite();
        _term.write(data, () => {
          // Ignore stale callbacks from a prior connect/dispose epoch.
          if (!connectionLifecycle.finishHydrationWrite(writeEpoch)) return;
          __wfTraceEvent(_diagTrace, "term.writeDone", { size: data.length, inFlight: connectionLifecycle.pendingHydrationWrites });
          if (_hydration) _hydration.scheduleFinish();
          if (opts.onOutput) opts.onOutput(data);
        });
      } else {
        _term.write(data);
        if (opts.onOutput) opts.onOutput(data);
      }
    } catch (err) {
      captureLastCrash({
        session: opts.session,
        cols: _term ? _term.cols : null,
        rows: _term ? _term.rows : null,
        data,
        err,
      });
      throw err;
    }
  }

  function recordFirstFit(dimensions: { cols: number; rows: number }) {
    if (_firstFitSeen) return;
    _firstFitSeen = true;
    __wfTraceEvent(__wfTraceGet(opts.session, opts.machine || ""), "first.fit", dimensions);
  }

  function fitTerminalPreserveScroll() {
    fitTerminalPreservingScroll({
      term: _term,
      fitAddon: _fitAddon,
      onFit: recordFirstFit,
    });
  }

  function forceRepaint() {
    forceTerminalRepaint(_term);
  }

  function syncLayout(options?: { forceSend?: boolean; repaint?: boolean; reason?: string }): Promise<void> {
    if (!_container) return Promise.resolve();
    const ptyClient = _ptyClient;
    return syncTerminalLayout({
      term: _term,
      fitAddon: _fitAddon,
      ptyClient: ptyClient ? {
        supportsOrderedResize: ptyClient.supportsOrderedResize,
        sendResize: async (cols, rows) => { await ptyClient.sendResize(cols, rows); },
      } : null,
      forceSend: !!options?.forceSend,
      repaint: options?.repaint !== false,
      onFit: recordFirstFit,
      onDimensionsChanged: () => resizeLifecycle.scheduleResizeRehydrate(),
    });
  }

  const resizeLifecycle = createTerminalResizeLifecycle({
    prefillMode: opts.prefillMode ?? TERMINAL_PREFILL_MODE.FULL,
    getContainer: () => _container,
    getTerm: () => _term,
    getPtyClient: () => _ptyClient,
    shouldSuppressContainerResize: dependencies.shouldSuppressContainerResize,
    userRequestedScrollback: () => _userRequestedScrollback,
    syncLayout,
    scheduler: {
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (id) => cancelAnimationFrame(id),
      setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimeout: (id) => window.clearTimeout(id),
    },
    createResizeObserver: typeof ResizeObserver === "undefined" ? () => null : (callback) =>
      new ResizeObserver((entries) => callback(entries)),
  });

  /**
   * After a column-count change, the scrollback the client has on screen was
   * painted from a prefill rendered at the OLD width — line wraps fall at
   * the wrong columns. The broker reflows scrollback as part of its `resize`
   * RPC + `snapshot` (with `target_cols`) path, but xterm.js exposes no
   * "replace scrollback only" API; the only way to apply a re-flowed
   * scrollback is a full reconnect that re-fetches the snapshot.
   *
   * Cost: ~ one snapshot RPC + prefill stream per actual resize event
   * (350ms debounce collapses bursty resize-during-drag into one). Resizes
   * are infrequent (sidebar pin/unpin, window drag, mobile rotate) so this
   * is an acceptable price for correct scrollback wrap geometry.
   *
   * Gated on `prefillMode: "full"` because viewport-only attaches don't
   * paint scrollback at all — there's nothing to re-flow.
   *
   * Suppressed while the sidebar is in a hover-driven transient state
   * (`shouldSuppressContainerResize`) so a mouseover+mouseout doesn't
   * trigger a reconnect for a layout that's about to revert.
   */

  function startHydration() {
    if (!_hydration) return;
    _hydration.start();
    if (opts.onHydrationStart) opts.onHydrationStart();
  }

  /** Begin replacement prefill while retaining the old canvas until its first
   * authoritative byte. The first byte promotes this to CSS-hidden hydration,
   * preventing later snapshot chunks from painting progressively. */
  function beginReplacementHydration(hideImmediately = false) {
    if (!_hydration || !_term) return;
    if (connectionLifecycle.beginReplacementPrefill(hideImmediately).activateHydration) activateReplacementHydration();
  }

  function activateReplacementHydration() {
    startHydration();
    const el = _getHydrationElement();
    if (el) { el.classList.remove("hydrated"); el.classList.add("hydrating"); }
  }

  /**
   * mount(container, { cached }?) — create terminal, open in container, load
   * CanvasAddon, fit, create hydration controller (not yet started).
   * Cached plaintext is not written here; restored history must come from
   * broker prefill or an explicit/gated fast-mode replay path.
   */
  async function mount(container: HTMLElement, mountOpts?: { readonly cached?: string | null }) {
    if (_term || _mounting) return; // already mounted or in progress
    const trace = __wfTraceGet(opts.session, opts.machine || "");
    _mounting = true;
    try { await window.ghosttyReady; } catch (err) {
      console.error("[ghostty-web] WASM init failed:", err);
      _mounting = false;
      return;
    }
    __wfTraceEvent(trace, "ghostty.ready");
    if (_term || !_mounting) { _mounting = false; return; } // double-mount or disposed during async gap
    _container = container;

    const result = await dependencies.createTerminalInstance({
      fontSize: opts.fontSize,
      scrollback: opts.scrollback,
      cursorBlink: opts.cursorBlink,
      disableStdin: opts.disableStdin,
      sendInput: (data) => _ptyClient && _ptyClient.send(data),
      sendMessage: (msg) => _ptyClient && _ptyClient.send(msg),
      canAcceptInput: _canAcceptInput,
      canSendResize: _canSendResize,
      forwardResizeEvents: false,
      alwaysForwardWheel: false,
      trace,
      onWheelScroll: (ev) => {
        if (!_term) return;
        try {
          const hasMouse = _term.getMode(1000) || _term.getMode(1002) || _term.getMode(1003);
          if (hasMouse) return;
        } catch { /* getMode may not exist on older builds */ }
        // This callback fires BEFORE ghostty-web updates the viewport, so
        // viewportY is stale. For scroll-up we trust deltaY direction (user
        // wants to read scrollback). For scroll-down we defer the viewportY
        // check to next frame when ghostty has finished processing.
        if (ev.deltaY < 0) {
          // Snapshot scrollback length at the moment we enter scroll-lock so
          // the patched scrollToBottom can compute the per-write delta and
          // bump viewportY to keep the visible window anchored.
          if (!_userScrolledUp) {
            _lastScrollbackLength = _term.getScrollbackLength?.() ?? -1;
          }
          _userScrolledUp = true;
          _userRequestedScrollback = true;
        } else if (ev.deltaY > 0) {
          requestAnimationFrame(() => {
            if (_term && _term.viewportY === 0) {
              _userScrolledUp = false;
              _userRequestedScrollback = false;
              _lastScrollbackLength = -1;
            }
          });
        }
      },
    });
    // Guard: dispose() may have run during the createTerminalInstance() await
    // (isolated WASM load is async). If so, drop the freshly-created terminal.
    if (!_mounting || _term) {
      try { result.term && result.term.dispose && result.term.dispose(); } catch {}
      _mounting = false;
      return;
    }
    _term = result.term;
    _fitAddon = result.fitAddon;

    // Mark hydrating before terminal mounts to avoid first-frame flicker.
    const hydrationEl = _getHydrationElement();
    if (hydrationEl) { hydrationEl.classList.add("hydrating"); hydrationEl.classList.remove("hydrated"); }
    if (opts.onHydrationStart) opts.onHydrationStart();

    _term.open(container);
    __wfTraceEvent(trace, "dom.terminal.opened");
    installTerminalTextareaInputBridge(_term, (data) => _ptyClient && _ptyClient.send(data), _canAcceptInput, trace);
    resizeLifecycle.observe(container);

    // WORKAROUND: ghostty-web v0.4.0 WASM state retention
    // The WASM allocator reuses freed page memory without zeroing, so new
    // Terminal instances inherit stale screen content from previous ones.
    // reset() frees+recreates the WASM handle but renderer.clear() doesn't
    // repaint the Canvas 2D framebuffer. Direct fillRect is the only fix.
    // Upstream: github.com/coder/ghostty-web/issues/138, /141, /142
    const _openCanvas = container.querySelector('canvas');
    if (_openCanvas) {
      const ctx = _openCanvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#0a0a0a'; // match terminal background
        ctx.fillRect(0, 0, _openCanvas.width, _openCanvas.height);
      }
    }

    // Monkey-patch scrollToBottom to prevent auto-scroll when user has scrolled up.
    // ghostty-web calls scrollToBottom() on EVERY write when viewportY !== 0,
    // which makes it impossible to read scrollback while the agent is producing output.
    // We suppress it when the user has intentionally scrolled up (via wheel/trackpad),
    // and re-enable when they scroll back to the bottom.
    {
      // Scroll-lock: scroll up → keep viewport anchored to the same absolute
      // scrollback rows even as new output pushes lines off the live screen.
      // Any key → snap back to bottom.
      //
      // ghostty-web's writeInternal() calls this.scrollToBottom() on every
      // write when viewportY !== 0. A single write can push N rows from the
      // live screen into scrollback (scrollbackLength grows by N). If we
      // simply swallow scrollToBottom, viewportY stays the same numeric
      // value but now points to a DIFFERENT absolute scrollback row — the
      // user's visible window drifts by N rows per write. Visually that
      // presents as "the first line in the window keeps changing" while
      // the user is trying to read scrollback.
      //
      // Fix: track scrollbackLength delta between successive scrollToBottom
      // calls and bump viewportY by that delta. Net effect: the same
      // absolute scrollback rows stay at the same visual viewport rows.
      //
      // Wheel events are intercepted via onWheelScroll callback passed to
      // createTerminalInstance (fires inside ghostty-web's capture-phase
      // custom wheel handler — the ONLY place we can see wheel events before
      // ghostty-web consumes them with {capture:true, passive:false}).
      const scrollTerm = _term;
      const origScrollToBottom = scrollTerm.scrollToBottom.bind(scrollTerm);
      scrollTerm.scrollToBottom = () => {
        if (!_userScrolledUp) {
          origScrollToBottom();
          return;
        }
        const sb = scrollTerm.getScrollbackLength?.() ?? 0;
        if (_lastScrollbackLength >= 0) {
          const delta = sb - _lastScrollbackLength;
          if (delta > 0) {
            // scrollToLine clamps and fires scrollEmitter so the renderer
            // does a full repaint at the new viewportY. Direct mutation
            // would leave dirty-row tracking stale.
            scrollTerm.scrollToLine((scrollTerm.viewportY ?? 0) + delta);
          }
        }
        _lastScrollbackLength = sb;
      };
      // Intercept scrollLines (used by mobile touch scroll + momentum).
      // When viewport moves away from bottom, set _userScrolledUp + snapshot
      // baseline. When it reaches bottom, clear both.
      const origScrollLines = scrollTerm.scrollLines.bind(scrollTerm);
      scrollTerm.scrollLines = (n) => {
        const wasScrolledUp = _userScrolledUp;
        origScrollLines(n);
        if ((scrollTerm.viewportY ?? 0) > 0) {
          if (!wasScrolledUp) {
            _lastScrollbackLength = scrollTerm.getScrollbackLength?.() ?? -1;
          }
          _userScrolledUp = true;
          _userRequestedScrollback = true;
        } else {
          _userScrolledUp = false;
          _userRequestedScrollback = false;
          _lastScrollbackLength = -1;
        }
      };
      _scrollLockKeydownHandler = (event: KeyboardEvent) => {
        if (!shouldReleaseScrollLockOnKeydown(event)) return;
        if (_userScrolledUp) {
          _userScrolledUp = false;
          _userRequestedScrollback = false;
          _lastScrollbackLength = -1;
          origScrollToBottom();
        }
      };
      container.addEventListener("keydown", _scrollLockKeydownHandler, true);
    }

    // Let browser shortcuts through — ghostty-web's keydown handler
    // calls preventDefault() on everything, swallowing Cmd+R etc.
    _browserShortcutKeydownHandler = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if ("rwtlnq".includes(k) || (e.shiftKey && k === "r")) {
          e.stopImmediatePropagation();
        }
      }
    };
    container.addEventListener("keydown", _browserShortcutKeydownHandler, true);

    // Create hydration controller (started in connect())
    //
    // ─── WHY minPendingMs=200 ────────────────────────────────────────────────
    // Background: when opening a session, the user could briefly see
    // scrollback streaming upward through the viewport before the cursor
    // settled. The flash was from the post-attach resize-redraw burst:
    //
    //   - WS opens → attach handshake at initial dims
    //   - server snapshotted broker state immediately at those dims
    //   - attach_ack → client schedules force-resize next rAF
    //   - by then CSS layout had settled to different dims (sidebar
    //     transition 200ms, view transform 280ms)
    //   - broker reflowed scrollback at new dims → emitted streaming
    //     redraw burst (1000+ chunks over ~150ms)
    //   - each chunk = separate WS macrotask → ghostty rAF rendered
    //     intermediate states between them = visible flash
    //
    // PROPER FIX (now in place): src/server/websocket.ts holds the snapshot
    // until client resizes settle (PRE_SNAPSHOT_RESIZE_SETTLE_MS=100ms quiet
    // window, 400ms hard cap). Snapshot now happens at the FINAL dims so the
    // post-attach refit becomes a no-op and the redraw burst doesn't fire.
    //
    // Why minPendingMs is still non-zero: server settle isn't perfect.
    // Scenarios that can still produce a small post-prefill burst:
    //   - mobile keyboard slide-in causes a late layout shift > settle window
    //   - subscription replay (sinceSeq) catches output that arrived during
    //     the settle wait — typically tiny but can paint as a tail of writes
    //   - rAF jitter between writes
    // 200ms is a small cushion to absorb these without revealing mid-burst.
    // Total cost on desktop: ~200ms reveal time (down from 800ms).
    // ─────────────────────────────────────────────────────────────────────────
    const hydrationTiming = resolveHydrationDebugTiming({
      debugEnabled: wfTraceEnabled,
      storage: dependencies.getDebugStorage(),
      defaults: {
        minPendingMs: opts.hydrationMinPendingMs ?? 80,
        silenceMs: opts.hydrationSilenceMs ?? INITIAL_HYDRATION_SILENCE_MS,
      },
    });

    _hydration = createInitialHydrationController({
      getElement: _getHydrationElement,
      getTerm: () => _term,
      shouldFocus: opts.shouldFocus || (() => true),
      isInitialContentComplete: () => _initialPrefillComplete,
      canFinish: () => connectionLifecycle.pendingHydrationWrites === 0,
      onReveal: () => {
        const pendingResizeScrollRestore = resizeLifecycle.takePendingScrollRestore();
        if (pendingResizeScrollRestore && _term) {
          const target = resizeRehydrateScrollTarget({
            ...pendingResizeScrollRestore,
            newScrollbackLength: _term.getScrollbackLength?.() ?? 0,
          });
          if (target !== null) {
            try { _term.scrollToLine(target); } catch {}
            _userScrolledUp = target > 0;
            _userRequestedScrollback = target > 0;
            _lastScrollbackLength = _term.getScrollbackLength?.() ?? -1;
          }
        }
        forceRepaint();
        if (opts.onHydrated) opts.onHydrated();
      },
      timeoutMs: opts.hydrationTimeoutMs,
      settleMs: opts.hydrationSettleMs ?? INITIAL_HYDRATION_SETTLE_MS,
      minPendingMs: hydrationTiming.minPendingMs,
      // Stay hidden briefly after the last terminal write. This catches late
      // post-attach redraw chunks without paying the old fixed 50ms settle
      // after prefill_done when the stream is already quiet.
      silenceMs: hydrationTiming.silenceMs,
      // Diag-only: lets the controller emit milestones into the per-attach trace.
      onDiagnostic: (kind, fields) => {
        __wfTraceEvent(__wfTraceGet(opts.session, opts.machine || ""), kind, fields);
      },
    });

    syncLayout({ forceSend: false, repaint: true, reason: "mount" });
    _mounting = false;
  }

  /**
   * connect() — start hydration (first time only), create PTY WebSocket
   * client, and open the connection.
   */
  function connect(connectOpts?: { takeControl?: boolean }) {
    if (_ptyClient && _ptyClient.isOpen) return;
    if (_ptyClient) _ptyClient.close();
    connectionLifecycle.beginConnection();

    // Start hydration on first connect
    if (!_hydrationStarted && _hydration) {
      startHydration();
      _hydrationStarted = true;
    }

    // Capture reference to detect stale callbacks from replaced ptyClients
    let thisClient: PtySocketClient | null = null;
    const isCurrent = () => _ptyClient === thisClient;

    thisClient = _ptyClient = createPtySocketClient({
      takeControlOnAttach: !!(connectOpts && connectOpts.takeControl),
      session: opts.session,
      machine: opts.machine || "",
      resetPty: opts.resetPty,
      prefillMode: opts.prefillMode,
      getTermDimensions: () => _term ? { cols: _term.cols, rows: _term.rows } : null,
      getProposedDimensions: () => _fitAddon?.proposeDimensions?.() ?? (_term ? { cols: _term.cols, rows: _term.rows } : null),
      getLayoutMetrics: () => {
        if (!_container) return null;
        const rect = _container.getBoundingClientRect();
        return {
          containerWidth: rect.width,
          containerClientWidth: _container.clientWidth,
          viewportWidth: window.innerWidth,
        };
      },
      fitTerminal: fitTerminalPreserveScroll,
      shouldReconnect: opts.shouldReconnect,
      onAttach: () => {
        _initialPrefillComplete = opts.prefillMode === TERMINAL_PREFILL_MODE.NONE;
      },
      onOpen: (wasReconnect) => {
        console.log("[pty-ctrl]", opts.session, "onOpen, isCurrent=", isCurrent(), "wasReconnect=", wasReconnect);
        if (!isCurrent()) return;
        // The connection lifecycle decides whether this socket replaces
        // displayed content. The authoritative broker prefill clears terminal
        // state itself; never reset the Ghostty instance during hydration.
        const socketOpenAction = connectionLifecycle.onSocketOpen({
          wasReconnect,
          hydrationStarted: _hydrationStarted,
          hasAuthoritativePrefill: opts.prefillMode !== TERMINAL_PREFILL_MODE.NONE,
          hasPendingResizeScrollRestore: resizeLifecycle.hasPendingScrollRestore,
        });
        if (socketOpenAction.rehydrationAction !== TERMINAL_REHYDRATION_ACTION.NONE && _term) {
          if (socketOpenAction.rehydrationAction === TERMINAL_REHYDRATION_ACTION.REPLACEMENT) {
            // Retain the old frame until replacement bytes arrive, then hide
            // every subsequent prefill/replay write behind hydration.
            beginReplacementHydration();
          } else {
            startHydration();
            const el = _getHydrationElement();
            if (el) { el.classList.add("hydrating"); el.classList.remove("hydrated"); }
          }
        }
        if (socketOpenAction.resetScrollLock) {
          _userScrolledUp = false;
          _userRequestedScrollback = false;
        } // reset scroll-lock on ordinary reconnect
        if (opts.onOpen) opts.onOpen(wasReconnect);
      },
      onPtyReady: () => { if (isCurrent() && opts.onPtyReady) opts.onPtyReady(); },
      onResizeAck: (cols, rows) => {
        if (!isCurrent() || !_term) return;
        if (commitTerminalResizePreservingScroll(_term, { cols, rows })) {
          recordFirstFit({ cols, rows });
          forceRepaint();
          resizeLifecycle.scheduleResizeRehydrate();
        }
      },
      onPrefillDone: () => {
        if (!isCurrent()) return;
        const prefillAction = connectionLifecycle.onPrefillDone();
        if (prefillAction.activateHydration) activateReplacementHydration();
        _initialPrefillComplete = true;
        if (_hydration) _hydration.scheduleFinish();
      },
      onReplacePrefill: () => {
        // Phase 2 scrollback replaces phase 1 viewport. The full scrollback
        // is a superset that contains the viewport content, so we skip the
        // clear() entirely — just let the chunks write directly over the
        // existing buffer. This avoids any visible flash. The terminal ends
        // up with correct content; the viewport portion is overwritten in-place
        // and scrollback history appears above.
        if (!_term) return;
        connectionLifecycle.onReplacePrefill();
      },
      onBinaryData: (data) => {
        if (!_term) return;
        const binaryAction = connectionLifecycle.onBinaryData();
        if (binaryAction.activateHydration) activateReplacementHydration();
        _writeTermData(data);
      },
      onViewerConflict: () => { if (isCurrent() && opts.onViewerConflict) opts.onViewerConflict(); },
      onSubSessionOpened: (parentSession, session) => {
        if (isCurrent() && opts.onSubSessionOpened) opts.onSubSessionOpened(parentSession, session);
      },
      onControlGranted: () => {
        if (!isCurrent()) return;
        // control_granted triggers a fresh attach handshake over the existing
        // socket (sendAttachHandshake() in the ws-client control_granted
        // handler). That's another full prefill + post-attach resize-redraw
        // burst — same shape as initial connect. Without restarting hydration
        // here, the canvas is already `hydrated` from the original mount, so
        // those writes paint live and the user sees the scrollback flash.
        // Restart hydration so the minPendingMs floor hides the burst window.
        if (_hydration && _term) {
          if (connectionLifecycle.onControlGranted().activateHydration) activateReplacementHydration();
        }
        if (opts.onControlGranted) opts.onControlGranted();
      },
      onDisconnected: (code, reason) => { if (isCurrent() && opts.onDisconnected) opts.onDisconnected(code, reason); },
      onReconnecting: () => { if (isCurrent() && opts.onReconnecting) opts.onReconnecting(); },
      onReconnectExhausted: () => { if (isCurrent() && opts.onReconnectExhausted) opts.onReconnectExhausted(); },
      onRouteUnavailable: () => { if (isCurrent() && opts.onRouteUnavailable) opts.onRouteUnavailable(); },
    }, dependencies.socket);
    _ptyClient.connect();
  }

  function focus() {
    if (_term) _term.focus();
  }

  function scrollToBottom() {
    _userScrolledUp = false;
    _userRequestedScrollback = false;
    _lastScrollbackLength = -1;
    if (_term) _term.scrollToBottom();
  }

  function resize(): void | Promise<OrderedResizeSettlement> {
    if (!_ptyClient) {
      void syncLayout({ forceSend: true, repaint: true, reason: "resize" });
      return;
    }
    const supportsOrderedResize = _ptyClient.supportsOrderedResize;
    const settlement = _ptyClient.sendFitResize({ force: true, immediate: true });
    if (!supportsOrderedResize) {
      forceRepaint();
      return;
    }
    return settlement;
  }

  /**
   * dispose() — close socket, cancel hydration, dispose addons and terminal.
   * Removes keydown listeners from container before disposing terminal.
   */
  function dispose() {
    connectionLifecycle.beginConnection();
    if (_ptyClient) { _ptyClient.close(); _ptyClient = null; }
    if (_hydration) { _hydration.cancel(); _hydration = null; }
    _hydrationStarted = false;
    connectionLifecycle.reset();
    resizeLifecycle.dispose();
    _mounting = false;
    _userScrolledUp = false;
    _userRequestedScrollback = false;
    if (_container) {
      if (_scrollLockKeydownHandler) _container.removeEventListener("keydown", _scrollLockKeydownHandler, true);
      if (_browserShortcutKeydownHandler) _container.removeEventListener("keydown", _browserShortcutKeydownHandler, true);
    }
    _scrollLockKeydownHandler = null;
    _browserShortcutKeydownHandler = null;
    if (_term) { try { _term.dispose(); } catch {} _term = null; }
    _fitAddon = null;
    _container = null;
  }

  return {
    mount,
    connect,
    focus,
    scrollToBottom,
    resize,
    dispose,
    // Delegation to pty client
    scheduleReconnect: () => { if (_ptyClient) _ptyClient.scheduleReconnect(); },
    sendTakeControl: () => { if (_ptyClient) _ptyClient.sendTakeControl(); },
    sendFitResize: (options?: { force?: boolean; fit?: boolean; immediate?: boolean }) => _ptyClient
      ? _ptyClient.sendFitResize(options)
      : Promise.resolve("cancelled" as const),
    forceRepaint,
    syncLayout,
    send: (data) => {
      if (!_ptyClient || !_ptyClient.isOpen) return false;
      const accepted = _ptyClient.send(data);
      if (accepted && !_firstInputAccepted) {
        _firstInputAccepted = true;
        __wfTraceEvent(__wfTraceGet(opts.session, opts.machine || ""), "first.input.accepted", { source: "controller.send" });
      }
      return accepted;
    },
    resetRetry: () => { if (_ptyClient) _ptyClient.resetRetry(); },
    reconnect: (reconnectOpts?: { takeControl?: boolean }) => { if (_ptyClient) _ptyClient.reconnect(reconnectOpts); },
    // Accessors
    get term() { return _term; },
    get fitAddon() { return _fitAddon; },
    get ptyClient() { return _ptyClient; },
    get hydration() { return _hydration; },
    get supportsOrderedResize() { return _ptyClient?.supportsOrderedResize ?? false; },
    get isConnected() { return !!(_ptyClient && _ptyClient.isOpen); },
    get retryBlocked() { return _ptyClient ? _ptyClient.retryBlocked : false; },
  };
}
