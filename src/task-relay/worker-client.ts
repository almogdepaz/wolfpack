import { Worker } from "node:worker_threads";
import { RelayOwnerFailure, isRelayOwnerFailureData, type RelayOwnerFailureData } from "./owner-failure.ts";
import { assertSupportedBunRuntime } from "../runtime-version.ts";
import { types as utilTypes } from "node:util";
import { join, resolve } from "node:path";
import { createLogger } from "../log.ts";
import { resolveWolfpackDir } from "../wolfpack-dir.ts";
import type { RelayEndpoint } from "./domain.ts";
import type { GatewayOptions } from "./gateway.ts";
import { HOST_ENVELOPE_ACCEPTANCE, volatileFailure, relayOwnerFailureResult, VOLATILE_GATEWAY_LIMITS } from "./volatile-protocol.ts";
import { readPeerResponse, withPeerAbort } from "./peer-response.ts";
import type { VolatileHostEnvelopeRequest, VolatileHostEnvelopeResult, VolatileResult } from "./volatile-protocol.ts";
import {
  RELAY_WORKER_LIMITS as LIMIT, captureRelayWire, RelayWireBudgetError,
  type RelayGateway, type RelayWorkerGateway, type RelayWorkerMethod, type WorkerMessage, type CallbackRequest,
} from "./worker-protocol.ts";

const log = createLogger("task-relay");
const owners = new Map<string, symbol>();
/** Ownership is released only after worker termination is confirmed. */
export function hasRelayWorkerOwners(): boolean { return owners.size > 0; }
type WorkerGatewayOptions = GatewayOptions;
const optionNames = new Set(["profile", "storage", "root", "peerOrigin", "peerFetch", "inspectSession", "requestTimeoutMs"]);

