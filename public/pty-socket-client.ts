import { createAttachDimensionRetryState } from "../src/attach-dimension-retry";
import { nextAttachDimensionAction } from "../src/attach-dimensions";
import { shouldUseAttachAckFallback } from "../src/attach-ack";
import {
  OrderedResizeTracker,
  shouldSendResizeRequest,
  type OrderedResizeRequest,
  type OrderedResizeSettlement,
} from "./ordered-resize";
import { createReconnector } from "./reconnector";
import {
  resolveLayoutStableDebugMode,
  shouldSendImmediateLayoutStable,
  type LayoutStablePrefillMode,
} from "../src/terminal-layout-stable-debug";
import { TERMINAL_PREFILL_MODE } from "../src/terminal-prefill";
import {
  ACK_EVERY_BYTES, ACK_MAX_DELAY_MS, ACK_RETRY_DELAY_MS, ACK_RETRY_MAX_ATTEMPTS,
  PTY_ATTACH_CAPABILITY, PTY_LIVENESS_MESSAGE, VIEWER_WINDOW_BYTES,
} from "../src/pty-websocket-contract";
import type { PtyOutputAck } from "../src/pty-websocket-contract";
import { MOBILE_FOREGROUND_PROBE_MS } from "../src/mobile-foreground";
import { classifyDisconnect } from "../src/take-control-logic";
import { splitTerminalInputBytes } from "../src/terminal-input";
import {
  CLOSE_CODE_PREFILL_TIMEOUT,
  CLOSE_CODE_SERVER_ERROR,
  WS_CLOSE_REASONS,
} from "../src/ws-constants";
import {
  __wfTraceEvent,
  __wfTraceGet,
  __wfTraceRafStart,
  __wfTraceRafStop,
  __wfTraceStart,
  wfTraceEnabled,
  type TraceState,
} from "./app-debug";

const ATTACH_DIMENSION_RETRY_DELAY_MS = 50;
const ATTACH_DIMENSION_MAX_ATTEMPTS = 20;
export const RESIZE_SEND_DEBOUNCE_MS = 120;
const ORDERED_RESIZE_BARRIER_MAX_BYTES = 1_048_576;
const PREFILL_PROTOCOL_TIMEOUT_MS = 15_000;

export interface PtySocketClientDependencies {
  readonly resolveReadyMachineOrigin: (machine: string) => string | undefined;
  readonly requestWebSocketTicket: (machine?: string) => Promise<string>;
  readonly getBrowserAuthToken: (origin: string) => string | null;
  readonly getDebugStorage: () => Pick<Storage, "getItem"> | null;
  /** Geometry most recently declared stable after paint. Defaults to one
   *  page-wide record so a session switch can reuse its predecessor's. */
  readonly layoutStableMemory?: LayoutStableMemory;
}

export interface TermDimensions {
  readonly cols: number;
  readonly rows: number;
}

/** Dimensions plus the container box they were fitted from when the last
 *  after-paint `layout_stable` was sent. */
export interface StableLayout {
  readonly dimensions: TermDimensions;
  readonly metrics: TerminalLayoutMetrics;
}

export interface LayoutStableMemory {
  last: StableLayout | null;
}

export function createLayoutStableMemory(): LayoutStableMemory {
  return { last: null };
}

const sharedLayoutStableMemory = createLayoutStableMemory();

function sameDimensions(a: TermDimensions, b: TermDimensions): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}

function sameLayoutMetrics(a: TerminalLayoutMetrics, b: TerminalLayoutMetrics): boolean {
  return a.containerWidth === b.containerWidth
    && a.containerClientWidth === b.containerClientWidth
    && a.viewportWidth === b.viewportWidth;
}

export interface TerminalLayoutMetrics {
  readonly containerWidth: number;
  readonly containerClientWidth: number;
  readonly viewportWidth: number;
}

export type PtySocketSendData = string | Blob | ArrayBuffer | ArrayBufferView<ArrayBufferLike>;

export interface PtySocketClientOpts {
  readonly session: string;
  readonly machine?: string;
  readonly resetPty?: boolean;
  readonly prefillMode?: LayoutStablePrefillMode;
  readonly takeControlOnAttach?: boolean;
  readonly getTermDimensions: () => TermDimensions | null;
  readonly getProposedDimensions?: () => TermDimensions | null;
  readonly getLayoutMetrics?: () => TerminalLayoutMetrics | null;
  /** True while a known layout transition (e.g. sidebar animation) is in flight. */
  readonly isLayoutTransient?: () => boolean;
  readonly fitTerminal: () => void;
  readonly isTerminalReady?: () => boolean;
  readonly onBinaryData?: (data: Uint8Array<ArrayBuffer>) => void;
  readonly onAttach?: () => void;
  readonly onOpen?: (wasReconnect: boolean) => void;
  readonly onPtyReady?: () => void;
  readonly onResizeAck?: (cols: number, rows: number) => void;
  readonly onPrefillDone?: () => void;
  readonly onViewerConflict?: () => void;
  readonly onControlGranted?: () => void;
  readonly onSubSessionOpened?: (parentSession: string, session: string) => void;
  readonly onReplacePrefill?: () => void;
  readonly onDisconnected?: (code: number, reason: string) => void;
  readonly onReconnecting?: () => void;
  readonly onReconnectExhausted?: () => void;
  readonly onRouteUnavailable?: () => void;
  readonly shouldReconnect?: () => boolean;
}

