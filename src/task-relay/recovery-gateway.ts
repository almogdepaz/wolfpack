import type { GatewayOptions } from "./gateway.ts";
import type { RelayGateway, RelayHealth } from "./worker-protocol.ts";
import { join, resolve } from "node:path";
import { resolveWolfpackDir } from "../wolfpack-dir.ts";
import { WorkerRelayGateway, WorkerUnavailable, captureOptions } from "./worker-client.ts";
import { RelayOwnerFailure, RelayRecoveryCooldown } from "./owner-failure.ts";
import {
  HOST_ENVELOPE_ACCEPTANCE,
  relayOwnerFailureResult,
  volatileFailure,
  type VolatileHostEnvelopeRequest,
  type VolatileHostEnvelopeResult,
  type VolatileResult,
} from "./volatile-protocol.ts";

/** Server-owned recovery, never mutation replay. Failed owners terminate before
 * a single-flight half-open replacement; each failed cycle backs off up to 30s. */
export class RecoveryRelayGateway implements RelayGateway {
  readonly root: string;
  readonly profile = "volatile-v1" as const;
  #worker: WorkerRelayGateway | undefined;
  #constructionFailure: WorkerUnavailable | undefined;
  #replacing: Promise<WorkerRelayGateway> | undefined;
  #closed = false;
  readonly #failedOwners = new WeakSet<WorkerRelayGateway>();
  #consecutiveFailures = 0;
  #retryAt = 0;
  #blocked: RelayOwnerFailure | undefined;
  readonly #options: GatewayOptions;
  constructor(options: GatewayOptions) {
    this.#options = captureOptions(options);
    this.root = resolve(this.#options.root ?? join(resolveWolfpackDir(), "task-relay"));
    try { this.#worker = new WorkerRelayGateway({ ...this.#options, root: this.root, storage: "sqlite" }); }
    catch (error) {
      if (!(error instanceof WorkerUnavailable)) throw error;
      this.#constructionFailure = error; this.#backoff();
    }
  }
  health(): RelayHealth {
    if (this.#blocked) return { state: "unavailable", code: this.#blocked.code, retryable: false };
    if (this.#closed) return { state: "unavailable", code: "RELAY_UNAVAILABLE", retryable: false };
    return this.#worker?.health() ?? { state: "unavailable", code: "RELAY_UNAVAILABLE", retryable: true };
  }
  #remaining(): number { return Math.max(0, Math.ceil(this.#retryAt - performance.now())); }
  #backoff(): void {
    this.#consecutiveFailures = Math.min(this.#consecutiveFailures + 1, 6);
    this.#retryAt = performance.now() + Math.min(30_000, 1000 * 2 ** (this.#consecutiveFailures - 1));
  }
  #observe(owner: WorkerRelayGateway): void {
    if (!owner.isClosed || this.#failedOwners.has(owner)) return;
    this.#failedOwners.add(owner);
    if (owner.ownerFailure && !owner.ownerFailure.retryable) this.#blocked = new RelayOwnerFailure(owner.ownerFailure.code);
    else this.#backoff();
  }
  async #owner(): Promise<WorkerRelayGateway> {
    if (this.#closed) throw new Error("relay gateway is closed");
    if (this.#blocked) throw this.#blocked;
    if (this.#replacing) return this.#replacing;
    if (this.#worker && !this.#worker.isClosed) return this.#worker;
    if (this.#worker) this.#observe(this.#worker);
    if (this.#blocked) throw this.#blocked;
    if (this.#remaining()) throw new RelayRecoveryCooldown(this.#remaining());
    const prior = this.#worker;
    this.#replacing = (async () => {
      await prior?.close();
      if ((prior && !prior.terminationConfirmed) || (this.#constructionFailure && !await this.#constructionFailure.termination)) {
        this.#blocked = new RelayOwnerFailure("RELAY_STORAGE_RECOVERY_BLOCKED");
        throw this.#blocked; // The reservation stays held. No takeover, even if termination rejects.
      }
      if (this.#closed) throw new Error("relay gateway closed during recovery");
      let replacement: WorkerRelayGateway | undefined;
      try {
        replacement = new WorkerRelayGateway({ ...this.#options, root: this.root, storage: "sqlite" });
        this.#worker = replacement;
        this.#constructionFailure = undefined;
        await replacement.initialize();
        return replacement;
      } catch (error) {
        if (error instanceof WorkerUnavailable && !replacement) this.#constructionFailure = error;
        if (replacement?.isClosed) this.#observe(replacement);
        else this.#backoff();
        // The worker owner already logged the native cause; callers that log their own diagnostics see a bounded message.
        if (error instanceof WorkerUnavailable && !replacement) throw new WorkerUnavailable("relay worker construction failed", { cause: error }, error.termination);
        throw error;
      }
    })().finally(() => { this.#replacing = undefined; });
    return this.#replacing;
  }
  async #perform<T>(operation: (owner: WorkerRelayGateway) => Promise<T>): Promise<T> {
    const owner = await this.#owner();
    try { return await operation(owner); }
    finally { this.#observe(owner); }
  }
  async #result(operation: (owner: WorkerRelayGateway) => Promise<VolatileResult>): Promise<VolatileResult> {
    try {
      const result = await this.#perform(async owner => {
        const value = await operation(owner);
        if (value.ok && value.value.kind === "connected" && owner === this.#worker && !owner.isClosed) {
          this.#consecutiveFailures = 0; this.#retryAt = 0;
        }
        return value;
      });
      if (result.ok) return result;
      return this.#remaining() && result.error.retryable ? { ...result, error: { ...result.error, retryAfterMs: this.#remaining() } } : result;
    } catch (error) {
      if (error instanceof RelayOwnerFailure) return relayOwnerFailureResult(error.failure, this.profile, error.failure.retryable ? this.#remaining() || undefined : undefined);
      if (error instanceof RelayRecoveryCooldown) return volatileFailure(error.code, undefined, error.retryAfterMs, this.profile);
      if (error instanceof WorkerUnavailable) return volatileFailure("RELAY_UNAVAILABLE", undefined, this.#remaining() || undefined, this.profile);
      throw error;
    }
  }
  initialize() { return this.#perform(owner => owner.initialize()); }
  volatileEpoch() { return this.#perform(owner => owner.volatileEpoch()); }
  registrationsForSessions(ids: readonly string[]) { return this.#perform(owner => owner.registrationsForSessions(ids)); }
  endpointForSession(id: string) { return this.#perform(owner => owner.endpointForSession(id)); }
  endpointsForSessions(ids: readonly string[]) { return this.#perform(owner => owner.endpointsForSessions(ids)); }
  volatile(input: unknown) { return this.#result(owner => owner.volatile(input)); }
  volatilePeer(input: unknown) { return this.#result(owner => owner.volatilePeer(input)); }
  volatileTopology(input: unknown) { return this.#result(owner => owner.volatileTopology(input)); }
  /** The owner reports its own acceptance; a failure to obtain an owner means no worker received the request. */
  async hostEnvelope(input: VolatileHostEnvelopeRequest): Promise<VolatileHostEnvelopeResult> {
    try { return await this.#perform(owner => owner.hostEnvelope(input)); }
    catch (error) {
      const code = error instanceof RelayOwnerFailure || error instanceof RelayRecoveryCooldown ? error.code : "RELAY_UNAVAILABLE";
      return { kind: "failed", code, acceptance: HOST_ENVELOPE_ACCEPTANCE.REJECTED };
    }
  }
  async close() {
    this.#closed = true;
    await this.#replacing?.catch(() => undefined);
    await this.#worker?.close();
    await this.#constructionFailure?.termination;
  }
}