/** Inspect original descriptors before any option read/spread can execute caller code. */
export function captureOptions(input: WorkerGatewayOptions): WorkerGatewayOptions {
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
        if (key === "profile") {
          if (value !== "volatile-v1") throw new TypeError("invalid relay worker profile");
        } else if (key === "storage") {
          if (value !== "memory" && value !== "sqlite") throw new TypeError("invalid relay worker storage");
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
/** Turns true once the worker holds the request: only then can its mutation have committed (review A4-3). */
interface PostTracker { posted: boolean }
class InvalidWorkerRequest extends Error {}
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
  readonly #inspectSession: NonNullable<GatewayOptions["inspectSession"]>;
  readonly #requestMs: number;
  readonly #pending = new Map<number, Pending>();
  readonly #callbacks = new Set<number>();
  readonly #peerControllers = new Set<AbortController>();
  readonly #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #startupTimer: ReturnType<typeof setTimeout>;
  #closed = false;
  #ownerFailure: RelayOwnerFailureData | undefined;
  #stopping: Promise<void> | undefined;
  #terminationConfirmed = false;
  #nextId = 0;
  #regularBytes = 0;
  #peerBytes = 0;
  #epoch: Promise<string | undefined> | undefined;
  get isClosed(): boolean { return this.#closed; }
  get terminationConfirmed(): boolean { return this.#terminationConfirmed; }
  get ownerFailure(): RelayOwnerFailureData | undefined { return this.#ownerFailure; }
  #unavailable(): Error { return this.#ownerFailure ? new RelayOwnerFailure(this.#ownerFailure.code) : new WorkerUnavailable("relay worker unavailable; an interrupted mutation may have committed"); }
  readonly profile = "volatile-v1" as const;
  get storage(): "memory" | "sqlite" { return this.#options.storage ?? "memory"; }

  constructor(suppliedOptions: WorkerGatewayOptions = { root: undefined }) {
    assertSupportedBunRuntime();
    const options = captureOptions(suppliedOptions);
    this.#requestMs = options.requestTimeoutMs ?? LIMIT.requestMs;
    if (!Number.isInteger(this.#requestMs) || this.#requestMs < 1 || this.#requestMs > LIMIT.requestMs) throw new TypeError("invalid relay worker request timeout");
    this.#options = options;
    this.#inspectSession = options.inspectSession ?? (async () => { throw new Error("session inspection unavailable"); });
    this.root = resolve(options.root ?? join(resolveWolfpackDir(), "task-relay"));
    this.#ownedRoot = this.root;
    if (owners.has(this.root)) throw new Error("relay root already has a worker owner; await close before replacement");
    this.#ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    void this.#ready.catch(() => undefined);
    // .js resolves to .ts in Bun source runs; build.ts embeds this named entry for compiled runs.
    const configuration = captureRelayWire({
      root: this.root, peerOrigin: options.peerOrigin, storage: this.storage,
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
    if (message.kind === "owner-failure") {
      if (!isRelayOwnerFailureData(message.failure)) { this.#fail("invalid relay owner failure"); return; }
      this.#ownerFailure = Object.freeze({ ...message.failure });
      this.#fail(`relay owner unavailable: ${message.failure.code}`); return;
    }
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
    if (message.error) {
      if (typeof message.error !== "string") {
        if (!isRelayOwnerFailureData(message.error)) { pending.reject(new WorkerUnavailable("invalid relay owner failure")); this.#fail("invalid relay owner failure"); return; }
        this.#ownerFailure = Object.freeze({ ...message.error });
        pending.reject(this.#unavailable());
        this.#fail(`relay owner failed: ${message.error.code}`); return;
      }
      pending.reject(new WorkerUnavailable("relay operation unavailable"));
      if (this.storage === "sqlite") this.#fail("relay operation failed; fence uncertain worker state before reopening its journal");
    } else pending.resolve(message.value);
  }

  async #callback(message: CallbackRequest): Promise<void> {
    try {
      let value: unknown;
      if (message.kind === "inspect") {
        if (typeof message.selector !== "string" || message.selector.length > 512) throw new Error("invalid selector");
        value = await this.#inspectSession(message.selector);
      } else {
        if (!this.#options.peerFetch || typeof message.body !== "string" || Buffer.byteLength(message.body) > LIMIT.requestBytes) throw new Error("unexpected peer callback");
        const controller = new AbortController();
        this.#peerControllers.add(controller);
        const timer = setTimeout(() => controller.abort(), VOLATILE_GATEWAY_LIMITS.peerMs);
        try {
          value = await withPeerAbort(controller.signal, async () => {
            const response = await this.#options.peerFetch!(message.url, {
              method: "POST", headers: { "content-type": "application/json" }, body: message.body,
              redirect: "error", signal: controller.signal,
            });
            const body = await readPeerResponse(response, controller.signal,
              VOLATILE_GATEWAY_LIMITS.replyBytes);
            return { status: response.status, body };
          });
        } finally {
          clearTimeout(timer); controller.abort(); this.#peerControllers.delete(controller);
        }
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
    log.warn(reason, { recovery: this.storage === "sqlite" ? "replace terminated worker; reopen committed journal; caller retries stable protocol identities" : "explicit rebind after volatile epoch loss" });
    void this.close();
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true; this.#epoch = undefined; clearTimeout(this.#startupTimer);
      for (const controller of this.#peerControllers) controller.abort();
      const error = this.#unavailable();
      this.#rejectReady(error);
      for (const item of this.#pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.#pending.clear(); this.#peerBytes = 0; this.#regularBytes = 0;
      // Never start a replacement before the old worker has actually exited.
      this.#stopping = this.#worker.terminate().then(() => { this.#terminationConfirmed = true; this.#releaseOwner(); }, () => {
        // Keep the ownership reservation if termination cannot be confirmed.
        log.warn("relay worker termination unconfirmed; root remains reserved");
      });
    }
    await this.#stopping;
  }

  #call<M extends RelayWorkerMethod>(method: M, ...input: Parameters<RelayWorkerGateway[M]>): Promise<Awaited<ReturnType<RelayWorkerGateway[M]>>> {
    return this.#request(method, input);
  }
  #request<M extends RelayWorkerMethod>(method: M, input: Parameters<RelayWorkerGateway[M]>, tracker?: PostTracker): Promise<Awaited<ReturnType<RelayWorkerGateway[M]>>> {
    if (this.#closed) return Promise.reject(this.#unavailable());
    const peer = method === "volatilePeer";
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
      const pending: Pending = { resolve: value => resolve(value as Awaited<ReturnType<RelayWorkerGateway[M]>>), reject, timer, bytes, peer };
      this.#pending.set(id, pending);
      void this.#ready.then(() => {
        if (this.#closed) return;
        this.#worker.postMessage({ kind: "request", id, method, args });
        if (tracker) tracker.posted = true;
      }).catch(() => this.#fail("relay worker transport unavailable"));
    });
  }

  async #volatileResult(method: "volatile" | "volatilePeer" | "volatileTopology", input: unknown): Promise<VolatileResult> {
    try { return await this.#call(method, input); }
    catch (error) {
      if (error instanceof RelayOwnerFailure) return relayOwnerFailureResult(error.failure, this.profile);
      return volatileFailure(error instanceof InvalidWorkerRequest ? "INVALID_REQUEST" : this.#closed && this.storage === "memory" ? "RELAY_RESET" : "RELAY_UNAVAILABLE", undefined, undefined, this.profile);
    }
  }
  async volatileEpoch(): Promise<string | undefined> {
    if (this.#closed) throw this.#unavailable();
    if (!this.#epoch) {
      const pending = this.#call("volatileEpoch");
      this.#epoch = pending;
      void pending.catch(() => { if (this.#epoch === pending) this.#epoch = undefined; });
    }
    const epoch = await this.#epoch;
    if (this.#closed) throw this.#unavailable();
    return epoch;
  }
  volatile(input: unknown) { return this.#volatileResult("volatile", input); }
  volatilePeer(input: unknown) { return this.#volatileResult("volatilePeer", input); }
  volatileTopology(input: unknown) { return this.#volatileResult("volatileTopology", input); }
  async hostEnvelope(input: VolatileHostEnvelopeRequest): Promise<VolatileHostEnvelopeResult> {
    const tracker: PostTracker = { posted: false };
    try { return await this.#request("hostEnvelope", [input], tracker); }
    catch (error) {
      // Uncertain when the worker received the request before failing, or when an
      // owner failure says the commit may have happened (SQLite commits after the in-memory accept).
      const ownerFailure = error instanceof RelayOwnerFailure ? error : undefined;
      const uncertain = tracker.posted || ownerFailure?.failure.mayHaveBeenDelivered === true;
      return { kind: "failed",
        code: error instanceof InvalidWorkerRequest ? "INVALID_REQUEST" : ownerFailure ? ownerFailure.code : this.#closed ? "RELAY_RESET" : "RELAY_UNAVAILABLE",
        acceptance: uncertain ? HOST_ENVELOPE_ACCEPTANCE.UNCERTAIN : HOST_ENVELOPE_ACCEPTANCE.REJECTED };
    }
  }
  initialize() { return this.#call("initialize"); }
  registrationsForSessions(...args: Parameters<RelayGateway["registrationsForSessions"]>) { return this.#call("registrationsForSessions", ...args); }
  async endpointForSession(id: string): Promise<RelayEndpoint | undefined> { return (await this.registrationsForSessions([id])).get(id)?.endpoint; }
  async endpointsForSessions(ids: readonly string[]): Promise<ReadonlyMap<string, RelayEndpoint>> {
    return new Map([...await this.registrationsForSessions(ids)].map(([id, registration]) => [id, registration.endpoint]));
  }
}
