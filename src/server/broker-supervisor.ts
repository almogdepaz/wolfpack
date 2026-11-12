/** Owns broker connection startup, handshake, recovery and teardown; no session routing. */
import { existsSync } from "node:fs";
import { createLogger, errMsg } from "../log.js";
import { defaultEventBus, type EventBus } from "../event-bus.js";
import { BrokerClient, defaultBrokerSocketPath, type BrokerConnectionRequest, type BrokerClientOptions } from "../broker/client.js";
import type { EventBody } from "../broker/codec.js";
import {
  BROKER_HELLO_METHOD,
  BROKER_PROTOCOL_VERSION,
  classifyBrokerHello,
  type BrokerVersionInfo,
} from "../broker/hello.js";
import { createBrokerBackend, type BrokerBackend, type BrokerBackendOptions, type BrokerClientApi } from "./broker-backend.js";
import { SessionIdentityStore } from "./session-identity.js";
import { createChildEvents } from "./child-events.js";
import { createSessionDeath } from "./session-death.js";
import { createViewerInput } from "./viewer-input.js";
import type { SessionBackend, PtyBackendMethods, SessionPromptBackendMethods } from "./backend-contract.js";

const log = createLogger("backend");

const BROKER_HANDSHAKE_TIMEOUT_MS = 1000;
const BROKER_CONNECT_TIMEOUT_MS = 1500;
/** How often the recovery watchdog re-probes a broker that previously failed.
 *  5s is short enough to recover well within a session-start attempt timeout
 *  and long enough to avoid hot-looping when the broker is genuinely dead. */
const BROKER_WATCHDOG_INTERVAL_MS = 5000;

// ── Backend Router ──

/** Sync probe: does the broker socket file exist? Cheap; never opens it. */
export function checkBrokerSocketExists(socketPath: string = defaultBrokerSocketPath()): boolean {
  try {
    return existsSync(socketPath);
  } catch {
    return false;
  }
}

type SupervisedBroker = SessionBackend & PtyBackendMethods & SessionPromptBackendMethods & Pick<BrokerBackend,
  "ingestEvent" | "handleBrokerConnected" | "handleBrokerDisconnected" | "handleReplayTruncated" | "handleResubscribeError">;
type SupervisorClient = BrokerClientApi & Pick<BrokerClient, "close" | "isConnected" | "start">;

export interface BrokerSupervisorOptions extends Pick<BrokerBackendOptions, "childEvents" | "sessionDeath" | "viewerInput" | "claudeManagedSettingsDropIn"> {
  readonly start?: boolean;
  readonly events?: EventBus;
  readonly sessionIdentityStore?: () => SessionIdentityStore;
  readonly socketPath?: string;
  readonly createClient?: (options: BrokerClientOptions) => SupervisorClient;
  readonly createBackend?: (...args: Parameters<typeof createBrokerBackend>) => SupervisedBroker;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly scheduleWatchdog?: (tick: () => Promise<void>, intervalMs: number) => () => void;
}

export class BrokerSupervisor {
  private broker: SupervisedBroker | null;
  private brokerClient: (Pick<BrokerClient, "close" | "isConnected" | "start"> & Pick<BrokerClientApi, "request">) | null;
  private brokerSocketPath: string;
  private _brokerAvailable: boolean;
  /** Recovery-watchdog timer handle; null when not running. */
  private stopWatchdog: (() => void) | null = null;
  /** Re-entrancy guard — a slow handshake must not stack on top of itself. */
  private watchdogInFlight = false;
  /** From the last successful `hello`; null for a pre-hello broker or no broker. */
  private brokerVersion: BrokerVersionInfo | null = null;
  private connectionGeneration = 0;
  private readonly readyListeners = new Set<() => void>();
  onReady(listener: () => void): () => void { this.readyListeners.add(listener); return () => { this.readyListeners.delete(listener); }; }