export interface BuildPtyWebSocketUrlOptions {
  readonly origin: string;
  readonly session: string;
  readonly ticket?: string;
  readonly reset?: boolean;
}

export function buildPtyWebSocketUrl(options: BuildPtyWebSocketUrlOptions): string {
  const target = new URL("/ws/pty", options.origin);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  target.searchParams.set("session", options.session);
  if (options.ticket) target.searchParams.set("ticket", options.ticket);
  if (options.reset) target.searchParams.set("reset", "1");
  return target.href;
}

export interface PtySocketClient {
  connect(): void;
  notifyTerminalReady(): void;
  probe(epoch?: number): Promise<boolean>;
  reconnect(reconnectOpts?: { readonly takeControl?: boolean }): void;
  scheduleReconnect(): void;
  sendFitResize(options?: { readonly force?: boolean; readonly fit?: boolean; readonly immediate?: boolean }): Promise<OrderedResizeSettlement>;
  sendResize(cols: number, rows: number): Promise<OrderedResizeSettlement>;
  readonly supportsOrderedResize: boolean;
  sendTakeControl(): void;
  send(data: PtySocketSendData): boolean;
  close(): void;
  resetRetry(): void;
  readonly ws: WebSocket | null;
  readonly isOpen: boolean;
  readonly retryBlocked: boolean;
}

