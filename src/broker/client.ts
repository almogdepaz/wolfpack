/**
 * BrokerClient — persistent reconnecting Unix-socket client for the
 * Wolfpack broker daemon.
 *
 * Responsibilities:
 *   - own one persistent connection to the broker socket
 *   - reconnect with exponential backoff when the socket dies
 *   - serialize control_request frames, correlate control_response by id
 *   - demultiplex output_binary frames to per-session subscriber callbacks
 *   - forward event frames to a single global handler
 *   - own the active-subscription set and re-issue `subscribe` RPCs on each
 *     reconnect so output stays flowing across broker hops
 *
 * Reconnect contract:
 *   - in-flight RPCs are rejected with a transport error on disconnect; callers
 *     must retry at the layer that knows whether the request is idempotent.
 *   - per-session output subscribers stay registered across reconnects; the
 *     client re-issues `subscribe` for every session in its active set inside
 *     `handleConnect`, so callers do not need to do it themselves.
 *
 * No SessionBackend coupling — this module is pure transport + RPC plumbing.
 */
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
  encodeFrame,
  Frame,
  FrameParser,
  FRAME_KIND_CONTROL_REQUEST,
  FRAME_KIND_CONTROL_RESPONSE,
  FRAME_KIND_EVENT,
  FRAME_KIND_INPUT_BINARY,
  FRAME_KIND_OUTPUT_BINARY,
  type ControlRequest,
  type ControlResponse,
  type EventBody,
  type OutputBinaryFrame,
} from "./codec.js";

export type OutputSubscriber = (frame: OutputBinaryFrame) => void;
export type EventSubscriber = (event: EventBody) => void;

export interface BrokerClientOptions {
  /** Absolute path to broker Unix socket. Defaults to `defaultBrokerSocketPath()`. */
  socketPath?: string;
  /** Initial reconnect backoff in ms (default 100ms). */
  reconnectInitialDelayMs?: number;
  /** Reconnect backoff cap in ms (default 5000ms). */
  reconnectMaxDelayMs?: number;
  /** Default per-request timeout in ms (default 10000ms). */
  requestTimeoutMs?: number;
  /** Called every time a connection is established (initial + each reconnect). */
  onConnect?: () => void;
  /** Called when an established connection dies. */
  onDisconnect?: (err?: Error) => void;
  /** Called when the parser/socket hits a fatal protocol error. */
  onProtocolError?: (err: Error) => void;
  /** Global event handler (session_started, session_exited, etc.). */
  onEvent?: EventSubscriber;
  /**
   * Called when an automatic re-`subscribe` issued during reconnect fails.
   * If unset, failures are silently swallowed — caller-driven subscribe()
   * still propagates errors normally.
   */
  onResubscribeError?: (sessionId: string, err: Error) => void;
  /**
   * Called when the broker sends a `subscription_dropped` event because this
   * connection's forwarder fell too far behind the broadcast channel. The
   * client auto-reissues `subscribe` (live from current position) before
   * calling this, so output resumes. Callers that need a visual re-sync
   * (e.g. snapshot → clear → replay) should trigger it here.
   */
  onSubscriptionDropped?: (sessionId: string, lagged: number) => void;
  /**
   * Called when a `subscribe` response carries `replay_truncated: true`,
   * meaning the ring evicted chunks between `sinceSeq` and the earliest
   * retained entry. Callers should re-snapshot to fill the gap before
   * consuming the live stream.
   */
  onReplayTruncated?: (sessionId: string) => void;
}

interface PendingRpc {
  resolve: (resp: ControlResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  method: string;
}

export function defaultBrokerSocketPath(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && xdg.length > 0) {
    return path.join(xdg, "wolfpack-broker.sock");
  }
  return path.join(os.homedir(), ".wolfpack", "broker.sock");
}

export class BrokerNotConnectedError extends Error {
  constructor(message = "broker not connected") {
    super(message);
    this.name = "BrokerNotConnectedError";
  }
}

export class BrokerRequestTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`broker request '${method}' timed out after ${ms}ms`);
    this.name = "BrokerRequestTimeoutError";
  }
}