  private identityStore?: SessionIdentityStore;
  private closed = false;
  readonly childEvents: ReturnType<typeof createChildEvents>;
  readonly sessionDeath: ReturnType<typeof createSessionDeath>;
  readonly viewerInput: ReturnType<typeof createViewerInput>;

  constructor(private readonly options: BrokerSupervisorOptions = {}) {
    this.childEvents = options.childEvents ?? createChildEvents();
    this.sessionDeath = options.sessionDeath ?? createSessionDeath();
    this.viewerInput = options.viewerInput ?? createViewerInput();
    this.brokerSocketPath = options.socketPath ?? defaultBrokerSocketPath();
    this.broker = null;
    this.brokerClient = null;
    this._brokerAvailable = false;
    if (options.start === false) return;

    if (!checkBrokerSocketExists(this.brokerSocketPath)) {
      throw new Error(`broker socket missing at ${this.brokerSocketPath}; the broker daemon must be running`);
    }
    this.startBrokerClient();
    this._brokerAvailable = true;
    // Watchdog runs for the lifetime of the router so we recover from a
    // mid-life broker wedge (verifyBrokerHandshake tears the client down,
    // and the next tick brings it back).
    this.startWatchdog();
  }

  private startBrokerClient(): void {
    // Bound to this client's backend, not `this.broker`: a watchdog teardown
    // nulls `this.broker` before the old socket's disconnect callback fires.
    let backend: SupervisedBroker | null = null;
    let negotiatedVersion: BrokerVersionInfo | null = null;
    const client = (this.options.createClient ?? (options => new BrokerClient(options)))({
      socketPath: this.brokerSocketPath,
      verifyConnection: async (request) => {
        const generation = ++this.connectionGeneration;
        const version = await this.negotiateHandshake(request);
        if (this.brokerClient !== client || generation !== this.connectionGeneration) {
          throw new Error("broker handshake generation expired");
        }
        negotiatedVersion = version;
      },
      onConnect: () => {
        if (this.brokerClient !== client) return;
        this.brokerVersion = negotiatedVersion;
        this._brokerAvailable = true;
        backend?.handleBrokerConnected();
        for (const listener of this.readyListeners) listener();
      },
      onDisconnect: () => {
        if (this.brokerClient === client) {
          this.connectionGeneration++;
          negotiatedVersion = null;
          this.brokerVersion = null;
          this._brokerAvailable = false;
        }
        backend?.handleBrokerDisconnected();
      },
      onProtocolError: (error) => {
        log.warn("broker connection verification/protocol error", { error: errMsg(error), socketPath: this.brokerSocketPath });
      },
      onEvent: (event: EventBody) => {
        this.broker?.ingestEvent(event);
      },
      // When the broker rings a session out (overrun during a lag window
      // and replay would skip bytes), fan it out to that session's
      // lifecycle subscribers as a `replay_truncated` event. The WS layer
      // turns it into a 1011 close so the client reconnects with a fresh
      // snapshot — closing the stale-prefill gap.
      onReplayTruncated: (sessionId: string) => {
        this.broker?.handleReplayTruncated(sessionId);
      },
      onResubscribeError: (sessionId: string, error: Error) => {
        this.broker?.handleResubscribeError(sessionId, error);
      },
      // Surface circuit-breaker trips at warn level so a zombie-broker
      // recovery is visible in the server log. The breaker has already
      // destroyed the socket by the time this fires; reconnect is queued.
      onCircuitBreak: (consecutive: number) => {
        log.warn("broker circuit breaker tripped; forcing reconnect", {
          consecutiveTimeouts: consecutive,
          socketPath: this.brokerSocketPath,
        });
      },
    });
    const events = this.options.events ?? defaultEventBus;
    backend = (this.options.createBackend ?? createBrokerBackend)(client, events.publishEvent.bind(events), {
      childEvents: this.childEvents,
      claudeManagedSettingsDropIn: this.options.claudeManagedSettingsDropIn,
      sessionDeath: this.sessionDeath,
      viewerInput: this.viewerInput,
      sessionIdentityStore: this.options.sessionIdentityStore ?? (() => this.identityStore ??= new SessionIdentityStore()),
    });
    client.start();
    this.brokerClient = client;
    this.broker = backend;
  }