export function createPtySocketClient(
  opts: PtySocketClientOpts,
  dependencies: PtySocketClientDependencies,
): PtySocketClient {
  let ws: WebSocket | null = null;
  const _rc = createReconnector({
    shouldReconnect: opts.shouldReconnect,
    onReconnecting: opts.onReconnecting,
    onExhausted: opts.onReconnectExhausted,
  });
  let hasConnected = false;
  let connectGeneration = 0;
  let connectPending = false;
  let pendingProbe: Promise<boolean> | null = null;
  let finishProbe: ((alive: boolean) => void) | null = null;

  let probeEpoch = 0;
  function probe(epoch = 0): Promise<boolean> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    if (pendingProbe && probeEpoch === epoch) return pendingProbe;
    finishProbe?.(false);
    probeEpoch = epoch;
    pendingProbe = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => complete(false), MOBILE_FOREGROUND_PROBE_MS);
      const complete = (alive: boolean): void => {
        // Even an already-queued old timer must not finish a newer probe.
        if (finishProbe !== complete) return;
        clearTimeout(timer);
        finishProbe = null;
        pendingProbe = null;
        resolve(alive);
      };
      finishProbe = complete;
    });
    const result = pendingProbe;
    try {
      if (!send(JSON.stringify({ type: PTY_LIVENESS_MESSAGE.PING }))) finishProbe?.(false);
    } catch (error: unknown) {
      console.warn("[pty-ws] foreground probe send failed:", error);
      finishProbe?.(false);
    }
    return result;
  }
  let consumeReset = !!opts.resetPty;
  let _initialPrefillMode = opts.prefillMode || TERMINAL_PREFILL_MODE.FULL;
  let _attachAckTimer: ReturnType<typeof setTimeout> | null = null;
  let _attachAckReceived = false;
  let _awaitingAttachAck = false;
  let _prefillChunks: Uint8Array<ArrayBuffer>[] = [];
  let _awaitingPrefillDone = false;
  let _sawViewportPrefill = false;
  let _currentAttachPrefillMode = _initialPrefillMode;
  let _prefillDoneTimeout: ReturnType<typeof setTimeout> | null = null;
  const _attachDimensionRetry = createAttachDimensionRetryState();
  const _layoutStableDebugMode = resolveLayoutStableDebugMode(dependencies.getDebugStorage(), wfTraceEnabled);
  const _layoutStableMemory = dependencies.layoutStableMemory ?? sharedLayoutStableMemory;
  // Diagnostic tracer (scrolldown investigation). Created per attach in
  // sendAttachHandshake. Read via window.__wf_dumpTrace().
  let _trace: TraceState | null = null;
  let _supportsOrderedResize = false;
  let _supportsOutputAck = false;
  let _receivedOutputBytes = 0;
  let _lastAckBytes = 0;
  let _outputAckTimer: ReturnType<typeof setTimeout> | null = null;
  let _outputAckRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let _outputAckRetries = 0;
  let _hasAttached = false;
  let _attachUsesProposedDimensions = false;
  let _orderedResizeBarrier = false;
  let _resizeGeneration = 0;
  type DeferredOrderedResizeFrame =
    | { readonly kind: "binary"; readonly data: ArrayBuffer; readonly bytes: number }
    | { readonly kind: "control"; readonly message: SocketControlMessage; readonly bytes: number };
  let _deferredOrderedResizeFrames: DeferredOrderedResizeFrame[] = [];
  let _deferredOrderedResizeBytes = 0;

  type PtySocketRoute =
    | { readonly kind: "available"; readonly url: string }
    | { readonly kind: "unavailable" };

  function buildUrl(ticket: string | undefined): PtySocketRoute {
    const origin = opts.machine ? dependencies.resolveReadyMachineOrigin(opts.machine) : location.origin;
    if (!origin) return { kind: "unavailable" };
    const reset = consumeReset;
    const url = buildPtyWebSocketUrl({ origin, session: opts.session, ticket, reset });
    consumeReset = false;
    return { kind: "available", url };
  }

  /** Send one attach handshake to bootstrap PTY spawn on fresh WS open. */
  let _takeControlOnAttach = !!opts.takeControlOnAttach;

  function sendAttachHandshake() {
    if (!ws || ws.readyState !== WebSocket.OPEN || opts.isTerminalReady?.() === false) return;
    cancelResizeLifecycle();
    _attachUsesProposedDimensions = _hasAttached;
    if (!_attachUsesProposedDimensions) {
      try { opts.fitTerminal(); } catch {}
    }
    const dims = _attachUsesProposedDimensions
      ? (opts.getProposedDimensions?.() ?? opts.getTermDimensions())
      : opts.getTermDimensions();
    const dimensionAction = nextAttachDimensionAction(
      dims,
      _attachDimensionRetry.attempt,
      ATTACH_DIMENSION_MAX_ATTEMPTS,
    );
    if (dimensionAction.kind === "retry") {
      _attachDimensionRetry.setAttempt(dimensionAction.nextAttempt);
      _attachDimensionRetry.schedule(sendAttachHandshake, ATTACH_DIMENSION_RETRY_DELAY_MS);
      return;
    }
    if (dimensionAction.kind === "fail") {
      clearAttachRetryState();
      ws.close(CLOSE_CODE_SERVER_ERROR, "attach dimensions unavailable");
      return;
    }
    clearAttachRetryState();
    const attachDims = dims;
    if (!attachDims) return;
    if (_prefillDoneTimeout) { clearTimeout(_prefillDoneTimeout); _prefillDoneTimeout = null; }
    if (opts.onAttach) opts.onAttach();
    const prefillMode = _initialPrefillMode;
    _hasAttached = true;
    _currentAttachPrefillMode = prefillMode;
    _lastSentResize = attachDims.cols + "x" + attachDims.rows;
    _awaitingAttachAck = true;
    _attachAckReceived = false;
    _prefillChunks = [];
    _awaitingPrefillDone = prefillMode !== TERMINAL_PREFILL_MODE.NONE;
    _sawViewportPrefill = false;
    const msg: { type: "attach"; cols: number; rows: number; prefillMode: string; capabilities: string[]; takeControl?: true } = {
      type: "attach", cols: attachDims.cols, rows: attachDims.rows, prefillMode,
      capabilities: [PTY_ATTACH_CAPABILITY.OUTPUT_ACK],
    };
    if (_takeControlOnAttach) { msg.takeControl = true; _takeControlOnAttach = false; }
    // Diag: start a fresh trace per attach so reconnects/take-controls show up
    // as separate sessions in the dump.
    _trace = __wfTraceGet(opts.session, opts.machine || "") || __wfTraceStart(opts.session, opts.machine || "", {
      cols: attachDims.cols, rows: attachDims.rows, prefillMode,
      takeControl: !!msg.takeControl, reset: !!opts.resetPty,
    });
    const layoutMetrics = opts.getLayoutMetrics?.() ?? null;
    __wfTraceEvent(_trace, "attach.send", {
      ...(layoutMetrics ?? {}),
      cols: attachDims.cols,
      rows: attachDims.rows,
      prefillMode,
      layoutStableDebugMode: _layoutStableDebugMode,
    });
    __wfTraceRafStart(_trace);
    if (prefillMode !== TERMINAL_PREFILL_MODE.NONE) {
      const attachedSocket = ws;
      _prefillDoneTimeout = setTimeout(() => {
        _prefillDoneTimeout = null;
        if (!_awaitingPrefillDone || ws !== attachedSocket || attachedSocket.readyState !== WebSocket.OPEN) return;
        __wfTraceEvent(_trace, "prefill.timeout", { timeoutMs: PREFILL_PROTOCOL_TIMEOUT_MS });
        attachedSocket.close(CLOSE_CODE_PREFILL_TIMEOUT, WS_CLOSE_REASONS.PREFILL_TIMEOUT);
      }, PREFILL_PROTOCOL_TIMEOUT_MS);
    }
    ws.send(JSON.stringify(msg));
    if (shouldSendImmediateLayoutStable(_layoutStableDebugMode, prefillMode)) {
      sendLayoutStable("immediate");
    } else if (isKnownStableGeometry(attachDims)) {
      // The previous attach declared these dims stable after paint, the
      // container box is unchanged since, and no layout transition is in
      // flight: let the server stop its settle wait now. The after-paint send
      // below still runs (ordered peers need its resize acknowledgement) and
      // corrects any late change.
      sendLayoutStable("same-geometry");
    }
    if (_attachAckTimer) clearTimeout(_attachAckTimer);
    // Compatibility fallback: older servers don't implement attach_ack.
    _attachAckTimer = setTimeout(() => {
      _attachAckTimer = null;
      if (!shouldUseAttachAckFallback({
        ackReceived: _attachAckReceived,
        awaitingAck: _awaitingAttachAck,
      })) return;
      _awaitingAttachAck = false;
      _lastSentResize = "";
      sendFitResize();
    }, 300);
  }

  function clearAttachRetryState(): void {
    _attachDimensionRetry.clear();
  }

  function resetAttachLifecycle(): void {
    resetOutputAck();
    clearAttachRetryState();
    _awaitingAttachAck = false;
    _awaitingPrefillDone = false;
    _prefillChunks = [];
    _sawViewportPrefill = false;
    cancelResizeLifecycle();
    if (_prefillDoneTimeout) { clearTimeout(_prefillDoneTimeout); _prefillDoneTimeout = null; }
    if (_attachAckTimer) { clearTimeout(_attachAckTimer); _attachAckTimer = null; }
  }

  function shouldUseProposedDimensions(): boolean {
    return _supportsOrderedResize || (_attachUsesProposedDimensions && _awaitingAttachAck);
  }

  function isKnownStableGeometry(attachDims: TermDimensions): boolean {
    const last = _layoutStableMemory.last;
    const metrics = opts.getLayoutMetrics?.() ?? null;
    return !!last && !!metrics
      && sameDimensions(last.dimensions, attachDims)
      && sameLayoutMetrics(last.metrics, metrics)
      && !opts.isLayoutTransient?.();
  }

  function sendLayoutStable(
    reason: "after-paint" | "immediate" | "same-geometry" = "after-paint",
    forceOrderedResize = false,
  ): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const useProposedDimensions = shouldUseProposedDimensions();
    if (!useProposedDimensions) {
      try { opts.fitTerminal(); } catch {}
    }
    const dims = useProposedDimensions
      ? (opts.getProposedDimensions?.() ?? opts.getTermDimensions())
      : opts.getTermDimensions();
    if (!dims) return;
    const key = dims.cols + "x" + dims.rows;
    if (forceOrderedResize || key !== _lastSentResize) {
      void queueResize(dims, { force: forceOrderedResize, immediate: true });
    }
    ws.send(JSON.stringify({ type: "layout_stable", cols: dims.cols, rows: dims.rows, reason }));
    const layoutMetrics = opts.getLayoutMetrics?.() ?? null;
    if (reason === "after-paint") {
      _layoutStableMemory.last = layoutMetrics
        ? { dimensions: { cols: dims.cols, rows: dims.rows }, metrics: layoutMetrics }
        : null;
    }
    __wfTraceEvent(_trace, "layout_stable.send", {
      ...(layoutMetrics ?? {}),
      cols: dims.cols,
      rows: dims.rows,
      reason,
    });
  }

  function sendLayoutStableAfterPaint(forceOrderedResize = false): void {
    const socket = ws;
    const generation = _resizeGeneration;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (ws !== socket || _resizeGeneration !== generation) return;
        sendLayoutStable("after-paint", forceOrderedResize);
      });
    });
  }

  /** Sends resize requests, delaying local geometry only when negotiated. */
  let _lastSentResize = "";
  const _orderedResize = new OrderedResizeTracker();
  let _resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let _pendingResizeProposal: {
    readonly dimensions: TermDimensions;
    readonly force: boolean;
    readonly ready: boolean;
  } | null = null;
  let _drainingOrderedResize = false;
  // Superseded proposals share one settlement: the latest outstanding geometry
  // must be acknowledged (or the lifecycle cancelled), not an intermediate ack.
  let _resizeSettlement: {
    readonly promise: Promise<OrderedResizeSettlement>;
    readonly resolve: (settlement: OrderedResizeSettlement) => void;
  } | null = null;

  function waitForResizeSettlement(): Promise<OrderedResizeSettlement> {
    if (!_pendingResizeProposal && !_orderedResize.hasPending()) return Promise.resolve("acknowledged");
    if (!_resizeSettlement) {
      // Promise executors run synchronously, before the resolver is stored.
      let resolve!: (settlement: OrderedResizeSettlement) => void;
      const promise = new Promise<OrderedResizeSettlement>((settle) => { resolve = settle; });
      _resizeSettlement = { promise, resolve };
    }
    return _resizeSettlement.promise;
  }

  function settleResize(settlement: OrderedResizeSettlement): void {
    const pending = _resizeSettlement;
    _resizeSettlement = null;
    pending?.resolve(settlement);
  }

  function clearQueuedResizeRequest(): void {
    if (_resizeDebounceTimer) clearTimeout(_resizeDebounceTimer);
    _resizeDebounceTimer = null;
    _pendingResizeProposal = null;
  }

  function cancelResizeLifecycle(): void {
    _resizeGeneration++;
    clearQueuedResizeRequest();
    settleResize("cancelled");
    _orderedResize.clear();
    _supportsOrderedResize = false;
    _orderedResizeBarrier = false;
    _deferredOrderedResizeFrames = [];
    _deferredOrderedResizeBytes = 0;
  }

  function createResizeRequest(dims: TermDimensions): OrderedResizeRequest | { readonly type: "resize"; readonly cols: number; readonly rows: number } {
    return _supportsOrderedResize
      ? _orderedResize.request(dims)
      : { type: "resize", ...dims };
  }

  function sendResizeRequest(request: OrderedResizeRequest | { readonly type: "resize"; readonly cols: number; readonly rows: number }): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    _lastSentResize = `${request.cols}x${request.rows}`;
    // An ordered resize is a broker/local geometry transaction. Hold output
    // only once the request actually leaves this socket; queued proposals may
    // still be replaced without requiring a barrier.
    if ("resizeId" in request) _orderedResizeBarrier = true;
    ws.send(JSON.stringify(request));
  }

  function flushQueuedResize(): void {
    if (!_pendingResizeProposal?.ready || _orderedResize.hasPending() || _drainingOrderedResize) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const proposal = _pendingResizeProposal;
    clearQueuedResizeRequest();
    if (shouldSendResizeRequest(proposal.dimensions, _lastSentResize, proposal.force)) {
      // Allocate the ID only at transmission. New proposals must never invalidate
      // the acknowledgment of geometry already in flight.
      sendResizeRequest(createResizeRequest(proposal.dimensions));
    }
    if (!_orderedResize.hasPending()) settleResize("acknowledged");
  }

  function queueResize(dims: TermDimensions, options: { readonly force?: boolean; readonly immediate?: boolean } = {}): Promise<OrderedResizeSettlement> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve("cancelled");
    const key = `${dims.cols}x${dims.rows}`;
    const force = options.force === true || _pendingResizeProposal?.force === true;
    if (!force && key === _lastSentResize) {
      // Reverting to the sent geometry cancels a not-yet-sent proposal, but an
      // active ordered transaction still needs its acknowledgment.
      clearQueuedResizeRequest();
      if (!_orderedResize.hasPending()) settleResize("acknowledged");
      return _supportsOrderedResize ? waitForResizeSettlement() : Promise.resolve("acknowledged");
    }
    _pendingResizeProposal = {
      dimensions: dims,
      force,
      ready: options.immediate === true || _pendingResizeProposal?.ready === true,
    };
    if (_pendingResizeProposal.ready) {
      flushQueuedResize();
    } else if (!_resizeDebounceTimer) {
      // Latest-value delivery with a bounded window, not a trailing debounce.
      // One in-flight transaction also prevents starving the server's debounce.
      _resizeDebounceTimer = setTimeout(() => {
        _resizeDebounceTimer = null;
        if (!_pendingResizeProposal) return;
        _pendingResizeProposal = { ..._pendingResizeProposal, ready: true };
        flushQueuedResize();
      }, RESIZE_SEND_DEBOUNCE_MS);
    }
    return _supportsOrderedResize ? waitForResizeSettlement() : Promise.resolve("acknowledged");
  }

  function sendFitResize(options?: { force?: boolean; fit?: boolean; immediate?: boolean }): Promise<OrderedResizeSettlement> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve("cancelled");
    const useProposedDimensions = shouldUseProposedDimensions();
    if (!useProposedDimensions && options?.fit !== false) {
      try { opts.fitTerminal(); } catch {}
    }
    const dims = useProposedDimensions
      ? (opts.getProposedDimensions?.() ?? opts.getTermDimensions())
      : opts.getTermDimensions();
    if (!dims) return Promise.resolve("cancelled");
    return queueResize(dims, options);
  }

  type SocketControlMessage = Readonly<Record<string, unknown>> & { readonly type: string };
  type SocketControlHandler = (message: SocketControlMessage) => void;

  function isOrderedResizeBarrierControl(type: string): boolean {
    return type === "prefill_viewport" || type === "prefill_done" || type === "pty_ready";
  }

  function deferOrderedResizeFrame(frame: DeferredOrderedResizeFrame): void {
    if (_deferredOrderedResizeBytes + frame.bytes > ORDERED_RESIZE_BARRIER_MAX_BYTES) {
      ws?.close(CLOSE_CODE_SERVER_ERROR, "ordered resize barrier overflow");
      return;
    }
    _deferredOrderedResizeBytes += frame.bytes;
    _deferredOrderedResizeFrames.push(frame);
  }

  function releaseOrderedResizeBarrier(): void {
    _orderedResizeBarrier = false;
    const frames = _deferredOrderedResizeFrames;
    _deferredOrderedResizeFrames = [];
    _deferredOrderedResizeBytes = 0;
    const socket = ws;
    const generation = _resizeGeneration;
    for (const frame of frames) {
      if (ws !== socket || _resizeGeneration !== generation) break;
      if (frame.kind === "binary") handleBinaryFrame(frame.data);
      else {
        const handler = terminalControlHandlers[frame.message.type] ?? applicationControlHandlers[frame.message.type];
        if (handler) handler(frame.message);
      }
    }
  }

  function handleAttachAck(message: SocketControlMessage): void {
    _supportsOutputAck = Array.isArray(message.capabilities)
      && message.capabilities.includes(PTY_ATTACH_CAPABILITY.OUTPUT_ACK);
    __wfTraceEvent(_trace, "attach_ack");
    _supportsOrderedResize = Array.isArray(message.capabilities)
      && message.capabilities.includes(PTY_ATTACH_CAPABILITY.ORDERED_RESIZE_ACK);
    _orderedResizeBarrier = _supportsOrderedResize;
    _attachAckReceived = true;
    _awaitingAttachAck = false;
    if (_attachAckTimer) { clearTimeout(_attachAckTimer); _attachAckTimer = null; }
    // Re-check dimensions after layout settles — catches stale initial dims on
    // mobile where layout isn't finalized at connect time. Ordered peers must
    // acknowledge even matching attach geometry before the local terminal can
    // commit a reconnect/take-control proposal.
    sendLayoutStableAfterPaint(_supportsOrderedResize);
  }

  function handleResizeAck(message: SocketControlMessage): void {
    if (!_supportsOrderedResize) return;
    const dimensions = _orderedResize.acknowledge(message);
    if (!dimensions) return;
    _lastSentResize = `${dimensions.cols}x${dimensions.rows}`;
    _drainingOrderedResize = true;
    try {
      opts.onResizeAck?.(dimensions.cols, dimensions.rows);
      releaseOrderedResizeBarrier();
    } finally {
      _drainingOrderedResize = false;
    }
    // The previous geometry and all its buffered frames must land before the
    // next send can establish another output barrier (including callback sends).
    flushQueuedResize();
    if (!_pendingResizeProposal && !_orderedResize.hasPending()) settleResize("acknowledged");
  }

  function handlePtyReady(): void {
    __wfTraceEvent(_trace, "pty_ready");
    _rc.connected();
    if (opts.onPtyReady) opts.onPtyReady();
  }

  function handlePrefillViewport(): void {
    // Phase 1 complete: viewport content already written as binary.
    const viewportChunks = _prefillChunks;
    _prefillChunks = [];
    const viewportBytes = viewportChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    __wfTraceEvent(_trace, "prefill_viewport", {
      viewportFrames: viewportChunks.length,
      viewportBytes,
    });
    if (opts.onBinaryData) {
      for (const chunk of viewportChunks) opts.onBinaryData(chunk);
    }
    // Stay in prefill mode for phase 2 scrollback (if server sends it). Keep
    // buffering until the authoritative prefill_done boundary. The attach-level
    // protocol deadline closes/reconnects rather than revealing partial output.
    _awaitingPrefillDone = true;
    _sawViewportPrefill = true;
  }

  function handlePrefillDone(): void {
    // Phase 2 complete (or single-phase legacy): flush remaining chunks.
    _awaitingPrefillDone = false;
    if (_prefillDoneTimeout) { clearTimeout(_prefillDoneTimeout); _prefillDoneTimeout = null; }
    const chunks = _prefillChunks;
    _prefillChunks = [];
    const bufferedBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    __wfTraceEvent(_trace, "prefill_done", {
      bufferedFrames: chunks.length,
      bufferedBytes,
      sawViewportPrefill: _sawViewportPrefill,
    });
    if (_sawViewportPrefill && chunks.length && opts.onReplacePrefill) {
      opts.onReplacePrefill();
    }
    _sawViewportPrefill = false;
    if (opts.onBinaryData) {
      for (const chunk of chunks) opts.onBinaryData(chunk);
    }
    if (opts.onPrefillDone) opts.onPrefillDone();
  }

  function handleViewerConflict(): void {
    __wfTraceEvent(_trace, "viewer_conflict");
    console.log("[pty-ws]", opts.session, "viewer_conflict");
    _awaitingAttachAck = false;
    _awaitingPrefillDone = false;
    _prefillChunks = [];
    _sawViewportPrefill = false;
    if (_prefillDoneTimeout) { clearTimeout(_prefillDoneTimeout); _prefillDoneTimeout = null; }
    if (_attachAckTimer) { clearTimeout(_attachAckTimer); _attachAckTimer = null; }
    if (opts.onViewerConflict) opts.onViewerConflict();
  }

  function handleControlGranted(): void {
    __wfTraceEvent(_trace, "control_granted");
    console.log("[pty-ws]", opts.session, "control_granted — sending re-attach");
    // Fresh viewer takeover needs a fresh attach bootstrap.
    sendAttachHandshake();
    if (opts.onControlGranted) opts.onControlGranted();
  }

  function handleSubSessionOpened(message: SocketControlMessage): void {
    if (typeof message.parentSession !== "string" || typeof message.session !== "string") return;
    if (opts.onSubSessionOpened) opts.onSubSessionOpened(message.parentSession, message.session);
  }

  const terminalControlHandlers: Readonly<Record<string, SocketControlHandler>> = {
    attach_ack: handleAttachAck,
    resize_ack: handleResizeAck,
    pty_ready: handlePtyReady,
    prefill_viewport: handlePrefillViewport,
    prefill_done: handlePrefillDone,
    viewer_conflict: handleViewerConflict,
    control_granted: handleControlGranted,
  };
  const applicationControlHandlers: Readonly<Record<string, SocketControlHandler>> = {
    sub_session_opened: handleSubSessionOpened,
  };

  function handleTextFrame(raw: string): void {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const message = parsed as Readonly<Record<string, unknown>>;
      if (typeof message.type !== "string") return;
      if (message.type === PTY_LIVENESS_MESSAGE.PONG) { finishProbe?.(true); return; }
      const typedMessage = message as SocketControlMessage;
      if (_orderedResizeBarrier && isOrderedResizeBarrierControl(typedMessage.type)) {
        deferOrderedResizeFrame({ kind: "control", message: typedMessage, bytes: new TextEncoder().encode(raw).byteLength });
        return;
      }
      const handler = terminalControlHandlers[typedMessage.type] ?? applicationControlHandlers[typedMessage.type];
      if (handler) handler(typedMessage);
    } catch (error: unknown) {
      console.warn("[pty-ws] failed to handle control message:", error);
    }
  }

  function resetOutputAck(): void {
    if (_outputAckTimer) clearTimeout(_outputAckTimer);
    _outputAckTimer = null;
    if (_outputAckRetryTimer) clearTimeout(_outputAckRetryTimer);
    _outputAckRetryTimer = null;
    _outputAckRetries = 0;
    _supportsOutputAck = false;
    _receivedOutputBytes = 0;
    _lastAckBytes = 0;
  }

  function sendOutputAck(retry = false): void {
    if (retry) _outputAckRetryTimer = null;
    if (_outputAckTimer) clearTimeout(_outputAckTimer);
    _outputAckTimer = null;
    if (!_supportsOutputAck || !ws || ws.readyState !== WebSocket.OPEN
      || (!retry && _receivedOutputBytes === _lastAckBytes)) return;
    const message: PtyOutputAck = { type: "ack", bytes: _receivedOutputBytes };
    ws.send(JSON.stringify(message));
    _lastAckBytes = message.bytes;
    if (retry) _outputAckRetries++;
    // There is no server-confirmed ack watermark. Receipt proves only that
    // at least (received - window) bytes were credited, not that ws.send's
    // last ack arrived. Conservatively retry a potentially full quiet window.
    const minimumServerAcked = Math.max(0, _receivedOutputBytes - VIEWER_WINDOW_BYTES);
    const possiblyUnacked = _receivedOutputBytes - minimumServerAcked;
    if (possiblyUnacked >= VIEWER_WINDOW_BYTES - ACK_EVERY_BYTES
      && _outputAckRetries < ACK_RETRY_MAX_ATTEMPTS && !_outputAckRetryTimer) {
      _outputAckRetryTimer = setTimeout(() => sendOutputAck(true), ACK_RETRY_DELAY_MS);
    }
  }

  function receiveOutputBytes(bytes: number): void {
    if (!_supportsOutputAck || bytes === 0) return;
    // New output cancels the quiet period's stale retry and starts a fresh
    // bounded budget for the next cumulative ack, never a perpetual retry loop.
    if (_outputAckRetryTimer) clearTimeout(_outputAckRetryTimer);
    _outputAckRetryTimer = null;
    _outputAckRetries = 0;
    const received = _receivedOutputBytes + bytes;
    if (!Number.isSafeInteger(received)) {
      ws?.close(CLOSE_CODE_SERVER_ERROR, WS_CLOSE_REASONS.SLOW_VIEWER);
      return;
    }
    _receivedOutputBytes = received;
    if (_receivedOutputBytes - _lastAckBytes >= ACK_EVERY_BYTES) {
      sendOutputAck();
    } else if (!_outputAckTimer) {
      _outputAckTimer = setTimeout(sendOutputAck, ACK_MAX_DELAY_MS);
    }
  }

  function handleBinaryFrame(data: ArrayBuffer): void {
    if (_orderedResizeBarrier) {
      deferOrderedResizeFrame({ kind: "binary", data: data.slice(0), bytes: data.byteLength });
      return;
    }
    if (_awaitingPrefillDone) {
      const bytes = new Uint8Array(data);
      if (_prefillChunks.length === 0) __wfTraceEvent(_trace, "prefill.first_chunk", { size: bytes.length });
      const streamHiddenFullPrefill = _currentAttachPrefillMode === TERMINAL_PREFILL_MODE.FULL && !_sawViewportPrefill;
      __wfTraceEvent(_trace, "ws.binary", {
        bucket: "prefill",
        size: bytes.length,
        buffered: streamHiddenFullPrefill ? 0 : _prefillChunks.length + 1,
      });
      if (streamHiddenFullPrefill) {
        if (opts.onBinaryData) opts.onBinaryData(bytes);
        return;
      }
      _prefillChunks.push(bytes);
      return;
    }
    const bytes = new Uint8Array(data);
    __wfTraceEvent(_trace, "ws.binary", { bucket: "replay", size: bytes.length });
    if (opts.onBinaryData) opts.onBinaryData(bytes);
  }

  function connect(): void {
    _rc.cancel();
    if (ws && ws.readyState <= WebSocket.OPEN) return;
    if (connectPending) return;

    const generation = ++connectGeneration;
    let connectFailed = false;
    connectPending = true;
    const origin = opts.machine ? dependencies.resolveReadyMachineOrigin(opts.machine) : location.origin;
    void (origin && dependencies.getBrowserAuthToken(origin) ? dependencies.requestWebSocketTicket(opts.machine) : Promise.resolve(undefined)).then((ticket) => {
      if (generation !== connectGeneration) return;
      const route = buildUrl(ticket);
      if (route.kind === "unavailable") {
        _rc.block();
        if (opts.onRouteUnavailable) opts.onRouteUnavailable();
        return;
      }
      const sock = new WebSocket(route.url);
      sock.binaryType = "arraybuffer";
      ws = sock;

      sock.onopen = () => {
        if (ws !== sock) return;
        console.log("[pty-ws]", opts.session, "ws.onopen, readyState=", sock.readyState);
        const wasReconnect = hasConnected;
        hasConnected = true;
        sendAttachHandshake();
        __wfTraceEvent(_trace, "ws.open", { wasReconnect });
        if (opts.onOpen) opts.onOpen(wasReconnect);
      };

      sock.onmessage = (event) => {
        if (ws !== sock) return;
        if (typeof event.data === "string") {
          handleTextFrame(event.data);
          return;
        }
        // Account at receipt, before prefill/resize barriers. Barrier replay
        // calls handleBinaryFrame again and must not acknowledge bytes twice.
        const data = event.data as ArrayBuffer;
        receiveOutputBytes(data.byteLength);
        if (ws === sock && sock.readyState === WebSocket.OPEN) handleBinaryFrame(data);
      };

      sock.onclose = (ev) => {
        if (ws !== sock) return;
        __wfTraceEvent(_trace, "ws.close", { code: ev.code, reason: String(ev.reason || "") });
        __wfTraceRafStop(_trace);
        ws = null;
        finishProbe?.(false);
        resetAttachLifecycle();
        if (classifyDisconnect(ev.code, ev.reason) !== "reconnect") _rc.block();
        if (opts.onDisconnected) opts.onDisconnected(ev.code, ev.reason);
      };

      sock.onerror = () => {};
    }).catch((error: unknown) => {
      if (generation === connectGeneration) {
        connectFailed = true;
        console.warn("[pty-ws] ticket request failed:", error);
      }
    }).finally(() => {
      if (generation !== connectGeneration) return;
      // Release pending ownership before evaluating retry readiness. Mount
      // may have become ready between the rejection handler and this callback.
      connectPending = false;
      if (connectFailed) scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    _rc.schedule(() => {
      if (!ws || ws.readyState === WebSocket.CLOSED) connect();
    });
  }

  function sendResize(cols: number, rows: number): Promise<OrderedResizeSettlement> {
    return queueResize({ cols, rows });
  }

  function sendTakeControl() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "take_control" }));
    }
  }

  function send(data: PtySocketSendData): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const maxBufferedBytes = 256 * 1024;
    const sendBounded = (frame: string | Blob | ArrayBuffer, byteLength: number): boolean => {
      if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + byteLength > maxBufferedBytes) return false;
      ws.send(frame);
      return true;
    };
    if (typeof data === "string") return sendBounded(data, new TextEncoder().encode(data).byteLength);
    if (data instanceof Blob) return sendBounded(data, data.size);
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (const frame of splitTerminalInputBytes(bytes)) {
      const copy = new ArrayBuffer(frame.byteLength);
      new Uint8Array(copy).set(frame);
      if (!sendBounded(copy, copy.byteLength)) return false;
    }
    return true;
  }

  function retireSocket(socket: WebSocket): void {
    finishProbe?.(false);
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    if (ws === socket) ws = null;
    try {
      socket.close();
    } catch (error) {
      console.warn("[pty-ws]", opts.session, "socket close failed", error);
    }
  }

  function close() {
    connectGeneration++;
    _rc.cancel();
    _rc.block();
    resetAttachLifecycle();
    if (ws) retireSocket(ws);
  }

  function resetRetry() {
    _rc.reset();
  }

  // Force-close a potentially zombie socket and reconnect. iOS/Android background
  // tabs kill TCP silently while readyState still reports OPEN — connect() guards
  // against this and bails. reconnect() bypasses that guard. See PR #89 review / df4180c.
  function reconnect(reconnectOpts?: { takeControl?: boolean }) {
    connectGeneration++;
    _rc.cancel();
    // Explicit retry/takeover may leave a terminal-blocked state; mount's
    // automatic reconciliation must not, but this fresh attempt may retry.
    if (_rc.isBlocked) _rc.reset();
    resetAttachLifecycle();
    _takeControlOnAttach = !!(reconnectOpts && reconnectOpts.takeControl);
    if (ws) retireSocket(ws);
    connect();
  }

  return {
    connect,
    notifyTerminalReady: () => {
      if (_hasAttached || _rc.isBlocked || opts.isTerminalReady?.() === false) return;
      if (!ws) {
        // Mount owns this readiness notification. Recover only after its
        // normal ownership predicate allows retry; pending connects coalesce.
        if (opts.shouldReconnect?.() !== false) connect();
        return;
      }
      sendAttachHandshake();
    },
    probe,
    reconnect,
    scheduleReconnect,
    sendFitResize,
    sendResize,
    sendTakeControl,
    send,
    close,
    resetRetry,
    get ws() { return ws; },
    get isOpen() { return !!(ws && ws.readyState === WebSocket.OPEN); },
    get retryBlocked() { return _rc.isBlocked; },
    get supportsOrderedResize() { return _supportsOrderedResize; },
  };
}
