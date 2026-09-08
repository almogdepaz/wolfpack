import { Worker } from "node:worker_threads";
import { TaskRelayStore } from "./store.ts";
import { getBackend } from "../server/backend.ts";
import { createLogger } from "../log.ts";
import { RELAY_ERROR, relayFailure } from "./domain.ts";
import type { GatewayOptions } from "./gateway.ts";
import {
  RELAY_WORKER_LIMITS as LIMIT, captureRelayWire, RelayWireBudgetError,
  type RelayGateway, type RelayWorkerMethod, type WorkerMessage, type CallbackRequest,
} from "./worker-protocol.ts";

const log = createLogger("task-relay");
const owners = new Set<string>();
class WorkerUnavailable extends Error {}
class InvalidWorkerRequest extends Error {}
type ResultMethod = "connect" | "disconnect" | "resolve" | "send" | "receive" | "acknowledgeDelivery" | "receivePeer" | "resolvePeerEndpoint";
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  bytes: number;
  peer: boolean;
}

/** One server-owned relay worker. This is isolation, not a new security boundary or cache. */
export class WorkerRelayGateway implements RelayGateway {
  readonly root: string;
  readonly #worker: Worker;
  readonly #options: GatewayOptions;
  readonly #requestMs: number;
  readonly #pending = new Map<number, Pending>();
  readonly #callbacks = new Set<number>();
  readonly #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #startupTimer: ReturnType<typeof setTimeout>;
  #closed = false;
  #stopping: Promise<void> | undefined;
  #nextId = 0;
  #regularBytes = 0;
  #peerBytes = 0;

