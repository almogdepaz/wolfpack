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
import { PTY_ATTACH_CAPABILITY } from "../src/pty-websocket-contract";
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
}

export interface TermDimensions {
  readonly cols: number;
  readonly rows: number;
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
  readonly fitTerminal: () => void;
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

export interface PtySocketClient {
  connect(): void;
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
  // Diagnostic tracer (scrolldown investigation). Created per attach in
  // sendAttachHandshake. Read via window.__wf_dumpTrace().
  let _trace: TraceState | null = null;
  let _supportsOrderedResize = false;
  let _hasAttached = false;
  let _attachUsesProposedDimensions = false;
  let _orderedResizeBarrier = false;
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
    const target = new URL("/ws/pty", origin);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    target.searchParams.set("session", opts.session);
    if (ticket) target.searchParams.set("ticket", ticket);
    if (consumeReset) target.searchParams.set("reset", "1");
    consumeReset = false;
    return { kind: "available", url: target.href };
  }

  /** Send one attach handshake to bootstrap PTY spawn on fresh WS open. */
  let _takeControlOnAttach = !!opts.takeControlOnAttach;

  function sendAttachHandshake() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
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
    const msg: { type: "attach"; cols: number; rows: number; prefillMode: string; takeControl?: true } = { type: "attach", cols: attachDims.cols, rows: attachDims.rows, prefillMode };
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

  function sendLayoutStable(
    reason: "after-paint" | "immediate" = "after-paint",
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
    if (forceOrderedResize) sendResizeRequest(createResizeRequest(dims));
    else if (key !== _lastSentResize) sendResizeRequest(createResizeRequest(dims));
    ws.send(JSON.stringify({ type: "layout_stable", cols: dims.cols, rows: dims.rows, reason }));
    const layoutMetrics = opts.getLayoutMetrics?.() ?? null;
    __wfTraceEvent(_trace, "layout_stable.send", {
      ...(layoutMetrics ?? {}),
      cols: dims.cols,
      rows: dims.rows,
      reason,
    });
  }

  function sendLayoutStableAfterPaint(forceOrderedResize = false): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { sendLayoutStable("after-paint", forceOrderedResize); });
    });
  }

  /** Sends resize requests, delaying local geometry only when negotiated. */
  let _lastSentResize = "";
  const _orderedResize = new OrderedResizeTracker();
  let _resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let _pendingResizeRequest: OrderedResizeRequest | { readonly type: "resize"; readonly cols: number; readonly rows: number } | null = null;

  function clearQueuedResizeRequest(): void {
    if (_resizeDebounceTimer) clearTimeout(_resizeDebounceTimer);
    _resizeDebounceTimer = null;
    _pendingResizeRequest = null;
  }

  function cancelResizeLifecycle(): void {
    clearQueuedResizeRequest();
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
    clearQueuedResizeRequest();
    _lastSentResize = `${request.cols}x${request.rows}`;
    // An ordered resize is a broker/local geometry transaction. Hold output
    // only once the request actually leaves this socket; queued proposals may
    // still be replaced without requiring a barrier.
    if ("resizeId" in request) _orderedResizeBarrier = true;
    ws.send(JSON.stringify(request));
  }

  function queueResize(dims: TermDimensions, options: { readonly force?: boolean; readonly immediate?: boolean } = {}): Promise<OrderedResizeSettlement> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve("cancelled");
    const key = `${dims.cols}x${dims.rows}`;
    const pendingProposalSupersedesLastSent = _supportsOrderedResize
      && _orderedResize.hasPending()
      && !_orderedResize.hasPendingDimensions(dims);
    if (!options.force && key === _lastSentResize && !pendingProposalSupersedesLastSent) {
      if (!_supportsOrderedResize) clearQueuedResizeRequest();
      return _supportsOrderedResize ? _orderedResize.waitForSettlement() : Promise.resolve("acknowledged");
    }
    clearQueuedResizeRequest();
    const request = createResizeRequest(dims);
    _pendingResizeRequest = request;
    if (options.immediate) {
      sendResizeRequest(request);
    } else {
      _resizeDebounceTimer = setTimeout(() => {
        _resizeDebounceTimer = null;
        const pending = _pendingResizeRequest;
        _pendingResizeRequest = null;
        if (!pending || !shouldSendResizeRequest(pending, _lastSentResize, options.force === true)) return;
        sendResizeRequest(pending);
      }, RESIZE_SEND_DEBOUNCE_MS);
    }
    return _supportsOrderedResize ? _orderedResize.waitForSettlement() : Promise.resolve("acknowledged");
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
    for (const frame of frames) {
      if (frame.kind === "binary") handleBinaryFrame(frame.data);
      else {
        const handler = terminalControlHandlers[frame.message.type] ?? applicationControlHandlers[frame.message.type];
        if (handler) handler(frame.message);
      }
    }
  }

  function handleAttachAck(message: SocketControlMessage): void {
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
    opts.onResizeAck?.(dimensions.cols, dimensions.rows);
    releaseOrderedResizeBarrier();
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
        handleBinaryFrame(event.data as ArrayBuffer);
      };

      sock.onclose = (ev) => {
        if (ws !== sock) return;
        __wfTraceEvent(_trace, "ws.close", { code: ev.code, reason: String(ev.reason || "") });
        __wfTraceRafStop(_trace);
        ws = null;
        resetAttachLifecycle();
        if (opts.onDisconnected) opts.onDisconnected(ev.code, ev.reason);
      };

      sock.onerror = () => {};
    }).catch((error: unknown) => {
      if (generation === connectGeneration) {
        console.warn("[pty-ws] ticket request failed:", error);
        scheduleReconnect();
      }
    }).finally(() => {
      if (generation === connectGeneration) connectPending = false;
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
    resetAttachLifecycle();
    _takeControlOnAttach = !!(reconnectOpts && reconnectOpts.takeControl);
    if (ws) retireSocket(ws);
    connect();
  }

  return {
    connect,
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