  /**
   * Periodically re-probe the broker when it is marked unavailable so the
   * server self-heals after the daemon comes back. Without this, a wedge
   * that flips `_brokerAvailable` to false at startup or after a circuit-
   * breaker trip keeps the server returning "broker backend unavailable"
   * until the next manual restart — the 8-hour zombie state observed
   * 2026-05-11. See issue #141 for the wedge-itself investigation.
   */
  private startWatchdog(): void {
    if (this.stopWatchdog) return;
    const tick = () => this.watchdogTick().catch((e: unknown) => {
      log.debug("broker watchdog tick failed", { error: errMsg(e) });
    });
    if (this.options.scheduleWatchdog) {
      this.stopWatchdog = this.options.scheduleWatchdog(tick, BROKER_WATCHDOG_INTERVAL_MS);
    } else {
      const timer = setInterval(() => { void tick(); }, BROKER_WATCHDOG_INTERVAL_MS);
      timer.unref?.();
      this.stopWatchdog = () => clearInterval(timer);
    }
  }

  close(): void {
    this.closed = true;
    this.stopWatchdog?.();
    this.stopWatchdog = null;
    this.teardownBrokerClient();
  }

  private async watchdogTick(): Promise<void> {
    if (this.closed || this._brokerAvailable) return;
    if (this.watchdogInFlight) return;
    if (!checkBrokerSocketExists(this.brokerSocketPath)) return;
    this.watchdogInFlight = true;
    try {
      // recheckBroker starts the client if the socket appeared. If the
      // socket was already present (the wedge case: file exists, daemon
      // unresponsive) but `_brokerAvailable` is false because a previous
      // handshake tore the client down, we need to restart the client
      // ourselves so verifyBrokerHandshake has something to probe.
      if (!this.brokerClient) {
        try {
          this.startBrokerClient();
        } catch (e: unknown) {
          log.debug("broker watchdog: client start failed", { error: errMsg(e) });
          this.teardownBrokerClient();
          return;
        }
      }
      const ok = await this.verifyBrokerHandshake();
      if (ok) {
        this._brokerAvailable = true;
        log.info("broker recovered", { socketPath: this.brokerSocketPath });
      }
    } finally {
      this.watchdogInFlight = false;
    }
  }

  private teardownBrokerClient(): void {
    this.connectionGeneration++;
    if (this.brokerClient) {
      try { this.brokerClient.close(); } catch (e: unknown) {
        log.debug("broker client close failed", { error: errMsg(e) });
      }
    }
    this.brokerClient = null;
    this.broker = null;
    this._brokerAvailable = false;
    this.brokerVersion = null;
  }

  /** Current broker instance; consumers pin it for the lifetime of an attach. */
  backend(): SupervisedBroker | null { return this.broker; }

  isBrokerAvailable(): boolean { return this._brokerAvailable; }
  isBrokerReady(): boolean {
    return this._brokerAvailable && this.brokerClient?.isConnected() === true;
  }
  getBrokerSocketPath(): string { return this.brokerSocketPath; }
  getBrokerVersion(): BrokerVersionInfo | null { return this.brokerVersion; }

  /** Re-probe the broker socket. Starts the client if it appeared.
   *  Disappearance is a fatal condition for the broker session pool —
   *  next operation will surface a 4001 to the client. */
  recheckBroker(): boolean {
    if (this.closed) return false;
    const exists = checkBrokerSocketExists(this.brokerSocketPath);
    if (exists && !this.broker) {
      try {
        this.startBrokerClient();
        this._brokerAvailable = true;
        log.info("broker backend initialized (socket appeared)");
      } catch (e: unknown) {
        log.warn("broker client start failed during recheck", { error: errMsg(e) });
        this.teardownBrokerClient();
      }
    } else if (!exists && this.broker) {
      log.error("broker socket disappeared", { socketPath: this.brokerSocketPath });
      this.teardownBrokerClient();
    }
    return this._brokerAvailable;
  }

