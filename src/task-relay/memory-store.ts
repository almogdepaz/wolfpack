import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../canonical-json.ts";
import { canonicalTailnetOrigin } from "../tailnet-machine-contract.ts";
import { RELAY_ID, RELAY_LIMITS, RELAY_PROTOCOL_VERSION, isOpaqueRelayId, isPeerRelayId, isRelayEnvelope, isRelayTimestamp } from "./domain.ts";
import type { RelayEndpoint, RelayEnvelope, RelayRegistration } from "./domain.ts";
import { captureRelayWire } from "./worker-protocol.ts";
import { RelayExpiryIndex } from "./expiry-index.ts";
import type { RelayInvestigationEvent, RelayInvestigationSink } from "./investigation.ts";

export const MEMORY_RELAY_PROFILE = "volatile-v1";
export const MEMORY_RELAY_LIMITS = Object.freeze({
  activeItems: 4096, activeBytes: 64 * 1024 * 1024,
  mailboxItems: 256, mailboxBytes: 8 * 1024 * 1024,
  peerItems: 128, peerBytes: 8 * 1024 * 1024,
  receipts: 50_000, receiptBytes: 8 * 1024 * 1024,
  registrations: 2048, routes: 2048, metadataBytes: 16 * 1024 * 1024,
});
export const MEMORY_RELAY_TIMING = Object.freeze({ retryMs: 1000, deadlineMs: 120_000, receiptMs: 900_000, clockSkewMs: 30_000 });
type Limits = { readonly [K in keyof typeof MEMORY_RELAY_LIMITS]: number };
export type MemoryRelayCode = "RELAY_CAPACITY" | "RELAY_RESET" | "INVALID_REQUEST" | "INVALID_CURSOR"
  | "REGISTRATION_EXPIRED" | "TARGET_NOT_REGISTERED" | "CROSS_RELAY_ENDPOINT" | "ENVELOPE_CONFLICT" | "ENVELOPE_EXPIRED";
export class MemoryRelayError extends Error {
  constructor(readonly code: MemoryRelayCode) { super(code); }
  get retryable(): boolean { return this.code === "RELAY_CAPACITY"; }
}
function fail(code: MemoryRelayCode): never { throw new MemoryRelayError(code); }
const bytes = (value: unknown): number => Buffer.byteLength(canonicalJson(value));
const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,31})$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const keys = (value: object, expected: readonly string[]): boolean => Object.keys(value).every(key => expected.includes(key));
function time(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - MEMORY_RELAY_TIMING.receiptMs) fail("INVALID_REQUEST");
}
function captured<T>(input: T, limit: number): T {
  try { return captureRelayWire(input, limit).value; } catch { return fail("INVALID_REQUEST"); }
}

interface RegistrationEntry {
  value: RelayRegistration;
  readonly mailbox: Map<string, bigint>;
  cursor: bigint;
  mailboxBytes: number;
  references: number;
  bytes: number;
}
interface Route { readonly id: string; readonly origin: string; readonly bytes: number; items: number; payloadBytes: number }
type State = "mailbox" | "acknowledged" | "forwarding" | "forwarded" | "unconfirmed";
/** No payload/parsed envelope is allowed in a receipt or secondary index. */
interface Receipt {
  readonly id: string;
  readonly digest: string;
  readonly source: RelayEndpoint;
  readonly target: RelayEndpoint;
  readonly bytes: number;
  readonly payloadBytes: number;
  readonly cursor: string | undefined;
  readonly deadline: number;
  acceptanceId: string | undefined;
  state: State;
  attempts: number;
  nextAttemptAt: number;
  token: string | undefined;
  expiresAt: number | undefined;
}
export type ForwardAttempt = { readonly kind: "attempt"; readonly token: string; readonly envelope: RelayEnvelope; readonly origin: string }
  | { readonly kind: "pending"; readonly retryAt: number }
  | { readonly kind: "forwarded"; readonly acceptanceId: string }
  | { readonly kind: "unconfirmed"; readonly mayHaveBeenDelivered: true };

/**
 * Worker-owned engine for the negotiated volatile profile. No filesystem/root,
 * timers, network calls, full-state snapshots or process-global store registry.
 * Methods linearize synchronously; the gateway still owns broker inspection and
 * trusted peer admission. NOT wired into the legacy v2 gateway until cutover.
 */