export class BrokerClient {
  private readonly socketPath: string;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly onConnectCb?: () => void;
  private readonly onDisconnectCb?: (err?: Error) => void;
  private readonly onProtocolErrorCb?: (err: Error) => void;
  private readonly onEventCb?: EventSubscriber;
  private readonly onResubscribeErrorCb?: (sessionId: string, err: Error) => void;
  private readonly onSubscriptionDroppedCb?: (sessionId: string, lagged: number) => void;
  private readonly onReplayTruncatedCb?: (sessionId: string) => void;

  private socket: net.Socket | null = null;
  private parser = new FrameParser();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentReconnectDelay = 0;

  private nextId = 1;
  private readonly pending = new Map<number, PendingRpc>();
  private readonly outputSubs = new Map<string, Set<OutputSubscriber>>();
  /** Sessions the caller has asked us to subscribe to. Re-issued on reconnect. */
  private readonly activeSubscriptions = new Set<string>();

  private state: "idle" | "connecting" | "connected" | "closed" = "idle";

  constructor(opts: BrokerClientOptions = {}) {
    this.socketPath = opts.socketPath ?? defaultBrokerSocketPath();
    this.reconnectInitialDelayMs = opts.reconnectInitialDelayMs ?? 100;
    this.reconnectMaxDelayMs = opts.reconnectMaxDelayMs ?? 5000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.onConnectCb = opts.onConnect;
    this.onDisconnectCb = opts.onDisconnect;
    this.onProtocolErrorCb = opts.onProtocolError;
    this.onEventCb = opts.onEvent;
    this.onResubscribeErrorCb = opts.onResubscribeError;
    this.onSubscriptionDroppedCb = opts.onSubscriptionDropped;
    this.onReplayTruncatedCb = opts.onReplayTruncated;
  }

  /** Begin connecting. Idempotent if already connecting/connected. */
  start(): void {
    if (this.state === "closed") {
      throw new Error("BrokerClient.start: client has been closed");
    }
    this.connect();
  }

  /** Permanent shutdown. After this, `start()` throws. */
  close(): void {
    this.state = "closed";
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPending(new BrokerNotConnectedError("broker client closed"));
    this.activeSubscriptions.clear();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  /** Issue a control_request and resolve when its matching response arrives. */
  request(
    method: string,
    params: unknown = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<ControlResponse> {
    if (this.state === "closed") {
      return Promise.reject(new BrokerNotConnectedError("broker client closed"));
    }
    if (!this.socket || this.state !== "connected") {
      return Promise.reject(new BrokerNotConnectedError());
    }
    const id = this.nextId++;
    const req: ControlRequest = { id, method, params };
    const frame = encodeFrame({ kind: FRAME_KIND_CONTROL_REQUEST, value: req });
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;

    return new Promise<ControlResponse>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              const p = this.pending.get(id);
              if (!p) return;
              this.pending.delete(id);
              p.reject(new BrokerRequestTimeoutError(method, timeoutMs));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket!.write(frame, (writeErr) => {
        if (!writeErr) return;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        p.reject(writeErr);
      });
    });
  }

  /** Send an input_binary frame for the given session. */
  writeInput(sessionId: string, data: Uint8Array): void {
    if (!this.socket || this.state !== "connected") {
      throw new BrokerNotConnectedError();
    }
    const frame = encodeFrame({
      kind: FRAME_KIND_INPUT_BINARY,
      value: { sessionId, data },
    });
    this.socket.write(frame);
  }

