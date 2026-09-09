import { join } from "node:path";
import type { SessionInspectionResult } from "../session-status-contract.ts";
import { canonicalTailnetOrigin } from "../tailnet-machine-contract.ts";
import { createLogger } from "../log.ts";
import { RELAY_ID, RELAY_LIMITS, RELAY_PROTOCOL_VERSION, isLocalRelay, isOpaqueRelayId, isRelayEndpoint, isRelayEnvelope } from "./domain.ts";
import type { RelayEnvelope, RelayRegistration } from "./domain.ts";
import { MEMORY_RELAY_LIMITS, MEMORY_RELAY_PROFILE, MemoryRelayError, MemoryRelayStore } from "./memory-store.ts";
import type { ForwardAttempt } from "./memory-store.ts";
import { BoundedRelayInvestigation, RotatingRelayInvestigationWriter } from "./investigation.ts";
import { captureRelayWire } from "./worker-protocol.ts";
import { VOLATILE_GATEWAY_LIMITS as LIMIT, VOLATILE_PEER_PATH, volatileFailure } from "./volatile-protocol.ts";
import type { VolatileBinding, VolatileCode, VolatilePeerRequest, VolatileRequest, VolatileResult, VolatileValue, VolatileTopologyRequest } from "./volatile-protocol.ts";

const log = createLogger("task-relay");
const fields: Readonly<Record<string, readonly string[]>> = {
  connect: ["callerSession", "generation", "protocolVersions", "leaseMs", "epoch"],
  resolvePeer: ["origin", "peerEpoch", "target"], resolve: ["target"], send: ["envelope"],
  receive: ["cursor", "limit"], acknowledge: ["envelopeId"], disconnect: [], health: [],
  receivePeer: ["epoch", "sourceEpoch", "origin", "envelope"],
};
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
class GatewayError extends Error { constructor(readonly code: VolatileCode) { super(code); } }
function fail(code: VolatileCode): never { throw new GatewayError(code); }

/** Includes the response body and also bounds injected operations which ignore abort. */
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, stop: AbortSignal, ms: number): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  stop.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, ms);
  if (stop.aborted) abort();
  let rejectAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new GatewayError("RELAY_UNAVAILABLE"));
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  try { return await Promise.race([Promise.resolve().then(() => {
    if (controller.signal.aborted) fail("RELAY_UNAVAILABLE");
    return work(controller.signal);
  }), cancelled]); }
  finally { clearTimeout(timer); stop.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", rejectAbort); }
}
async function peerJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) fail("PEER_UNREACHABLE");
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      if (signal.aborted) fail("PEER_UNREACHABLE");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT.replyBytes) fail("PEER_UNREACHABLE");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { signal.removeEventListener("abort", cancel); cancel(); }
}

export interface VolatileGatewayOptions {
  readonly root?: string;
  readonly peerOrigin?: string;
  readonly inspectSession: (selector: string) => Promise<SessionInspectionResult>;
  readonly peerFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly investigation?: BoundedRelayInvestigation;
  readonly limits?: Partial<Record<keyof typeof MEMORY_RELAY_LIMITS, number>>;
}

/** Broker-authorized volatile transport. Explicit construction only: no production
 * singleton/HTTP cutover. Endpoint retries drive forwarding; no replay/background spool. */
export class VolatileRelayGateway {
  readonly #store: MemoryRelayStore;
  readonly #now: () => number;
  readonly #inspect: VolatileGatewayOptions["inspectSession"];
  readonly #fetch: NonNullable<VolatileGatewayOptions["peerFetch"]>;
  readonly #origin: string | undefined;
  readonly #investigation: BoundedRelayInvestigation | undefined;
  readonly #stop = new AbortController();
  readonly #forwarding = new Map<string, Promise<VolatileResult>>();
  #ordinary = 0; #peers = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastCleanup = -Infinity; #lastWarning = -Infinity;

