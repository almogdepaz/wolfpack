import type { SessionInspectionResult } from "../session-status-contract.ts";
import { canonicalTailnetOrigin } from "../tailnet-machine-contract.ts";
import { createLogger } from "../log.ts";
import { RELAY_ID, RELAY_LIMITS, RELAY_PROTOCOL_VERSION, isLocalRelay, isOpaqueRelayId, isRelayEndpoint, isRelayEnvelope } from "./domain.ts";
import type { RelayEnvelope, RelayRegistration } from "./domain.ts";
import { RelayOwnerFailure } from "./owner-failure.ts";
import { createRecoveryStore } from "./recovery-store.ts";
import { MEMORY_RELAY_LIMITS, MEMORY_RELAY_PROFILE, MemoryRelayError, MemoryRelayStore } from "./memory-store.ts";
import type { ForwardAttempt } from "./memory-store.ts";
import type { TaskRelayRegistration } from "./registration.ts";
import type { BoundedRelayInvestigation } from "./investigation.ts";
import { createSuspensionInclusiveElapsedNow } from "./suspension-inclusive-clock.ts";
import { captureRelayWire } from "./worker-protocol.ts";
import { VOLATILE_GATEWAY_LIMITS as LIMIT, VOLATILE_PEER_PATH, volatileFailure } from "./volatile-protocol.ts";
import type { VolatileBinding, VolatileCode, VolatilePeerRequest, VolatileRequest, VolatileResult, VolatileValue, VolatileTopologyRequest } from "./volatile-protocol.ts";

const log = createLogger("task-relay");
const MAINTENANCE_INTERVAL_MS = 1_000;
const MATERIAL_MAINTENANCE_GAP_MS = MAINTENANCE_INTERVAL_MS * 5;
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
  readonly storage?: "memory" | "sqlite";
  readonly onOwnerFailure?: (failure: RelayOwnerFailure) => void;
  readonly peerOrigin?: string;
  readonly inspectSession: (selector: string) => Promise<SessionInspectionResult>;
  readonly peerFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly elapsedNow?: () => number;
  readonly investigation?: BoundedRelayInvestigation;
  readonly limits?: Partial<Record<keyof typeof MEMORY_RELAY_LIMITS, number>>;
}

/** Content-blind volatile-v1 ingress. Storage is server-owned and independent of
 * endpoint task state; durable recovery never replays an interrupted mutation. */
export class VolatileRelayGateway {
  readonly #store: MemoryRelayStore;
  readonly #profile = MEMORY_RELAY_PROFILE;
  readonly #recoverable: boolean;
  readonly #onOwnerFailure: VolatileGatewayOptions["onOwnerFailure"];
  #retirementAfter = "";
  readonly #closeStore: (() => void) | undefined;
  readonly #now: () => number;
  readonly #elapsedNow: () => number;
  readonly #inspect: VolatileGatewayOptions["inspectSession"];
  readonly #fetch: NonNullable<VolatileGatewayOptions["peerFetch"]>;
  readonly #origin: string | undefined;
  readonly #investigation: BoundedRelayInvestigation | undefined;
  readonly #stop = new AbortController();
  readonly #forwarding = new Map<string, Promise<VolatileResult>>();
  #ordinary = 0; #peers = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastMaintenance: number | undefined;
  #lastMaintenanceElapsed: number | undefined;
  #lastMaintenanceMutation: bigint | undefined;
  #lastCleanup = -Infinity; #lastWarning = -Infinity;