  /**
   * Register a per-session output subscriber. Returns an unsubscribe fn.
   * Multiple subscribers per session are supported; each is called for every
   * frame routed to that session_id.
   */
  subscribeOutput(sessionId: string, cb: OutputSubscriber): () => void {
    let set = this.outputSubs.get(sessionId);
    if (!set) {
      set = new Set();
      this.outputSubs.set(sessionId, set);
    }
    set.add(cb);
    return () => {
      const s = this.outputSubs.get(sessionId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.outputSubs.delete(sessionId);
    };
  }

  /** Number of distinct sessions with at least one output subscriber. */
  outputSubscriptionCount(): number {
    return this.outputSubs.size;
  }

  /**
   * Issue a `subscribe` control RPC and remember it as active. Idempotent: if
   * the session is already in the active set, returns the cached response
   * promise without re-asking the broker. The active set is what
   * `handleConnect` re-issues on every reconnect, so callers can call this
   * once per session and trust that output keeps flowing across broker hops.
   *
   * `sinceSeq` matches the protocol field — pass it to ask for a replay from
   * the broker's cache after the given seq before it catches up to live.
   */
  async subscribe(
    sessionId: string,
    opts: { sinceSeq?: bigint; timeoutMs?: number } = {},
  ): Promise<ControlResponse> {
    if (this.state === "closed") {
      throw new BrokerNotConnectedError("broker client closed");
    }
    this.activeSubscriptions.add(sessionId);
    if (this.state !== "connected") {
      // Caller asked for a subscribe while offline; the request will be
      // re-issued automatically on the next handleConnect. Surface the
      // not-connected error for tight call-paths that expect ack now.
      throw new BrokerNotConnectedError();
    }
    return this.issueSubscribe(sessionId, opts);
  }

  /**
   * Issue an `unsubscribe` RPC and drop the session from the active set so
   * subsequent reconnects don't re-attach to it. Safe to call even if the
   * session was never subscribed; in that case it just no-ops.
   */
  async unsubscribe(
    sessionId: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<void> {
    const wasActive = this.activeSubscriptions.delete(sessionId);
    if (this.state === "closed") return;
    if (!wasActive) return;
    if (this.state !== "connected") return;
    await this.request("unsubscribe", { session_id: sessionId }, opts);
  }

  /** True iff this session is in the active-subscriptions set. */
  isSubscribed(sessionId: string): boolean {
    return this.activeSubscriptions.has(sessionId);
  }

  /** Number of sessions currently in the active-subscriptions set. */
  activeSubscriptionCount(): number {
    return this.activeSubscriptions.size;
  }

  // ── Internals ──

  private connect(): void {
    if (this.state === "closed") return;
    if (this.state === "connecting" || this.state === "connected") return;
    if (this.socket) return;
    this.state = "connecting";
    this.parser = new FrameParser();
    const sock = net.createConnection(this.socketPath);
    this.socket = sock;
    sock.on("connect", () => this.handleConnect());
    sock.on("data", (chunk: Buffer) => this.handleData(chunk));
    sock.on("error", () => {
      // Surface via 'close' below — keeps teardown single-pathed.
    });
    sock.on("close", () => this.handleClose());
  }

  private handleConnect(): void {
    if (this.state !== "connecting") return;
    this.state = "connected";
    this.currentReconnectDelay = 0;
    try {
      this.onConnectCb?.();
    } catch (e) {
      this.reportProtocolError(toError(e));
    }
    // Re-issue subscribe RPCs for every session in the active set. Snapshot
    // first so a callback that mutates the set during this loop (e.g. via
    // unsubscribe) doesn't trip the iterator. Errors are surfaced through
    // onResubscribeError but never thrown — the connection stays up.
    if (this.activeSubscriptions.size > 0) {
      const ids = Array.from(this.activeSubscriptions);
      for (const sessionId of ids) {
        this.issueSubscribe(sessionId, {}).catch((err) => {
          if (this.onResubscribeErrorCb) {
            try {
              this.onResubscribeErrorCb(sessionId, toError(err));
            } catch {
              // swallow — resubscribe-error callbacks must not crash transport
            }
          }
        });
      }
    }
  }

  private issueSubscribe(
    sessionId: string,
    opts: { sinceSeq?: bigint; timeoutMs?: number },
  ): Promise<ControlResponse> {
    const params: Record<string, unknown> = { session_id: sessionId };
    if (opts.sinceSeq !== undefined) {
      // Protocol field is JSON number (broker expects u64). Guard against
      // bigint→Number precision loss past MAX_SAFE_INTEGER.
      const maxSafeSeq = BigInt(Number.MAX_SAFE_INTEGER);
      if (opts.sinceSeq > maxSafeSeq) {
        process.emitWarning(
          `[broker-client] sinceSeq=${opts.sinceSeq} exceeds Number.MAX_SAFE_INTEGER; clamping subscribe.since_seq to ${Number.MAX_SAFE_INTEGER}`,
        );
        params.since_seq = Number.MAX_SAFE_INTEGER;
      } else {
        params.since_seq = Number(opts.sinceSeq);
      }
    }
    return this.request("subscribe", params, { timeoutMs: opts.timeoutMs }).then((resp) => {
      if (
        resp.status === "ok" &&
        (resp.payload as Record<string, unknown> | undefined)?.replay_truncated === true &&
        this.onReplayTruncatedCb
      ) {
        try { this.onReplayTruncatedCb(sessionId); } catch { /* swallow */ }
      }
      return resp;
    });
  }

  private handleData(chunk: Buffer): void {
    try {
      // Detach from Node's possibly-pooled internal buffer so retained
      // slices in decoded frames stay valid past the next 'data' event.
      const detached = new Uint8Array(chunk.length);
      detached.set(chunk);
      this.parser.push(detached);
      const frames = this.parser.drain();
      for (const f of frames) this.dispatch(f);
    } catch (e) {
      const err = toError(e);
      this.reportProtocolError(err);
      if (this.socket) this.socket.destroy(err);
    }
  }

  private handleClose(): void {
    const wasConnected = this.state === "connected";
    if (this.state !== "closed") this.state = "idle";
    this.socket = null;
    this.failPending(new BrokerNotConnectedError("broker disconnected"));
    if (wasConnected) {
      try {
        this.onDisconnectCb?.();
      } catch {
        // swallow — disconnect callback errors must not crash teardown
      }
    }
    if (this.state !== "closed") this.scheduleReconnect();
  }

  private dispatch(frame: Frame): void {
    switch (frame.kind) {
      case FRAME_KIND_CONTROL_RESPONSE: {
        const id = frame.value.id;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        p.resolve(frame.value);
        return;
      }
      case FRAME_KIND_OUTPUT_BINARY: {
        const subs = this.outputSubs.get(frame.value.sessionId);
        if (!subs) return;
        for (const cb of subs) {
          try {
            cb(frame.value);
          } catch {
            // subscriber errors are isolated; transport stays up
          }
        }
        return;
      }
      case FRAME_KIND_EVENT: {
        const ev = frame.value;
        // subscription_dropped is a per-connection signal (not a global event):
        // auto-resubscribe to get live output flowing again, then notify the caller.
        if (ev.event === "subscription_dropped" && typeof ev.session_id === "string") {
          const sessionId = ev.session_id as string;
          const lagged = typeof ev.lagged === "number" ? ev.lagged as number : 0;
          if (this.activeSubscriptions.has(sessionId) && this.state === "connected") {
            this.issueSubscribe(sessionId, {}).catch((err) => {
              if (this.onResubscribeErrorCb) {
                try { this.onResubscribeErrorCb(sessionId, toError(err)); } catch { /* swallow */ }
              }
            });
          }
          if (this.onSubscriptionDroppedCb) {
            try { this.onSubscriptionDroppedCb(sessionId, lagged); } catch { /* swallow */ }
          }
          return;
        }
        if (!this.onEventCb) return;
        try {
          this.onEventCb(ev);
        } catch {
          // swallow
        }
        return;
      }
      case FRAME_KIND_CONTROL_REQUEST:
      case FRAME_KIND_INPUT_BINARY: {
        // Spec: these flow client→broker only. Receiving them here is a
        // protocol violation — drop the connection and let reconnect retry.
        const err = new Error(
          `unexpected frame kind from broker: 0x${frame.kind.toString(16)}`,
        );
        this.reportProtocolError(err);
        if (this.socket) this.socket.destroy(err);
        return;
      }
    }
  }

  private failPending(err: Error): void {
    if (this.pending.size === 0) return;
    const snapshot = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of snapshot) {
      if (p.timer) clearTimeout(p.timer);
      try {
        p.reject(err);
      } catch {
        // swallow
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.state === "closed") return;
    if (this.reconnectTimer) return;
    const next =
      this.currentReconnectDelay === 0
        ? this.reconnectInitialDelayMs
        : Math.min(this.currentReconnectDelay * 2, this.reconnectMaxDelayMs);
    this.currentReconnectDelay = next;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, next);
  }

  private reportProtocolError(err: Error): void {
    if (!this.onProtocolErrorCb) return;
    try {
      this.onProtocolErrorCb(err);
    } catch {
      // swallow
    }
  }
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