  constructor(options: VolatileGatewayOptions) {
    if (options.peerOrigin !== undefined) {
      const url = new URL(options.peerOrigin);
      if (canonicalTailnetOrigin(url.hostname) !== options.peerOrigin) throw new TypeError("invalid volatile relay origin");
    }
    this.#origin = options.peerOrigin; this.#fetch = options.peerFetch ?? fetch;
    this.#inspect = options.inspectSession; this.#now = options.now ?? Date.now;
    this.#investigation = options.investigation ?? (options.root === undefined ? undefined
      : new BoundedRelayInvestigation(new RotatingRelayInvestigationWriter(join(options.root, "investigation-volatile-v1"))));
    this.#store = new MemoryRelayStore({ limits: options.limits, investigation: this.#investigation });
  }

  get epoch(): string { return this.#store.epoch; }
  initialize(): void {
    if (this.#stop.signal.aborted) fail("RELAY_RESET");
    if (this.#timer) return;
    this.maintenance();
    this.#timer = setInterval(() => this.maintenance(), 1000); this.#timer.unref?.();
  }
  maintenance(): void {
    if (this.#stop.signal.aborted) return;
    const now = this.#now(); this.#store.maintenance(this.epoch, now);
    if (now - this.#lastCleanup >= 60_000) { this.#lastCleanup = now; this.#investigation?.requestCleanup(); }
    const health = this.#investigation?.health();
    if (health?.degraded && now - this.#lastWarning >= 60_000) {
      this.#lastWarning = now;
      log.warn("best-effort relay investigation degraded", { droppedRecords: health.droppedRecords, lastFailure: health.lastFailure });
    }
  }
  async close(): Promise<void> {
    this.#stop.abort(); if (this.#timer) clearInterval(this.#timer); this.#timer = undefined;
    // Graceful callers may drain. Worker termination remains abrupt/best-effort.
    await this.#investigation?.close();
  }
  request(input: unknown): Promise<VolatileResult> { return this.#run(input, "endpoint"); }
  /** Host-only input derived from freshly verified topology, never endpoint URLs. */
  topology(input: unknown): Promise<VolatileResult> { return this.#run(input, "topology"); }
  /** The caller must enforce the inherited trusted Tailnet peer policy. */
  peer(input: unknown): Promise<VolatileResult> { return this.#run(input, "peer"); }
  #success(value: VolatileValue): VolatileResult { return { ok: true, profile: MEMORY_RELAY_PROFILE, epoch: this.epoch, value }; }

  async #run(input: unknown, ingress: "endpoint" | "peer" | "topology"): Promise<VolatileResult> {
    const peer = ingress === "peer";
    if (this.#stop.signal.aborted) return volatileFailure("RELAY_RESET", this.epoch);
    if ((peer ? this.#peers : this.#ordinary) >= (peer ? LIMIT.peerRequests : LIMIT.requests)) return volatileFailure("RELAY_CAPACITY", this.epoch, 1000);
    if (peer) this.#peers++; else this.#ordinary++;
    try {
      let value: VolatileRequest | VolatilePeerRequest | VolatileTopologyRequest;
      try { value = captureRelayWire(input, RELAY_LIMITS.HTTP_BODY_BYTES).value as typeof value; }
      catch { return volatileFailure("INVALID_REQUEST", this.epoch); }
      if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_REQUEST");
      if (value.profile !== MEMORY_RELAY_PROFILE) fail("RELAY_PROFILE_REQUIRED");
      if (typeof value.operation !== "string") fail("INVALID_REQUEST");
      const allowed = Object.hasOwn(fields, value.operation) ? fields[value.operation] : undefined;
      if (!allowed || (value.operation === "receivePeer") !== peer
        || (value.operation === "resolvePeer") !== (ingress === "topology")) fail("INVALID_REQUEST");
      const binding = value.operation === "connect" || peer ? [] : ["epoch", "callerSession", "endpoint"];
      if (Object.keys(value).some(key => !["profile", "operation", ...binding, ...allowed].includes(key))) fail("INVALID_REQUEST");
      if (value.operation === "connect") {
        if (value.epoch !== undefined) this.#store.checkEpoch(value.epoch);
        const caller = await this.#caller(value.callerSession);
        const registration = this.#store.register({ sessionId: caller.sessionId, generation: value.generation,
          protocolVersions: value.protocolVersions, leaseMs: value.leaseMs ?? RELAY_LIMITS.LEASE_MS }, this.#now());
        return this.#success({ kind: "connected", endpoint: registration.endpoint, leaseExpiresAt: registration.leaseExpiresAt });
      }
      if (!isOpaqueRelayId(value.epoch)) fail("INVALID_REQUEST");
      this.#store.checkEpoch(value.epoch);
      if (value.operation === "receivePeer") return await this.#receivePeer(value);
      await this.#owner(value);
      switch (value.operation) {
        case "resolvePeer": {
          if (!isRelayEndpoint(value.target) || !isLocalRelay(value.target) || !isOpaqueRelayId(value.peerEpoch)) fail("INVALID_REQUEST");
          const route = this.#store.peerRoute(this.epoch, value.origin, value.peerEpoch);
          return this.#success({ kind: "resolved", endpoint: { relay: route.id, id: value.target.id } });
        }
        case "resolve": {
          if (!isRelayEndpoint(value.target)) fail("INVALID_REQUEST");
          if (isLocalRelay(value.target)) { await this.#target(value.target.id); this.#checkOwner(value); }
          else if (!this.#store.peerEpoch(this.epoch, value.target.relay)) fail("CROSS_RELAY_ENDPOINT");
          return this.#success({ kind: "resolved", endpoint: value.target });
        }
        case "send": {
          if (!isRelayEnvelope(value.envelope) || value.envelope.source.relay !== RELAY_ID
            || value.envelope.source.id !== value.endpoint.id) fail("SOURCE_MISMATCH");
          if (value.envelope.protocolVersion !== RELAY_PROTOCOL_VERSION) fail("INVALID_REQUEST");
          if (isLocalRelay(value.envelope.target)) {
            await this.#target(value.envelope.target.id); this.#checkOwner(value);
            const accepted = this.#store.accept(this.epoch, value.envelope, this.#now());
            return this.#success({ kind: "accepted", envelopeId: value.envelope.envelopeId, acceptanceId: accepted.acceptanceId,
              duplicate: accepted.kind === "duplicate", forwarding: "local" });
          }
          return await this.#forward(value.envelope);
        }
        case "receive": return this.#success({ kind: "page", ...this.#store.inbox(this.epoch, value.endpoint.id, value.cursor, this.#now(), value.limit) });
        case "acknowledge": {
          if (!text(value.envelopeId)) fail("INVALID_REQUEST");
          const result = this.#store.acknowledge(this.epoch, value.endpoint.id, value.envelopeId, this.#now());
          if (result === "missing") fail("INVALID_REQUEST");
          return this.#success({ kind: "acknowledged", duplicate: result === "duplicate" });
        }
        // Use the inspected stable session ID rather than the caller's name.
        case "disconnect": return this.#disconnect(value);
        case "health": return this.#success({ kind: "health", store: this.#store.stats(), investigation: this.#investigation?.health() });
      }
      return fail("INVALID_REQUEST");
    } catch (error) {
      return volatileFailure(this.#stop.signal.aborted ? "RELAY_RESET"
        : error instanceof GatewayError || error instanceof MemoryRelayError ? error.code : "RELAY_UNAVAILABLE", this.epoch);
    } finally { if (peer) this.#peers--; else this.#ordinary--; }
  }

  #disconnect(value: VolatileBinding): VolatileResult {
    const registration = this.#store.registration(this.epoch, value.endpoint.id, this.#now());
    if (!registration) fail("REGISTRATION_EXPIRED");
    this.#store.disconnect(this.epoch, registration.sessionId, value.endpoint.id, this.#now());
    return this.#success({ kind: "disconnected" });
  }
  async #caller(selector: string): Promise<Extract<SessionInspectionResult, { ok: true }>> {
    if (!text(selector)) fail("CALLER_NOT_FOUND");
    const inspected = await bounded(() => this.#inspect(selector), this.#stop.signal, LIMIT.inspectMs);
    if (this.#stop.signal.aborted) fail("RELAY_RESET");
    if (!inspected.ok) fail("CALLER_NOT_FOUND");
    if (!inspected.alive) fail("CALLER_DEAD");
    return inspected;
  }
  async #owner(binding: VolatileBinding): Promise<void> {
    if (!isRelayEndpoint(binding.endpoint) || !isLocalRelay(binding.endpoint)) fail("SOURCE_MISMATCH");
    const caller = await this.#caller(binding.callerSession);
    const registration = this.#checkOwner(binding);
    if (registration.sessionId !== caller.sessionId) fail("SOURCE_MISMATCH");
  }
  #checkOwner(binding: VolatileBinding): RelayRegistration {
    if (this.#stop.signal.aborted) fail("RELAY_RESET");
    const registration = this.#store.registration(this.epoch, binding.endpoint.id, this.#now());
    if (!registration) fail("REGISTRATION_EXPIRED");
    return registration;
  }
  async #target(id: string): Promise<void> {
    const target = this.#store.registration(this.epoch, id, this.#now());
    if (!target) fail("TARGET_NOT_REGISTERED");
    let caller: Extract<SessionInspectionResult, { ok: true }>;
    try { caller = await this.#caller(target.sessionId); }
    catch (error) { if (error instanceof GatewayError && ["CALLER_NOT_FOUND", "CALLER_DEAD"].includes(error.code)) fail("TARGET_NOT_REGISTERED"); throw error; }
    if (caller.sessionId !== target.sessionId || !this.#store.registration(this.epoch, id, this.#now())) fail("TARGET_NOT_REGISTERED");
  }
  async #receivePeer(input: VolatilePeerRequest): Promise<VolatileResult> {
    if (!isOpaqueRelayId(input.sourceEpoch) || !isRelayEnvelope(input.envelope)
      || !isLocalRelay(input.envelope.source) || !isLocalRelay(input.envelope.target)) fail("INVALID_REQUEST");
    await this.#target(input.envelope.target.id);
    const route = this.#store.peerRoute(this.epoch, input.origin, input.sourceEpoch);
    const accepted = this.#store.accept(this.epoch, { ...input.envelope, source: { ...input.envelope.source, relay: route.id } }, this.#now());
    return this.#success({ kind: "accepted", envelopeId: input.envelope.envelopeId, acceptanceId: accepted.acceptanceId,
      duplicate: accepted.kind === "duplicate", forwarding: "local" });
  }

  async #forward(envelope: RelayEnvelope): Promise<VolatileResult> {
    const peerEpoch = this.#store.peerEpoch(this.epoch, envelope.target.relay);
    if (!peerEpoch) fail("CROSS_RELAY_ENDPOINT");
    if (!this.#origin) fail("RELAY_UNAVAILABLE");
    const attempt = this.#store.beginForward(this.epoch, envelope, this.#now());
    if (attempt.kind === "forwarded") return this.#success({ kind: "accepted", envelopeId: envelope.envelopeId,
      acceptanceId: attempt.acceptanceId, duplicate: true, forwarding: "forwarded" });
    if (attempt.kind === "unconfirmed") return volatileFailure("DELIVERY_UNCONFIRMED", this.epoch);
    if (attempt.kind === "pending") return this.#forwarding.get(envelope.envelopeId)
      ?? volatileFailure("PEER_UNREACHABLE", this.epoch, Math.max(0, attempt.retryAt - this.#now()));
    const promise = this.#attempt(attempt, peerEpoch);
    this.#forwarding.set(envelope.envelopeId, promise);
    try { return await promise; }
    finally { if (this.#forwarding.get(envelope.envelopeId) === promise) this.#forwarding.delete(envelope.envelopeId); }
  }
  async #attempt(attempt: Extract<ForwardAttempt, { kind: "attempt" }>, peerEpoch: string): Promise<VolatileResult> {
    const { envelope } = attempt;
    const origin = this.#origin;
    if (!origin) fail("RELAY_UNAVAILABLE");
    let outcome: { kind: "confirmed"; acceptanceId: string } | { kind: "retryable" | "rejected" } = { kind: "retryable" };
    let duplicate = false;
    try {
      const replyOutcome = await bounded(async signal => {
        const response = await this.#fetch(`${attempt.origin}${VOLATILE_PEER_PATH}`, {
          method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal,
          body: JSON.stringify({ operation: "receivePeer", profile: MEMORY_RELAY_PROFILE, epoch: peerEpoch, sourceEpoch: this.epoch,
            origin, envelope: { ...envelope, target: { ...envelope.target, relay: RELAY_ID } } } satisfies VolatilePeerRequest),
        });
        const reply = await peerJson(response, signal) as VolatileResult;
        const retry = { outcome: { kind: "retryable" as const }, duplicate: false };
        if (reply?.profile !== MEMORY_RELAY_PROFILE) return retry;
        if (!reply.ok && reply.error?.code === "RELAY_RESET" && isOpaqueRelayId(reply.epoch)) {
          return { outcome: { kind: "rejected" as const }, duplicate: false };
        }
        if (reply.epoch !== peerEpoch) return retry;
        if (response.ok && reply.ok && reply.value?.kind === "accepted" && reply.value.envelopeId === envelope.envelopeId
          && reply.value.forwarding === "local" && typeof reply.value.duplicate === "boolean" && isOpaqueRelayId(reply.value.acceptanceId)) {
          return { outcome: { kind: "confirmed" as const, acceptanceId: reply.value.acceptanceId }, duplicate: reply.value.duplicate };
        }
        return reply.ok === false && reply.error?.retryable === false
          ? { outcome: { kind: "rejected" as const }, duplicate: false } : retry;
      }, this.#stop.signal, LIMIT.peerMs);
      // A response arriving after the deadline cannot mutate this result/token.
      outcome = replyOutcome.outcome; duplicate = replyOutcome.duplicate;
    } catch { /* Unknown outcome: identical endpoint retries may confirm it. */ }
    if (this.#stop.signal.aborted) return volatileFailure("RELAY_RESET", this.epoch);
    this.#store.finishForward(this.epoch, envelope.envelopeId, attempt.token, outcome, this.#now());
    const state = this.#store.forwardStatus(this.epoch, envelope.envelopeId, this.#now());
    if (state?.kind === "forwarded") return this.#success({ kind: "accepted", envelopeId: envelope.envelopeId,
      acceptanceId: state.acceptanceId, duplicate, forwarding: "forwarded" });
    if (state?.kind === "unconfirmed") return volatileFailure("DELIVERY_UNCONFIRMED", this.epoch);
    return volatileFailure("PEER_UNREACHABLE", this.epoch, Math.max(0, (state?.retryAt ?? this.#now() + 1000) - this.#now()));
  }
}