  constructor(options: VolatileGatewayOptions) {
    if (options.peerOrigin !== undefined) {
      const url = new URL(options.peerOrigin);
      if (canonicalTailnetOrigin(url.hostname) !== options.peerOrigin) throw new TypeError("invalid volatile relay origin");
    }
    this.#origin = options.peerOrigin; this.#fetch = options.peerFetch ?? fetch;
    this.#inspect = options.inspectSession; this.#now = options.now ?? Date.now;
    this.#elapsedNow = options.elapsedNow ?? createSuspensionInclusiveElapsedNow();
    // Explicit diagnostic injection only. The normal worker never writes task history.
    this.#investigation = options.investigation;
    this.#recoverable = options.storage === "sqlite";
    this.#onOwnerFailure = options.onOwnerFailure;
    if (this.#recoverable) {
      if (!options.root) throw new TypeError("restart-safe relay requires an explicit private root");
      const recovery = createRecoveryStore({ root: options.root, peerOrigin: options.peerOrigin, limits: options.limits, investigation: this.#investigation });
      this.#store = recovery.store; this.#closeStore = recovery.close;
    } else this.#store = new MemoryRelayStore({ limits: options.limits, investigation: this.#investigation });
  }

  get epoch(): string { return this.#store.epoch; }
  initialize(): void {
    if (this.#stop.signal.aborted) fail("RELAY_RESET");
    if (this.#timer) return;
    this.maintenance();
    this.#timer = setInterval(() => {
      try { this.maintenance(); }
      catch (error) {
        if (!(error instanceof RelayOwnerFailure) || !this.#onOwnerFailure) throw error;
        this.#stop.abort(); clearInterval(this.#timer); this.#timer = undefined;
        this.#onOwnerFailure(error);
      }
    }, MAINTENANCE_INTERVAL_MS); this.#timer.unref?.();
  }
  maintenance(): void {
    if (this.#stop.signal.aborted) return;
    const now = this.#now(), elapsed = this.#elapsedNow(), previousElapsed = this.#lastMaintenanceElapsed;
    const elapsedContinuous = Number.isFinite(elapsed) && previousElapsed !== undefined && elapsed > previousElapsed;
    if (elapsedContinuous && this.#lastMaintenance !== undefined && this.#lastMaintenanceMutation !== undefined
      && elapsed - previousElapsed >= MATERIAL_MAINTENANCE_GAP_MS) {
      this.#store.compensateLiveRegistrationLeases(this.epoch, this.#lastMaintenance, this.#lastMaintenanceMutation, now);
    }
    this.#store.maintenance(this.epoch, now);
    this.#lastMaintenance = now;
    this.#lastMaintenanceMutation = this.#store.registrationMutation;
    this.#lastMaintenanceElapsed = Number.isFinite(elapsed) && (previousElapsed === undefined || elapsed > previousElapsed) ? elapsed : undefined;
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
    this.#closeStore?.();
    await this.#investigation?.close();
  }
  /** Host-only, request-local lease observation. The broker separately proves liveness/root/harness. */
  async registrationsForSessions(sessionIds: readonly string[]): Promise<ReadonlyMap<string, TaskRelayRegistration>> {
    if (this.#stop.signal.aborted) fail("RELAY_RESET");
    const now = this.#now(), registrations = new Map<string, TaskRelayRegistration>();
    for (const sessionId of sessionIds) {
      const registration = this.#store.registrationForSession(this.epoch, sessionId, now);
      if (registration) registrations.set(sessionId, { profile: this.#profile, epoch: this.epoch,
        endpoint: registration.endpoint, leaseExpiresAt: registration.leaseExpiresAt });
    }
    return registrations;
  }
  request(input: unknown): Promise<VolatileResult> { return this.#run(input, "endpoint"); }
  /** Host-only input derived from freshly verified topology, never endpoint URLs. */
  topology(input: unknown): Promise<VolatileResult> { return this.#run(input, "topology"); }
  /** The caller must enforce the inherited trusted Tailnet peer policy. */
  peer(input: unknown): Promise<VolatileResult> { return this.#run(input, "peer"); }
  #success(value: VolatileValue): VolatileResult { return { ok: true, profile: this.#profile, epoch: this.epoch, value }; }
  #failure(code: VolatileCode, epoch?: string, retryAfterMs?: number): VolatileResult { return volatileFailure(code, epoch, retryAfterMs, this.#profile); }

  async #run(input: unknown, ingress: "endpoint" | "peer" | "topology"): Promise<VolatileResult> {
    const peer = ingress === "peer";
    if (this.#stop.signal.aborted) return this.#failure("RELAY_RESET", this.epoch);
    if ((peer ? this.#peers : this.#ordinary) >= (peer ? LIMIT.peerRequests : LIMIT.requests)) return this.#failure("RELAY_CAPACITY", this.epoch, 1000);
    if (peer) this.#peers++; else this.#ordinary++;
    try {
      let value: VolatileRequest | VolatilePeerRequest | VolatileTopologyRequest;
      try { value = captureRelayWire(input, RELAY_LIMITS.HTTP_BODY_BYTES).value as typeof value; }
      catch { return this.#failure("INVALID_REQUEST", this.epoch); }
      if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_REQUEST");
      if (value.profile !== this.#profile) fail("RELAY_PROFILE_REQUIRED");
      if (typeof value.operation !== "string") fail("INVALID_REQUEST");
      const allowed = Object.hasOwn(fields, value.operation) ? fields[value.operation] : undefined;
      if (!allowed || (value.operation === "receivePeer") !== peer
        || (value.operation === "resolvePeer") !== (ingress === "topology")) fail("INVALID_REQUEST");
      const binding = value.operation === "connect" || peer ? [] : ["epoch", "callerSession", "endpoint"];
      if (Object.keys(value).some(key => !["profile", "operation", ...binding, ...allowed].includes(key))) fail("INVALID_REQUEST");
      if (value.operation === "connect") {
        if (value.epoch !== undefined) this.#store.checkEpoch(value.epoch);
        const caller = await this.#caller(value.callerSession);
        const input = { sessionId: caller.sessionId, generation: value.generation,
          protocolVersions: value.protocolVersions, leaseMs: value.leaseMs ?? RELAY_LIMITS.LEASE_MS };
        let registration: RelayRegistration;
        try { registration = this.#store.register(input, this.#now()); }
        catch (error) {
          if (!(error instanceof MemoryRelayError) || error.code !== "RELAY_CAPACITY" || !this.#recoverable) throw error;
          await this.#reclaimRegistration();
          registration = this.#store.register(input, this.#now());
        }
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
      if (error instanceof RelayOwnerFailure) throw error; // The owner is poisoned, not an ordinary request rejection.
      return this.#failure(this.#stop.signal.aborted ? "RELAY_RESET"
        : error instanceof GatewayError || error instanceof MemoryRelayError ? error.code : "RELAY_UNAVAILABLE", this.epoch);
    } finally { if (peer) this.#peers--; else this.#ordinary--; }
  }

  async #reclaimRegistration(): Promise<void> {
    // One fresh bounded inspection per capacity rejection. Round-robin avoids
    // a permanently live/offline first candidate starving reclaimable entries.
    const candidate = this.#store.retirementCandidate(this.epoch, this.#now(), this.#retirementAfter);
    if (!candidate || !isOpaqueRelayId(candidate.registration.sessionId)) return;
    this.#retirementAfter = candidate.registration.endpoint.id;
    let inspected: SessionInspectionResult;
    try { inspected = await bounded(() => this.#inspect(candidate.registration.sessionId), this.#stop.signal, LIMIT.inspectMs); }
    catch { return; } // Unavailable is not authoritative absence.
    if (this.#stop.signal.aborted) fail("RELAY_RESET");
    if ((!inspected.ok && inspected.code === "NOT_FOUND")
      || (inspected.ok && inspected.sessionId === candidate.registration.sessionId && !inspected.alive)) {
      this.#store.retireRegistration(this.epoch, candidate.registration.endpoint.id, candidate.mutation, this.#now());
    }
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
    const target = this.#store.registration(this.epoch, id, this.#now())
      ?? (this.#recoverable ? this.#store.retainedRegistration(this.epoch, id) : undefined);
    if (!target) fail("TARGET_NOT_REGISTERED");
    let caller: Extract<SessionInspectionResult, { ok: true }>;
    try { caller = await this.#caller(target.sessionId); }
    catch (error) { if (error instanceof GatewayError && ["CALLER_NOT_FOUND", "CALLER_DEAD"].includes(error.code)) fail("TARGET_NOT_REGISTERED"); throw error; }
    if (caller.sessionId !== target.sessionId) fail("TARGET_NOT_REGISTERED");
    if (this.#recoverable) {
      // Inspection awaited: a deliberate fresh generation may now own the session.
      // Recheck the exact predecessor before renewal; never resurrect its generation.
      const current = this.#store.retainedRegistration(this.epoch, id);
      if (!current || current.generation !== target.generation || current.sessionId !== target.sessionId) fail("TARGET_NOT_REGISTERED");
      // An offline endpoint process may resume. Retain mail for the freshly proven broker incarnation,
      // without treating a stale lease alone as authority or replacing its generation.
      this.#store.register({ sessionId: target.sessionId, generation: target.generation, protocolVersions: target.protocolVersions, leaseMs: RELAY_LIMITS.LEASE_MS }, this.#now());
    }
    if (!this.#store.registration(this.epoch, id, this.#now())) fail("TARGET_NOT_REGISTERED");
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
    if (attempt.kind === "unconfirmed") return this.#failure("DELIVERY_UNCONFIRMED", this.epoch);
    if (attempt.kind === "pending") return this.#forwarding.get(envelope.envelopeId)
      ?? this.#failure("PEER_UNREACHABLE", this.epoch, Math.max(0, attempt.retryAt - this.#now()));
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
          body: JSON.stringify({ operation: "receivePeer", profile: this.#profile, epoch: peerEpoch, sourceEpoch: this.epoch,
            origin, envelope: { ...envelope, target: { ...envelope.target, relay: RELAY_ID } } } satisfies VolatilePeerRequest),
        });
        const reply = await peerJson(response, signal) as VolatileResult;
        const retry = { outcome: { kind: "retryable" as const }, duplicate: false };
        if (reply?.profile !== this.#profile) return retry;
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
    if (this.#stop.signal.aborted) return this.#failure("RELAY_RESET", this.epoch);
    this.#store.finishForward(this.epoch, envelope.envelopeId, attempt.token, outcome, this.#now());
    const state = this.#store.forwardStatus(this.epoch, envelope.envelopeId, this.#now());
    if (state?.kind === "forwarded") return this.#success({ kind: "accepted", envelopeId: envelope.envelopeId,
      acceptanceId: state.acceptanceId, duplicate, forwarding: "forwarded" });
    if (state?.kind === "unconfirmed") return this.#failure("DELIVERY_UNCONFIRMED", this.epoch);
    return this.#failure("PEER_UNREACHABLE", this.epoch, Math.max(0, (state?.retryAt ?? this.#now() + 1000) - this.#now()));
  }
}
