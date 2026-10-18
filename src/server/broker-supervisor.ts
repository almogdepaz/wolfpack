/** Owns broker connection startup, handshake, recovery and teardown; no session routing. */
import { existsSync } from "node:fs";
import { createLogger, errMsg } from "../log.js";
import { defaultEventBus, type EventBus } from "../event-bus.js";
import { BrokerClient, defaultBrokerSocketPath } from "../broker/client.js";
import type { EventBody } from "../broker/codec.js";
import {
  BROKER_HELLO_METHOD,
  BROKER_PROTOCOL_VERSION,
  classifyBrokerHello,
  type BrokerVersionInfo,
} from "../broker/hello.js";
import { createBrokerBackend, type BrokerBackend, type BrokerClientApi } from "./broker-backend.js";
import type { SessionBackend } from "./backend-contract.js";

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

export class BrokerSupervisor {
  private broker: BrokerBackend | null;
  private brokerClient: (Pick<BrokerClient, "close" | "isConnected" | "start"> & Pick<BrokerClientApi, "request">) | null;
  private brokerSocketPath: string;
  private _brokerAvailable: boolean;
  /** Recovery-watchdog timer handle; null when not running. */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard — a slow handshake must not stack on top of itself. */
  private watchdogInFlight = false;
  /** From the last successful `hello`; null for a pre-hello broker or no broker. */
  private brokerVersion: BrokerVersionInfo | null = null;

  constructor(private readonly options: { start?: boolean; events?: EventBus } = {}) {
    this.brokerSocketPath = defaultBrokerSocketPath();
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
    let backend: BrokerBackend | null = null;
    const client = new BrokerClient({
      socketPath: this.brokerSocketPath,
      onConnect: () => backend?.handleBrokerConnected(),
      onDisconnect: () => backend?.handleBrokerDisconnected(),
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
    backend = createBrokerBackend(client, events.publishEvent.bind(events));
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
  private startWatchdog(intervalMs: number = BROKER_WATCHDOG_INTERVAL_MS): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      this.watchdogTick().catch((e: unknown) => {
        log.debug("broker watchdog tick failed", { error: errMsg(e) });
      });
    }, intervalMs);
    // Don't keep the event loop alive just for the watchdog; the server's
    // listener is the canonical liveness anchor.
    if (typeof this.watchdogTimer.unref === "function") this.watchdogTimer.unref();
  }

  /** Test-only: drive a single watchdog cycle without waiting for the timer. */
  async _watchdogTickForTest(): Promise<void> {
    if (!process.env.WOLFPACK_TEST) throw new Error("_watchdogTickForTest is test-only");
    await this.watchdogTick();
  }

  /** Test-only: install the watchdog (with optional fast interval). */
  _startWatchdogForTest(intervalMs: number = BROKER_WATCHDOG_INTERVAL_MS): void {
    if (!process.env.WOLFPACK_TEST) throw new Error("_startWatchdogForTest is test-only");
    this.startWatchdog(intervalMs);
  }

  private async watchdogTick(): Promise<void> {
    if (this._brokerAvailable) return;
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
  backend(): BrokerBackend | null { return this.broker; }

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
    const connectDeadline = Date.now() + BROKER_CONNECT_TIMEOUT_MS;
    while (!client.isConnected() && Date.now() < connectDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!client.isConnected()) {
      log.warn("broker handshake: connect timed out", { socketPath: this.brokerSocketPath });
      this.teardownBrokerClient();
      return false;
    }

    try {
      const hello = classifyBrokerHello(await client.request(
        BROKER_HELLO_METHOD,
        {},
        { timeoutMs: BROKER_HANDSHAKE_TIMEOUT_MS },
      ));
      switch (hello.kind) {
        case "compatible":
          this.brokerVersion = { protocolVersion: hello.protocolVersion, brokerVersion: hello.brokerVersion };
          log.info("broker handshake ok", {
            socketPath: this.brokerSocketPath,
            brokerVersion: hello.brokerVersion,
            protocolVersion: hello.protocolVersion,
          });
          return true;
        case "incompatible":
          log.error("broker protocol version is incompatible; restart the broker from this release", {
            socketPath: this.brokerSocketPath,
            brokerVersion: hello.brokerVersion,
            protocolVersion: hello.protocolVersion,
            expectedProtocolVersion: BROKER_PROTOCOL_VERSION,
          });
          this.teardownBrokerClient();
          return false;
        case "error":
          log.warn("broker handshake: hello failed", { error: hello.message });
          this.teardownBrokerClient();
          return false;
        case "pre_hello":
          log.warn("broker predates hello; version unknown", { socketPath: this.brokerSocketPath });
          this.brokerVersion = null;
          break;
      }
      const resp = (await client.request(
        "list_sessions",
        {},
        { timeoutMs: BROKER_HANDSHAKE_TIMEOUT_MS },
      )) as { status?: string; error?: { code?: string; message?: string } };
      if (resp.status !== "ok") {
        log.warn("broker handshake: list_sessions returned error", {
          code: resp.error?.code,
          message: resp.error?.message,
        });
        this.teardownBrokerClient();
        return false;
      }
      log.info("broker handshake ok", { socketPath: this.brokerSocketPath });
      return true;
    } catch (e: unknown) {
      log.warn("broker handshake failed", { error: errMsg(e) });
      this.teardownBrokerClient();
      return false;
    }
  }

  // ── Session counts (for daemon stop warning) ──

  async getSessionCounts(): Promise<{ broker: number }> {
    const sessions = this.broker ? await this.broker.list() : [];
    return { broker: sessions.length };
  }

  /** Test-only: inject a backend in place of the broker so getRouter() works
   *  for routes that drill into broker-specific surfaces. Gated on
   *  WOLFPACK_TEST so production callers can't hot-swap the broker. */
  __setBrokerForTest(backend: SessionBackend & Partial<{ ingestEvent: (e: unknown) => void; onSessionLifecycle: (n: string, cb: (e: unknown) => void) => (() => void) | null }>): void {
    if (!process.env.WOLFPACK_TEST) throw new Error("__setBrokerForTest() is only available in test mode");
    // Cast through unknown — the test backends (MockBackend) implement enough
    // of the BrokerBackend surface for streaming-attach paths via duck typing.
    this.broker = backend as unknown as BrokerBackend;
    this.brokerClient = {
      close() {},
      isConnected: () => true,
      request: async (method: string) => method === BROKER_HELLO_METHOD
        ? { id: 0, status: "ok", payload: { kind: BROKER_HELLO_METHOD, protocol_version: BROKER_PROTOCOL_VERSION, broker_version: "test" } }
        : { id: 0, status: "ok" },
      start() {},
    };
    this._brokerAvailable = true;
  }
}