export class MemoryRelayStore {
  readonly #epoch = randomUUID();
  readonly #limits: Limits;
  readonly #sink: RelayInvestigationSink | undefined;
  readonly #registrations = new Map<string, RegistrationEntry>();
  readonly #sessions = new Map<string, string>();
  readonly #routes = new Map<string, Route>();
  readonly #origins = new Map<string, string>();
  readonly #receipts = new Map<string, Receipt>();
  readonly #payloads = new Map<string, string>();
  readonly #expiry = new RelayExpiryIndex();
  #activeBytes = 0;
  #receiptBytes = 0;
  #metadataBytes = 0;
  #logDrops = 0;

  constructor(options: { readonly limits?: Partial<Limits>; readonly investigation?: RelayInvestigationSink } = {}) {
    const overrides = captured(options.limits ?? {}, 4096);
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides) || !keys(overrides, Object.keys(MEMORY_RELAY_LIMITS))) fail("INVALID_REQUEST");
    const limits = { ...MEMORY_RELAY_LIMITS, ...overrides };
    for (const key of Object.keys(limits) as (keyof Limits)[]) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > MEMORY_RELAY_LIMITS[key]) fail("INVALID_REQUEST");
    }
    this.#limits = Object.freeze(limits);
    this.#sink = options.investigation;
  }

  get epoch(): string { return this.#epoch; }
  checkEpoch(epoch: string): void { if (epoch !== this.#epoch) fail("RELAY_RESET"); }

  stats() {
    return { activeItems: this.#payloads.size, activeBytes: this.#activeBytes, receipts: this.#receipts.size,
      receiptBytes: this.#receiptBytes, registrations: this.#registrations.size, sessions: this.#sessions.size,
      routes: this.#routes.size, metadataBytes: this.#metadataBytes, expiryEntries: this.#expiry.size,
      investigationEnabled: this.#sink !== undefined, logDrops: this.#logDrops };
  }

  /** sessionId must come from the gateway's fresh authoritative broker inspection. */
  register(input: { readonly sessionId: string; readonly generation: string; readonly leaseMs: number; readonly protocolVersions: readonly number[] }, now: number): RelayRegistration {
    time(now);
    const value = captured(input, 4096);
    if (!value || !keys(value, ["sessionId", "generation", "leaseMs", "protocolVersions"]) || !text(value.sessionId) || !text(value.generation)
      || !Number.isInteger(value.leaseMs) || value.leaseMs < 1 || value.leaseMs > RELAY_LIMITS.MAX_LEASE_MS
      || !Array.isArray(value.protocolVersions) || value.protocolVersions.length > 16 || !value.protocolVersions.every(Number.isInteger)
      || !value.protocolVersions.includes(RELAY_PROTOCOL_VERSION)) fail("INVALID_REQUEST");
    // Renew the current generation even at lease expiry if it still owns state.
    const priorId = this.#sessions.get(value.sessionId);
    const prior = priorId === undefined ? undefined : this.#registrations.get(priorId);
    const existing = prior?.value.generation === value.generation ? prior : undefined;
    const registration: RelayRegistration = {
      endpoint: existing?.value.endpoint ?? { relay: RELAY_ID, id: randomUUID() },
      sessionId: value.sessionId, generation: value.generation,
      protocolVersions: [...new Set(value.protocolVersions)].sort((a, b) => a - b),
      leaseExpiresAt: new Date(now + value.leaseMs).toISOString(),
    };
    // Include space for the fixed-size cursor, references, and index ownership.
    const size = bytes(registration) + 128;
    if ((!existing && this.#registrations.size >= this.#limits.registrations)
      || this.#metadataBytes + size - (existing?.bytes ?? 0) > this.#limits.metadataBytes) fail("RELAY_CAPACITY");
    const entry = existing ?? { value: registration, mailbox: new Map(), cursor: 0n, mailboxBytes: 0, references: 0, bytes: 0 };
    this.#metadataBytes += size - entry.bytes;
    entry.value = registration; entry.bytes = size;
    this.#registrations.set(registration.endpoint.id, entry);
    this.#sessions.set(value.sessionId, registration.endpoint.id);
    if (!entry.references) this.#expiry.set(`g:${registration.endpoint.id}`, Date.parse(registration.leaseExpiresAt));
    this.#emit("registered", now);
    return structuredClone(registration);
  }

  registration(epoch: string, id: string, now: number): RelayRegistration | undefined {
    this.checkEpoch(epoch); time(now);
    const entry = this.#activeRegistration(id, now);
    return entry && structuredClone(entry.value);
  }

  registrationForSession(epoch: string, sessionId: string, now: number): RelayRegistration | undefined {
    this.checkEpoch(epoch); time(now);
    const id = this.#sessions.get(sessionId);
    return id === undefined ? undefined : this.registration(epoch, id, now);
  }

  disconnect(epoch: string, sessionId: string, endpointId: string, now: number): boolean {
    this.checkEpoch(epoch); time(now);
    const entry = this.#activeRegistration(endpointId, now);
    if (!entry || entry.value.sessionId !== sessionId) return false;
    entry.value = { ...entry.value, leaseExpiresAt: new Date(now).toISOString() };
    if (!entry.references) this.#expiry.set(`g:${endpointId}`, now);
    this.#emit("disconnected", now);
    return true;
  }

  peerRoute(epoch: string, origin: string): { readonly id: string; readonly origin: string } {
    this.checkEpoch(epoch);
    if (!text(origin)) fail("INVALID_REQUEST");
    let url: URL;
    try { url = new URL(origin); } catch { return fail("INVALID_REQUEST"); }
    if (url.protocol !== "https:" || url.origin !== origin || url.pathname !== "/" || url.search || url.hash || canonicalTailnetOrigin(url.hostname) !== origin) fail("INVALID_REQUEST");
    const existing = this.#origins.get(origin);
    if (existing) return { id: existing, origin };
    const id = `${RELAY_ID}:peer:${randomUUID()}`;
    const size = bytes({ id, origin }) + 64;
    if (this.#routes.size >= this.#limits.routes || this.#metadataBytes + size > this.#limits.metadataBytes) fail("RELAY_CAPACITY");
    this.#routes.set(id, { id, origin, bytes: size, items: 0, payloadBytes: 0 });
    this.#origins.set(origin, id); this.#metadataBytes += size;
    return { id, origin }; // Routes remain stable for the epoch; never silently evict aliases.
  }

  peerOrigin(epoch: string, id: string): string | undefined { this.checkEpoch(epoch); return this.#routes.get(id)?.origin; }

  accept(epoch: string, input: RelayEnvelope, now: number): { readonly kind: "accepted" | "duplicate"; readonly acceptanceId: string } {
    this.checkEpoch(epoch); time(now);
    const envelope = this.#envelope(input);
    if (envelope.target.relay !== RELAY_ID) fail("CROSS_RELAY_ENDPOINT");
    const target = this.#activeRegistration(envelope.target.id, now);
    if (!target) fail("TARGET_NOT_REGISTERED");
    this.#source(envelope, now);
    const found = this.#existing(envelope, now);
    if (found) {
      if (found.state !== "mailbox" && found.state !== "acknowledged") fail("ENVELOPE_CONFLICT");
      return { kind: "duplicate", acceptanceId: found.acceptanceId! };
    }
    const cursor = (target.cursor + 1n).toString();
    if (!decimal(cursor)) fail("RELAY_CAPACITY");
    const receipt = this.#admit(envelope, now, "mailbox", cursor);
    target.cursor += 1n;
    target.mailbox.set(receipt.id, target.cursor);
    target.mailboxBytes += receipt.payloadBytes;
    this.#emit("accepted", now, receipt.id, envelope);
    return { kind: "accepted", acceptanceId: receipt.acceptanceId! };
  }

  inbox(epoch: string, endpointId: string, cursor: string, now: number, limit = RELAY_LIMITS.INBOX_PAGE_ITEMS as number) {
    this.checkEpoch(epoch); time(now);
    if (!decimal(cursor) || !Number.isInteger(limit) || limit < 1 || limit > RELAY_LIMITS.INBOX_PAGE_ITEMS) fail("INVALID_CURSOR");
    const entry = this.#activeRegistration(endpointId, now);
    if (!entry) fail("REGISTRATION_EXPIRED");
    const after = BigInt(cursor);
    if (after > entry.cursor) fail("INVALID_CURSOR");
    const deliveries: { cursor: string; envelope: RelayEnvelope }[] = [];
    let pageBytes = 0, hasMore = false;
    // Bounded by this mailbox's active-item ceiling, never by completed history.
    for (const [id, sequence] of entry.mailbox) {
      if (sequence <= after) continue;
      const envelope = JSON.parse(this.#payloads.get(id)!) as RelayEnvelope;
      const delivery = { cursor: sequence.toString(), envelope };
      const size = bytes(delivery);
      if (deliveries.length >= limit || pageBytes + size > RELAY_LIMITS.INBOX_PAGE_BYTES) { hasMore = true; break; }
      deliveries.push(delivery); pageBytes += size;
    }
    return { deliveries, nextCursor: deliveries.at(-1)?.cursor ?? cursor, hasMore };
  }

  acknowledge(epoch: string, endpointId: string, envelopeId: string, now: number): "acknowledged" | "duplicate" | "missing" {
    this.checkEpoch(epoch); time(now);
    if (!this.#activeRegistration(endpointId, now)) fail("REGISTRATION_EXPIRED");
    const receipt = this.#receipt(envelopeId, now);
    if (!receipt || receipt.target.relay !== RELAY_ID || receipt.target.id !== endpointId) return "missing";
    if (receipt.state === "acknowledged") return "duplicate";
    if (receipt.state !== "mailbox") return "missing";
    this.#terminal(receipt, "acknowledged", now);
    this.#emit("acknowledged", now, receipt.id);
    return "acknowledged";
  }

  /** Queuing/starting forwarding is NOT successful relay acceptance. */
  beginForward(epoch: string, input: RelayEnvelope, now: number): ForwardAttempt {
    this.checkEpoch(epoch); time(now);
    const envelope = this.#envelope(input);
    if (envelope.source.relay !== RELAY_ID || !isPeerRelayId(envelope.target.relay)) fail("CROSS_RELAY_ENDPOINT");
    this.#source(envelope, now);
    const route = this.#routes.get(envelope.target.relay);
    if (!route) fail("CROSS_RELAY_ENDPOINT");
    let receipt = this.#existing(envelope, now);
    if (!receipt) {
      receipt = this.#admit(envelope, now, "forwarding", undefined);
      route.items++; route.payloadBytes += receipt.payloadBytes;
      this.#emit("forward_queued", now, receipt.id, envelope);
    }
    if (receipt.state === "forwarded") return { kind: "forwarded", acceptanceId: receipt.acceptanceId! };
    if (receipt.state === "unconfirmed") return { kind: "unconfirmed", mayHaveBeenDelivered: true };
    if (receipt.state !== "forwarding") fail("ENVELOPE_CONFLICT");
    if (receipt.token) return { kind: "pending", retryAt: receipt.nextAttemptAt };
    if (now >= receipt.deadline) {
      this.#terminal(receipt, "unconfirmed", now);
      this.#emit("forward_unconfirmed", now, receipt.id);
      return { kind: "unconfirmed", mayHaveBeenDelivered: true };
    }
    if (now < receipt.nextAttemptAt) return { kind: "pending", retryAt: receipt.nextAttemptAt };
    receipt.attempts++;
    receipt.nextAttemptAt = now + MEMORY_RELAY_TIMING.retryMs;
    receipt.token = randomUUID();
    // Gateway owns a bounded network deadline. Never reap an in-flight attempt
    // underneath its completion; worker loss instead loses the whole epoch.
    this.#expiry.delete(`r:${receipt.id}`);
    this.#emit("forward_attempt", now, receipt.id);
    return { kind: "attempt", token: receipt.token, envelope: JSON.parse(this.#payloads.get(receipt.id)!) as RelayEnvelope, origin: route.origin };
  }

  finishForward(epoch: string, envelopeId: string, token: string,
    outcome: { readonly kind: "confirmed"; readonly acceptanceId: string } | { readonly kind: "retryable" | "rejected" }, now: number): boolean {
    this.checkEpoch(epoch); time(now);
    const value = captured(outcome, 256);
    if (!value || !keys(value, ["kind", "acceptanceId"]) || !["confirmed", "retryable", "rejected"].includes(value.kind)
      || (value.kind === "confirmed" && !isOpaqueRelayId(value.acceptanceId))) fail("INVALID_REQUEST");
    const receipt = this.#receipts.get(envelopeId);
    if (!receipt || receipt.state !== "forwarding" || !receipt.token || receipt.token !== token) return false;
    receipt.token = undefined;
    if (value.kind === "confirmed") {
      receipt.acceptanceId = value.acceptanceId;
      this.#terminal(receipt, "forwarded", now);
      this.#emit("forward_confirmed", now, envelopeId);
    } else if (value.kind === "rejected" || receipt.attempts >= RELAY_LIMITS.MAX_FORWARD_ATTEMPTS || now >= receipt.deadline) {
      this.#terminal(receipt, "unconfirmed", now);
      this.#emit("forward_unconfirmed", now, envelopeId);
    } else {
      this.#expiry.set(`r:${receipt.id}`, receipt.deadline);
      this.#emit("forward_retry", now, envelopeId);
    }
    return true;
  }

  /** Timer/caller drives bounded expiry work. Never expires accepted mailboxes. */
  maintenance(epoch: string, now: number, limit = 64): number {
    this.checkEpoch(epoch); time(now);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1024) fail("INVALID_REQUEST");
    let processed = 0;
    while (processed < limit) {
      const key = this.#expiry.takeDue(now);
      if (key === undefined) break;
      processed++;
      const id = key.slice(2);
      if (key.startsWith("g:")) {
        const entry = this.#registrations.get(id);
        if (!entry || entry.references) continue;
        this.#registrations.delete(id); this.#metadataBytes -= entry.bytes;
        if (this.#sessions.get(entry.value.sessionId) === id) this.#sessions.delete(entry.value.sessionId);
      } else {
        const receipt = this.#receipts.get(id);
        if (!receipt) continue;
        if (receipt.state === "forwarding") {
          this.#terminal(receipt, "unconfirmed", now);
          this.#emit("forward_unconfirmed", now, id);
        } else this.#forget(receipt);
      }
    }
    return processed;
  }

  #activeRegistration(id: string, now: number): RegistrationEntry | undefined {
    const entry = this.#registrations.get(id);
    return entry && this.#sessions.get(entry.value.sessionId) === id && Date.parse(entry.value.leaseExpiresAt) > now ? entry : undefined;
  }

  #source(envelope: RelayEnvelope, now: number): void {
    if (envelope.source.relay === RELAY_ID) {
      if (!this.#activeRegistration(envelope.source.id, now)) fail("REGISTRATION_EXPIRED");
    } else if (!this.#routes.has(envelope.source.relay)) fail("CROSS_RELAY_ENDPOINT");
  }

  #envelope(input: RelayEnvelope): RelayEnvelope {
    const envelope = captured(input, RELAY_LIMITS.HTTP_BODY_BYTES);
    if (!isRelayEnvelope(envelope) || !isRelayTimestamp(envelope.createdAt) || envelope.protocolVersion !== RELAY_PROTOCOL_VERSION
      || !keys(envelope, ["envelopeId", "protocolVersion", "source", "target", "payload", "createdAt"])
      || !keys(envelope.source, ["relay", "id"]) || !keys(envelope.target, ["relay", "id"])
      || bytes(envelope.payload) > RELAY_LIMITS.PAYLOAD_BYTES) fail("INVALID_REQUEST");
    return envelope;
  }

  #existing(envelope: RelayEnvelope, now: number): Receipt | undefined {
    const receipt = this.#receipt(envelope.envelopeId, now);
    if (receipt && receipt.digest !== createHash("sha256").update(canonicalJson(envelope)).digest("hex")) {
      this.#emit("rejected", now, envelope.envelopeId, undefined, "conflict");
      fail("ENVELOPE_CONFLICT");
    }
    return receipt;
  }

  #receipt(id: string, now: number): Receipt | undefined {
    const receipt = this.#receipts.get(id);
    if (receipt?.expiresAt !== undefined && receipt.expiresAt <= now) { this.#forget(receipt); return undefined; }
    return receipt;
  }

  #admit(envelope: RelayEnvelope, now: number, state: "mailbox" | "forwarding", cursor: string | undefined): Receipt {
    const created = Date.parse(envelope.createdAt);
    if (created > now + MEMORY_RELAY_TIMING.clockSkewMs || now >= created + MEMORY_RELAY_TIMING.deadlineMs + MEMORY_RELAY_TIMING.clockSkewMs) {
      this.#emit("rejected", now, envelope.envelopeId, undefined, "expired");
      fail("ENVELOPE_EXPIRED");
    }
    const encoded = canonicalJson(envelope), size = Buffer.byteLength(encoded);
    // Reserve a conservative encoded upper bound for fixed receipt fields,
    // including 32-digit cursor, digest, UUIDs, timestamps, counters and status.
    const reservation = bytes({ id: envelope.envelopeId, source: envelope.source, target: envelope.target }) + 1024;
    const target = state === "mailbox" ? this.#registrations.get(envelope.target.id)! : undefined;
    const peer = state === "forwarding" ? this.#routes.get(envelope.target.relay)! : undefined;
    if (this.#payloads.size >= this.#limits.activeItems || this.#activeBytes + size > this.#limits.activeBytes
      || this.#receipts.size >= this.#limits.receipts || this.#receiptBytes + reservation > this.#limits.receiptBytes
      || (target && (target.mailbox.size >= this.#limits.mailboxItems || target.mailboxBytes + size > this.#limits.mailboxBytes))
      || (peer && (peer.items >= this.#limits.peerItems || peer.payloadBytes + size > this.#limits.peerBytes))) {
      this.#emit("rejected", now, envelope.envelopeId, undefined, "capacity");
      fail("RELAY_CAPACITY");
    }
    const receipt: Receipt = { id: envelope.envelopeId, digest: createHash("sha256").update(encoded).digest("hex"),
      source: { ...envelope.source }, target: { ...envelope.target }, bytes: reservation, payloadBytes: size, cursor,
      acceptanceId: state === "mailbox" ? randomUUID() : undefined, state, attempts: 0, nextAttemptAt: now, token: undefined,
      deadline: Math.min(now + MEMORY_RELAY_TIMING.deadlineMs, created + MEMORY_RELAY_TIMING.deadlineMs + MEMORY_RELAY_TIMING.clockSkewMs), expiresAt: undefined };
    this.#receipts.set(receipt.id, receipt); this.#payloads.set(receipt.id, encoded);
    this.#activeBytes += size; this.#receiptBytes += reservation;
    for (const endpoint of [receipt.source, receipt.target]) {
      if (endpoint.relay !== RELAY_ID) continue;
      this.#registrations.get(endpoint.id)!.references++;
      this.#expiry.delete(`g:${endpoint.id}`);
    }
    if (state === "forwarding") this.#expiry.set(`r:${receipt.id}`, receipt.deadline);
    return receipt;
  }

  #terminal(receipt: Receipt, state: "acknowledged" | "forwarded" | "unconfirmed", now: number): void {
    if (this.#payloads.delete(receipt.id)) {
      this.#activeBytes -= receipt.payloadBytes;
      if (receipt.state === "mailbox") {
        const target = this.#registrations.get(receipt.target.id)!;
        target.mailbox.delete(receipt.id); target.mailboxBytes -= receipt.payloadBytes;
      } else {
        const route = this.#routes.get(receipt.target.relay)!;
        route.items--; route.payloadBytes -= receipt.payloadBytes;
      }
    }
    receipt.state = state; receipt.token = undefined;
    receipt.expiresAt = now + MEMORY_RELAY_TIMING.receiptMs;
    this.#expiry.set(`r:${receipt.id}`, receipt.expiresAt);
  }

  #forget(receipt: Receipt): void {
    this.#receipts.delete(receipt.id); this.#receiptBytes -= receipt.bytes;
    this.#expiry.delete(`r:${receipt.id}`);
    for (const endpoint of [receipt.source, receipt.target]) {
      if (endpoint.relay !== RELAY_ID) continue;
      const entry = this.#registrations.get(endpoint.id)!;
      entry.references--;
      if (!entry.references) this.#expiry.set(`g:${endpoint.id}`, Date.parse(entry.value.leaseExpiresAt));
    }
  }

  #emit(kind: RelayInvestigationEvent["kind"], now: number, envelopeId?: string, envelope?: RelayEnvelope, reason?: RelayInvestigationEvent["reason"]): void {
    if (!this.#sink) return;
    try {
      if (this.#sink.offer({ epoch: this.#epoch, at: now, kind, envelopeId, envelope, reason })) return;
    } catch { /* Investigation cannot roll back or turn acceptance into a failure. */ }
    this.#logDrops = Math.min(Number.MAX_SAFE_INTEGER, this.#logDrops + 1);
  }
}