  constructor(options: GatewayOptions & { requestTimeoutMs?: number } = { root: undefined }) {
    this.#requestMs = options.requestTimeoutMs ?? LIMIT.requestMs;
    if (!Number.isInteger(this.#requestMs) || this.#requestMs < 1 || this.#requestMs > LIMIT.requestMs) throw new TypeError("invalid relay worker request timeout");
    if (options.now) throw new TypeError("worker relay uses the process wall clock");
    this.#options = { ...options };
    this.root = new TaskRelayStore(options.root).root;
    if (owners.has(this.root)) throw new Error("relay root already has a worker owner; await close before replacement");
    this.#ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    void this.#ready.catch(() => undefined);
    // .js resolves to .ts in Bun source runs; build.ts embeds this named entry for compiled runs.
    this.#worker = new Worker(new URL("./worker-entry.js", import.meta.url), { workerData: {
      root: this.root, peerOrigin: options.peerOrigin, retryIntervalMs: options.retryIntervalMs,
      retentionMs: options.retentionMs, cleanupIntervalMs: options.cleanupIntervalMs,
      proxyPeerFetch: options.peerFetch !== undefined,
    } });
    owners.add(this.root);
    this.#startupTimer = setTimeout(() => this.#fail("relay worker startup timed out"), LIMIT.startupMs);
    this.#worker.on("message", (message: WorkerMessage) => this.#message(message));
    this.#worker.on("error", () => this.#fail("relay worker failed"));
    this.#worker.on("exit", () => { if (!this.#closed) this.#fail("relay worker exited unexpectedly"); });
    this.#worker.unref();
  }

  #message(message: WorkerMessage): void {
    if (this.#closed) return;
    if (!message || typeof message !== "object") { this.#fail("invalid relay worker message"); return; }
    if (message.kind === "ready") {
      clearTimeout(this.#startupTimer); this.#resolveReady(); return;
    }
    if (message.kind === "inspect" || message.kind === "peer-fetch") {
      if (this.#callbacks.has(message.id) || this.#callbacks.size >= 8) { this.#fail("relay callback budget exceeded"); return; }
      this.#callbacks.add(message.id);
      void this.#callback(message).finally(() => this.#callbacks.delete(message.id));
      return;
    }
    if (message.kind !== "result") { this.#fail("invalid relay worker response"); return; }
    const pending = this.#pending.get(message.id);
    if (!pending) { this.#fail("uncorrelated relay worker response"); return; }
    this.#pending.delete(message.id); clearTimeout(pending.timer);
    if (pending.peer) this.#peerBytes -= pending.bytes; else this.#regularBytes -= pending.bytes;
    if (!this.#pending.size) this.#worker.unref();
    if (message.error) pending.reject(new WorkerUnavailable("relay operation unavailable"));
    else pending.resolve(message.value);
  }

  async #callback(message: CallbackRequest): Promise<void> {
    try {
      let value: unknown;
      if (message.kind === "inspect") {
        if (typeof message.selector !== "string" || message.selector.length > 512) throw new Error("invalid selector");
        const inspect = this.#options.inspectSession ?? (async (selector: string) => {
          const backend = getBackend();
          return backend.inspectSession ? backend.inspectSession(selector) : { ok: false as const, code: "NOT_FOUND" as const };
        });
        value = await inspect(message.selector);
      } else {
        if (!this.#options.peerFetch || typeof message.body !== "string" || Buffer.byteLength(message.body) > LIMIT.requestBytes) throw new Error("unexpected peer callback");
        const response = await this.#options.peerFetch(message.url, {
          method: "POST", headers: { "content-type": "application/json" }, body: message.body,
          redirect: "error", signal: AbortSignal.timeout(5_000),
        });
        value = { status: response.status, body: await response.text() };
      }
      const captured = captureRelayWire(value, LIMIT.responseBytes);
      if (!this.#closed) this.#worker.postMessage({ kind: "callback", id: message.id, value: captured.value });
    } catch {
      if (!this.#closed) {
        try { this.#worker.postMessage({ kind: "callback", id: message.id, error: "relay host callback unavailable" }); }
        catch { this.#fail("relay callback transport failed"); }
      }
    }
  }

  #fail(reason: string): void {
    if (this.#closed) return;
    log.warn(reason, { recovery: "restart server; retry unknown outcomes with the same envelope identity/content" });
    void this.close();
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true; clearTimeout(this.#startupTimer);
      const error = new WorkerUnavailable("relay worker unavailable; an interrupted mutation may have committed");
      this.#rejectReady(error);
      for (const item of this.#pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.#pending.clear(); this.#peerBytes = 0; this.#regularBytes = 0;
      // Never start a replacement before the old worker has actually exited.
      this.#stopping = this.#worker.terminate().then(() => { owners.delete(this.root); }, () => {
        // Keep the ownership reservation if termination cannot be confirmed.
        log.warn("relay worker termination unconfirmed; root remains reserved");
      });
    }
    await this.#stopping;
  }

  #call<M extends RelayWorkerMethod>(method: M, ...input: Parameters<RelayGateway[M]>): Promise<Awaited<ReturnType<RelayGateway[M]>>> {
    if (this.#closed) return Promise.reject(new WorkerUnavailable("relay worker is closed"));
    const peer = method === "receivePeer";
    const count = [...this.#pending.values()].filter(p => p.peer === peer).length;
    if (count >= (peer ? LIMIT.peerRequests : LIMIT.regularRequests)) return Promise.reject(new WorkerUnavailable("relay queue is full"));
    let args: unknown[], bytes: number;
    try {
      const remaining = (peer ? LIMIT.peerBytes : LIMIT.regularBytes) - (peer ? this.#peerBytes : this.#regularBytes);
      const captured = captureRelayWire(input, Math.min(LIMIT.requestBytes, remaining));
      args = captured.value; bytes = captured.bytes;
    } catch (error) {
      return Promise.reject(error instanceof RelayWireBudgetError
        ? new WorkerUnavailable("relay request byte budget exceeded")
        : new InvalidWorkerRequest("relay request is not transferable"));
    }
    const id = this.#nextId++;
    if (peer) this.#peerBytes += bytes; else this.#regularBytes += bytes;
    this.#worker.ref();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail("relay request timed out; worker stopped to bound outstanding work"), this.#requestMs);
      this.#pending.set(id, { resolve: value => resolve(value as Awaited<ReturnType<RelayGateway[M]>>), reject, timer, bytes, peer });
      void this.#ready.then(() => {
        if (!this.#closed) this.#worker.postMessage({ kind: "request", id, method, args });
      }).catch(() => this.#fail("relay worker transport unavailable"));
    });
  }

  async #result<M extends ResultMethod>(method: M, ...args: Parameters<RelayGateway[M]>): Promise<Awaited<ReturnType<RelayGateway[M]>>> {
    try { return await this.#call(method, ...args); }
    catch (error) {
      return relayFailure(error instanceof InvalidWorkerRequest ? RELAY_ERROR.INVALID_REQUEST : RELAY_ERROR.STORE_UNAVAILABLE,
        error instanceof InvalidWorkerRequest ? "invalid relay request" : "relay unavailable; retry unknown outcomes with unchanged envelope identity and content",
        !(error instanceof InvalidWorkerRequest)) as Awaited<ReturnType<RelayGateway[M]>>;
    }
  }

  initialize() { return this.#call("initialize"); }
  peerRelay(...args: Parameters<RelayGateway["peerRelay"]>) { return this.#call("peerRelay", ...args); }
  endpointForSession(...args: Parameters<RelayGateway["endpointForSession"]>) { return this.#call("endpointForSession", ...args); }
  endpointsForSessions(...args: Parameters<RelayGateway["endpointsForSessions"]>) { return this.#call("endpointsForSessions", ...args); }
  flushPeerOutbox(...args: Parameters<RelayGateway["flushPeerOutbox"]>) { return this.#call("flushPeerOutbox", ...args); }
  cleanup(...args: Parameters<RelayGateway["cleanup"]>) { return this.#call("cleanup", ...args); }
  connect(...args: Parameters<RelayGateway["connect"]>) { return this.#result("connect", ...args); }
  disconnect(...args: Parameters<RelayGateway["disconnect"]>) { return this.#result("disconnect", ...args); }
  resolve(...args: Parameters<RelayGateway["resolve"]>) { return this.#result("resolve", ...args); }
  send(...args: Parameters<RelayGateway["send"]>) { return this.#result("send", ...args); }
  receive(...args: Parameters<RelayGateway["receive"]>) { return this.#result("receive", ...args); }
  acknowledgeDelivery(...args: Parameters<RelayGateway["acknowledgeDelivery"]>) { return this.#result("acknowledgeDelivery", ...args); }
  receivePeer(...args: Parameters<RelayGateway["receivePeer"]>) { return this.#result("receivePeer", ...args); }
  resolvePeerEndpoint(...args: Parameters<RelayGateway["resolvePeerEndpoint"]>) { return this.#result("resolvePeerEndpoint", ...args); }
}