  /**
   * Async handshake probe: waits for the broker connection to come up, then
   * issues `hello` with a tight timeout (`list_sessions` for a broker that
   * predates `hello`). A broker speaking another protocol version, or any
   * failure, tears the client down. Returns whether the handshake succeeded.
   */
  async verifyBrokerHandshake(): Promise<boolean> {
    if (!this.brokerClient) return false;
    const client = this.brokerClient;

    // Wait for socket connect or short timeout. BrokerClient.start() returns
    // immediately; the connect event fires asynchronously.
    const now = this.options.now ?? Date.now;
    const connectDeadline = now() + BROKER_CONNECT_TIMEOUT_MS;
    while (!client.isConnected() && now() < connectDeadline) {
      await (this.options.sleep?.(25) ?? new Promise((r) => setTimeout(r, 25)));
    }
    if (!client.isConnected()) {
      if (this.brokerClient === client) {
        log.warn("broker handshake: connect timed out", { socketPath: this.brokerSocketPath });
        this.teardownBrokerClient();
      }
      return false;
    }

    const generation = this.connectionGeneration;
    const current = () => this.brokerClient === client && generation === this.connectionGeneration && client.isConnected();
    try {
      const version = await this.negotiateHandshake(client.request.bind(client));
      if (!current()) return false;
      this.brokerVersion = version;
      this._brokerAvailable = true;
      return true;
    } catch (e: unknown) {
      if (current()) {
        log.warn("broker handshake failed", { error: errMsg(e) });
        this.teardownBrokerClient();
      }
      return false;
    }
  }

  /** Stateless negotiation shared by startup probes and every reconnect. */
  private async negotiateHandshake(request: BrokerConnectionRequest): Promise<BrokerVersionInfo | null> {
    const hello = classifyBrokerHello(await request(
      BROKER_HELLO_METHOD,
      {},
      { timeoutMs: BROKER_HANDSHAKE_TIMEOUT_MS },
    ));
    switch (hello.kind) {
      case "compatible":
        log.info("broker handshake ok", {
          socketPath: this.brokerSocketPath,
          brokerVersion: hello.brokerVersion,
          protocolVersion: hello.protocolVersion,
        });
        return { protocolVersion: hello.protocolVersion, brokerVersion: hello.brokerVersion };
      case "incompatible":
        log.error("broker protocol version is incompatible; restart the broker from this release", {
          socketPath: this.brokerSocketPath,
          brokerVersion: hello.brokerVersion,
          protocolVersion: hello.protocolVersion,
          expectedProtocolVersion: BROKER_PROTOCOL_VERSION,
        });
        throw new Error(`incompatible broker protocol ${hello.protocolVersion}`);
      case "error":
        log.warn("broker handshake: hello failed", { error: hello.message });
        throw new Error(hello.message);
      case "pre_hello":
        log.warn("broker predates hello; version unknown", { socketPath: this.brokerSocketPath });
        break;
    }
    const resp = (await request(
      "list_sessions",
      {},
      { timeoutMs: BROKER_HANDSHAKE_TIMEOUT_MS },
    )) as { status?: string; error?: { code?: string; message?: string } };
    if (resp.status !== "ok") {
      log.warn("broker handshake: list_sessions returned error", {
        code: resp.error?.code,
        message: resp.error?.message,
      });
      throw new Error("broker handshake list_sessions failed");
    }
    log.info("broker handshake ok", { socketPath: this.brokerSocketPath });
    return null;
  }

  // ── Session counts (for daemon stop warning) ──

  async getSessionCounts(): Promise<{ broker: number }> {
    const sessions = this.broker ? await this.broker.list() : [];
    return { broker: sessions.length };
  }

}
