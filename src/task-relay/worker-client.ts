import { Worker } from "node:worker_threads";
import { types as utilTypes } from "node:util";
import { TaskRelayStore } from "./store.ts";
import { getBackend } from "../server/backend.ts";
import { createLogger } from "../log.ts";
import { RELAY_ERROR, relayFailure } from "./domain.ts";
import type { GatewayOptions } from "./gateway.ts";
import { volatileFailure } from "./volatile-protocol.ts";
import type { VolatileResult } from "./volatile-protocol.ts";
import {
  RELAY_WORKER_LIMITS as LIMIT, captureRelayWire, RelayWireBudgetError,
  type RelayGateway, type RelayWorkerGateway, type RelayWorkerMethod, type WorkerMessage, type CallbackRequest,
} from "./worker-protocol.ts";

const log = createLogger("task-relay");
const owners = new Map<string, symbol>();
type WorkerGatewayOptions = GatewayOptions & { requestTimeoutMs?: number; profile?: "volatile-v1" };
const optionNames = new Set(["profile", "root", "now", "peerOrigin", "peerFetch", "inspectSession", "retryIntervalMs", "retentionMs", "cleanupIntervalMs", "requestTimeoutMs"]);

/** Inspect original descriptors before any option read/spread can execute caller code. */
function captureOptions(input: WorkerGatewayOptions): WorkerGatewayOptions {
  if (!input || typeof input !== "object" || utilTypes.isProxy(input)) throw new TypeError("invalid relay worker options");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("invalid relay worker options");
  const scalars: Record<string, unknown> = { root: undefined };
  const callbacks: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !optionNames.has(key)) throw new TypeError("unknown relay worker option");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError("relay worker options require enumerable data properties");
    const value: unknown = descriptor.value;
    if (key === "inspectSession" || key === "peerFetch") {
      if (value !== undefined && (typeof value !== "function" || utilTypes.isProxy(value))) throw new TypeError("invalid relay worker callback");
      callbacks[key] = value; // Main-thread callbacks are deliberately not transferred.
    } else {
      if (value !== undefined) {
        if (key === "now") throw new TypeError("worker relay uses the process wall clock");
        if (key === "profile") {
          if (value !== "volatile-v1") throw new TypeError("invalid relay worker profile");
        } else if (key === "root" || key === "peerOrigin") {
          if (typeof value !== "string") throw new TypeError("invalid relay worker string option");
        } else if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("invalid relay worker numeric option");
      }
      scalars[key] = value;
    }
  }
  return Object.freeze(Object.assign(captureRelayWire(scalars, LIMIT.requestBytes).value, callbacks)) as unknown as WorkerGatewayOptions;
}
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
  readonly #ownedRoot: string;
  readonly #owner = Symbol("relay worker owner");
  readonly #worker: Worker;
  readonly #options: WorkerGatewayOptions;
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
  #epoch: Promise<string | undefined> | undefined;
  get profile(): "durable-v2" | "volatile-v1" { return this.#options.profile ?? "durable-v2"; }

  constructor(suppliedOptions: WorkerGatewayOptions = { root: undefined }) {
    const options = captureOptions(suppliedOptions);
    if (options.profile && [options.retryIntervalMs, options.retentionMs, options.cleanupIntervalMs].some(value => value !== undefined)) {
      throw new TypeError("legacy retention/retry options do not apply to volatile relay");
    }
    this.#requestMs = options.requestTimeoutMs ?? LIMIT.requestMs;
    if (!Number.isInteger(this.#requestMs) || this.#requestMs < 1 || this.#requestMs > LIMIT.requestMs) throw new TypeError("invalid relay worker request timeout");
    if (options.now) throw new TypeError("worker relay uses the process wall clock");
    this.#options = options;
    this.root = new TaskRelayStore(options.root).root;
    this.#ownedRoot = this.root;
    if (owners.has(this.root)) throw new Error("relay root already has a worker owner; await close before replacement");
    this.#ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    void this.#ready.catch(() => undefined);
    // .js resolves to .ts in Bun source runs; build.ts embeds this named entry for compiled runs.
    const configuration = captureRelayWire({
      root: this.root, profile: options.profile, peerOrigin: options.peerOrigin, retryIntervalMs: options.retryIntervalMs,
      retentionMs: options.retentionMs, cleanupIntervalMs: options.cleanupIntervalMs,
      proxyPeerFetch: options.peerFetch !== undefined,
    }, LIMIT.requestBytes);
    // Reserve before constructing a worker. Release only this owner's token, and
    // only after termination if construction/setup got far enough to start one.
    owners.set(this.#ownedRoot, this.#owner);
    let worker: Worker | undefined;
    try {
      this.#worker = worker = new Worker(new URL("./worker-entry.js", import.meta.url), { workerData: configuration.value });
      this.#startupTimer = setTimeout(() => this.#fail("relay worker startup timed out"), LIMIT.startupMs);
      this.#worker.on("message", (message: WorkerMessage) => this.#message(message));
      this.#worker.on("error", () => this.#fail("relay worker failed"));
      this.#worker.on("exit", () => { if (!this.#closed) this.#fail("relay worker exited unexpectedly"); });
      this.#worker.unref();
    } catch (error) {
      if (worker) void this.close();
      else this.#releaseOwner();
      throw error;
    }
  }

  #releaseOwner(): void {
    if (owners.get(this.#ownedRoot) === this.#owner) owners.delete(this.#ownedRoot);
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
    log.warn(reason, { recovery: this.#options.profile === "volatile-v1"
      ? "restart server; explicitly rebind volatile endpoints; no automatic replay after epoch loss"
      : "restart server; retry unknown outcomes with the same envelope identity/content" });
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
      this.#stopping = this.#worker.terminate().then(() => { this.#releaseOwner(); }, () => {
        // Keep the ownership reservation if termination cannot be confirmed.
        log.warn("relay worker termination unconfirmed; root remains reserved");
      });
    }
    await this.#stopping;
  }

  #call<M extends RelayWorkerMethod>(method: M, ...input: Parameters<RelayWorkerGateway[M]>): Promise<Awaited<ReturnType<RelayWorkerGateway[M]>>> {
    if (this.#closed) return Promise.reject(new WorkerUnavailable("relay worker is closed"));
    const peer = method === "receivePeer" || method === "volatilePeer";
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
      this.#pending.set(id, { resolve: value => resolve(value as Awaited<ReturnType<RelayWorkerGateway[M]>>), reject, timer, bytes, peer });
      void this.#ready.then(() => {
        if (!this.#closed) this.#worker.postMessage({ kind: "request", id, method, args });
      }).catch(() => this.#fail("relay worker transport unavailable"));
    });
  }

  async #result<M extends ResultMethod>(method: M, ...args: Parameters<RelayWorkerGateway[M]>): Promise<Awaited<ReturnType<RelayGateway[M]>>> {
    // ResultMethod excludes cleanup, the only public/wire signature difference.
    try { return await this.#call(method, ...args) as Awaited<ReturnType<RelayGateway[M]>>; }
    catch (error) {
      return relayFailure(error instanceof InvalidWorkerRequest ? RELAY_ERROR.INVALID_REQUEST : RELAY_ERROR.STORE_UNAVAILABLE,
        error instanceof InvalidWorkerRequest ? "invalid relay request" : "relay unavailable; retry unknown outcomes with unchanged envelope identity and content",
        !(error instanceof InvalidWorkerRequest)) as Awaited<ReturnType<RelayGateway[M]>>;
    }
  }

  async #volatileResult(method: "volatile" | "volatilePeer" | "volatileTopology", input: unknown): Promise<VolatileResult> {
    try { return await this.#call(method, input); }
    catch (error) {
      return volatileFailure(error instanceof InvalidWorkerRequest ? "INVALID_REQUEST" : this.#closed ? "RELAY_RESET" : "RELAY_UNAVAILABLE");
    }
  }
  volatileEpoch(): Promise<string | undefined> {
    if (!this.#epoch) {
      const pending = this.#call("volatileEpoch");
      this.#epoch = pending;
      void pending.catch(() => { if (this.#epoch === pending) this.#epoch = undefined; });
    }
    return this.#epoch;
  }
  volatile(input: unknown) { return this.#volatileResult("volatile", input); }
  volatilePeer(input: unknown) { return this.#volatileResult("volatilePeer", input); }
  volatileTopology(input: unknown) { return this.#volatileResult("volatileTopology", input); }
  initialize() { return this.#call("initialize"); }
  peerRelay(...args: Parameters<RelayGateway["peerRelay"]>) { return this.#call("peerRelay", ...args); }
  endpointForSession(...args: Parameters<RelayGateway["endpointForSession"]>) { return this.#call("endpointForSession", ...args); }
  endpointsForSessions(...args: Parameters<RelayGateway["endpointsForSessions"]>) { return this.#call("endpointsForSessions", ...args); }
  flushPeerOutbox(...args: Parameters<RelayGateway["flushPeerOutbox"]>) { return this.#call("flushPeerOutbox", ...args); }
  async cleanup(before: Date): Promise<number> {
    let beforeMs: number;
    try { beforeMs = Date.prototype.getTime.call(before); } catch { throw new TypeError("relay cleanup cutoff must be a valid date"); }
    if (!Number.isFinite(beforeMs)) throw new TypeError("relay cleanup cutoff must be a valid date");
    return this.#call("cleanup", beforeMs);
  }
  connect(...args: Parameters<RelayGateway["connect"]>) { return this.#result("connect", ...args); }
  disconnect(...args: Parameters<RelayGateway["disconnect"]>) { return this.#result("disconnect", ...args); }
  resolve(...args: Parameters<RelayGateway["resolve"]>) { return this.#result("resolve", ...args); }
  send(...args: Parameters<RelayGateway["send"]>) { return this.#result("send", ...args); }
  receive(...args: Parameters<RelayGateway["receive"]>) { return this.#result("receive", ...args); }
  acknowledgeDelivery(...args: Parameters<RelayGateway["acknowledgeDelivery"]>) { return this.#result("acknowledgeDelivery", ...args); }
  receivePeer(...args: Parameters<RelayGateway["receivePeer"]>) { return this.#result("receivePeer", ...args); }
  resolvePeerEndpoint(...args: Parameters<RelayGateway["resolvePeerEndpoint"]>) { return this.#result("resolvePeerEndpoint", ...args); }
}
