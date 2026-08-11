import { loadConfig, remoteUrl } from "../cli/config.ts";
import { getBackend } from "../server/backend.ts";
import type { SessionInspectionResult } from "../session-status-contract.ts";
import { canonicalTailnetOrigin } from "../tailnet-machine-contract.ts";
import {
  RELAY_ERROR,
  RELAY_ID,
  RELAY_LIMITS,
  RELAY_PROTOCOL_VERSION,
  encodedJsonBytes,
  isLocalRelay,
  relayFailure,
} from "./domain.ts";
import type { RelayEndpoint, RelayEnvelope, RelayInboxItem, RelayRegistration, RelayResult } from "./domain.ts";
import { TaskRelayStore, newOpaqueEndpoint } from "./store.ts";
import type { PeerOutboxItem } from "./store.ts";

type PeerFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Inspection = Extract<SessionInspectionResult, { readonly ok: true }>;
type RetryTimer = ReturnType<typeof setInterval>;

interface GatewayOptions {
  readonly root: string | undefined;
  readonly now?: () => Date;
  readonly peerOrigin?: string;
  readonly peerFetch?: PeerFetch;
  readonly inspectSession?: (selector: string) => Promise<SessionInspectionResult>;
  readonly retryIntervalMs?: number;
}

interface ConnectInput {
  readonly callerSession: string;
  readonly generation: string;
  readonly protocolVersions: readonly number[];
  readonly leaseMs?: number;
}

function nonEmpty(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

const OPAQUE_ENDPOINT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PEER_RELAY_ID = new RegExp(`^${RELAY_ID}:peer:${OPAQUE_ENDPOINT_ID.source.slice(1, -1)}$`);

function validEndpoint(value: unknown): value is RelayEndpoint {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && nonEmpty((value as Record<string, unknown>).relay) && typeof (value as Record<string, unknown>).id === "string"
    && OPAQUE_ENDPOINT_ID.test((value as Record<string, unknown>).id as string);
}

function validEnvelope(value: unknown): value is RelayEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return nonEmpty(envelope.envelopeId) && typeof envelope.protocolVersion === "number" && validEndpoint(envelope.source)
    && validEndpoint(envelope.target) && typeof envelope.createdAt === "string" && envelope.payload !== undefined;
}

function validPeerRelay(value: string): boolean {
  return PEER_RELAY_ID.test(value);
}

export class TaskRelayGateway {
  readonly #store: TaskRelayStore;
  readonly #now: () => Date;
  readonly #peerOrigin: string | undefined;
  readonly #peerFetch: PeerFetch;
  readonly #inspectSession: (selector: string) => Promise<SessionInspectionResult>;
  readonly #retryIntervalMs: number;
  #retryTimer: RetryTimer | undefined;
  #initialization: Promise<void> | undefined;
  readonly #forwarding = new Map<string, Promise<boolean>>();

  constructor(options: GatewayOptions = { root: undefined }) {
    this.#store = new TaskRelayStore(options.root);
    this.#now = options.now ?? (() => new Date());
    this.#peerOrigin = options.peerOrigin;
    this.#peerFetch = options.peerFetch ?? fetch;
    this.#inspectSession = options.inspectSession ?? (async (selector) => {
      const inspect = getBackend().inspectSession;
      return inspect ? inspect.call(getBackend(), selector) : { ok: false, code: "NOT_FOUND" };
    });
    this.#retryIntervalMs = options.retryIntervalMs ?? RELAY_LIMITS.FORWARD_RETRY_MS;
  }

  get root(): string {
    return this.#store.root;
  }

  /** Starts restart recovery and bounded background retry for durable peer outbox records. */
  async initialize(): Promise<void> {
    this.#initialization ??= (async () => {
      try {
        await this.flushPeerOutbox(true);
      } finally {
        this.#retryTimer ??= setInterval(() => {
          void this.flushPeerOutbox().catch(() => undefined);
        }, this.#retryIntervalMs);
        this.#retryTimer.unref?.();
      }
    })();
    await this.#initialization;
  }

  close(): void {
    if (this.#retryTimer) clearInterval(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#initialization = undefined;
  }

  async peerRelay(origin: string): Promise<string> {
    let url: URL;
    try { url = new URL(origin); } catch { throw new TypeError("peer relay origin must be a canonical Tailnet HTTPS origin"); }
    const canonicalOrigin = canonicalTailnetOrigin(url.hostname);
    if (url.protocol !== "https:" || url.origin !== origin || url.pathname !== "/" || url.search !== "" || url.hash !== "" || canonicalOrigin !== origin) {
      throw new TypeError("peer relay origin must be a canonical Tailnet HTTPS origin");
    }
    return (await this.#store.peerRoute(origin)).id;
  }

  async resolvePeerEndpoint(input: { readonly origin: string; readonly endpoint: RelayEndpoint }): Promise<RelayResult<{ readonly endpoint: RelayEndpoint }>> {
    if (!validEndpoint(input.endpoint) || !isLocalRelay(input.endpoint)) {
      return relayFailure(RELAY_ERROR.INVALID_REQUEST, "peer topology requires a local opaque endpoint");
    }
    try {
      return { ok: true, endpoint: { relay: await this.peerRelay(input.origin), id: input.endpoint.id } };
    } catch {
      return relayFailure(RELAY_ERROR.INVALID_REQUEST, "peer relay origin must be a canonical Tailnet HTTPS origin");
    }
  }

  async connect(input: ConnectInput): Promise<RelayResult<{ readonly endpoint: RelayEndpoint; readonly leaseExpiresAt: string }>> {
    if (!nonEmpty(input.callerSession) || !nonEmpty(input.generation) || !Array.isArray(input.protocolVersions)
      || input.protocolVersions.length === 0 || !input.protocolVersions.every(Number.isInteger)) {
      return relayFailure(RELAY_ERROR.INVALID_REQUEST, "invalid relay registration");
    }
    if (!input.protocolVersions.includes(RELAY_PROTOCOL_VERSION)) {
      return relayFailure(RELAY_ERROR.INCOMPATIBLE_PROTOCOL, "relay does not support a requested protocol version");
    }
    const caller = await this.#caller(input.callerSession);
    if (!caller.ok) return caller;
    const existing = await this.#store.registrationForSession(caller.value.sessionId, this.#now());
    const leaseMs = input.leaseMs ?? RELAY_LIMITS.LEASE_MS;
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > RELAY_LIMITS.MAX_LEASE_MS) {
      return relayFailure(RELAY_ERROR.INVALID_REQUEST, "invalid registration lease");
    }
    const registration: RelayRegistration = {
      endpoint: existing?.generation === input.generation ? existing.endpoint : newOpaqueEndpoint(),
      sessionId: caller.value.sessionId,
      generation: input.generation,
      protocolVersions: [...new Set(input.protocolVersions)].sort((left, right) => left - right),
      leaseExpiresAt: new Date(this.#now().getTime() + leaseMs).toISOString(),
    };
    const persisted = await this.#store.register(registration);
    return { ok: true, endpoint: persisted.endpoint, leaseExpiresAt: persisted.leaseExpiresAt };
  }

  async endpointForSession(sessionId: string): Promise<RelayEndpoint | undefined> {
    return (await this.#store.registrationForSession(sessionId, this.#now()))?.endpoint;
  }

  async disconnect(input: { readonly callerSession: string; readonly endpoint: RelayEndpoint }): Promise<RelayResult<Record<never, never>>> {
    if (!validEndpoint(input.endpoint)) return relayFailure(RELAY_ERROR.INVALID_REQUEST, "invalid relay endpoint");
    const caller = await this.#caller(input.callerSession);
    if (!caller.ok) return caller;
    const registration = await this.#store.registration(input.endpoint.id, this.#now());
    if (!registration || registration.sessionId !== caller.value.sessionId || !isLocalRelay(input.endpoint)) {
      return relayFailure(RELAY_ERROR.SOURCE_MISMATCH, "caller does not own relay endpoint");
    }
    await this.#store.deactivateRegistration(caller.value.sessionId, input.endpoint.id, this.#now().toISOString());
    return { ok: true };
  }

  async resolve(input: { readonly callerSession: string; readonly target: RelayEndpoint; readonly protocolVersion: number }): Promise<RelayResult<{ readonly endpoint: RelayEndpoint }>> {
    const caller = await this.#caller(input.callerSession);
    if (!caller.ok) return caller;
    if (!validEndpoint(input.target) || input.protocolVersion !== RELAY_PROTOCOL_VERSION) {
      return relayFailure(RELAY_ERROR.INCOMPATIBLE_PROTOCOL, "invalid or incompatible relay target");
    }
    if (!isLocalRelay(input.target)) {
      if (!validPeerRelay(input.target.relay) || await this.#store.peerOrigin(input.target.relay) === undefined) {
        return relayFailure(RELAY_ERROR.CROSS_RELAY_ENDPOINT, "endpoint belongs to another relay");
      }
      return { ok: true, endpoint: input.target };
    }
    const target = await this.#store.registration(input.target.id, this.#now());
    if (!target || !target.protocolVersions.includes(input.protocolVersion)) {
      return relayFailure(RELAY_ERROR.TARGET_NOT_REGISTERED, "target endpoint is not actively registered");
    }
    return { ok: true, endpoint: target.endpoint };
  }

  async send(input: { readonly callerSession: string; readonly envelope: RelayEnvelope }): Promise<RelayResult<{ readonly kind: "accepted" | "duplicate"; readonly acceptanceId: string; readonly forwarding: "local" | "forwarded" | "pending" }>> {
    if (!validEnvelope(input.envelope)) return relayFailure(RELAY_ERROR.INVALID_REQUEST, "invalid relay envelope");
    if (input.envelope.protocolVersion !== RELAY_PROTOCOL_VERSION) return relayFailure(RELAY_ERROR.INCOMPATIBLE_PROTOCOL, "unsupported envelope protocol version");
    if (encodedJsonBytes(input.envelope.payload) > RELAY_LIMITS.PAYLOAD_BYTES) return relayFailure(RELAY_ERROR.PAYLOAD_TOO_LARGE, "relay payload exceeds byte limit");
    const caller = await this.#caller(input.callerSession);
    if (!caller.ok) return caller;
    const source = await this.#store.registration(input.envelope.source.id, this.#now());
    if (!source) return relayFailure(RELAY_ERROR.REGISTRATION_EXPIRED, "source endpoint registration is absent or expired");
    if (source.sessionId !== caller.value.sessionId || source.generation.length === 0 || !isLocalRelay(input.envelope.source)) {
      return relayFailure(RELAY_ERROR.SOURCE_MISMATCH, "caller does not own envelope source endpoint");
    }
    if (isLocalRelay(input.envelope.target)) {
      const target = await this.#store.registration(input.envelope.target.id, this.#now());
      if (!target || !target.protocolVersions.includes(input.envelope.protocolVersion)) {
        return relayFailure(RELAY_ERROR.TARGET_NOT_REGISTERED, "target endpoint is not actively registered");
      }
      const accepted = await this.#store.accept(input.envelope, this.#now().toISOString());
      if (accepted.kind === "conflict") return relayFailure(RELAY_ERROR.ENVELOPE_CONFLICT, "envelope id conflicts with durable content");
      return { ok: true, kind: accepted.kind, acceptanceId: accepted.acceptanceId, forwarding: "local" };
    }
    if (!validPeerRelay(input.envelope.target.relay)) {
      return relayFailure(RELAY_ERROR.CROSS_RELAY_ENDPOINT, "target endpoint belongs to another relay");
    }
    const peerOrigin = await this.#store.peerOrigin(input.envelope.target.relay);
    if (!peerOrigin) return relayFailure(RELAY_ERROR.CROSS_RELAY_ENDPOINT, "target endpoint belongs to another relay");
    const accepted = await this.#store.queuePeer({
      envelope: input.envelope,
      peerOrigin,
      queuedAt: this.#now().toISOString(),
      attempts: 0,
      lastAttemptAt: undefined,
      forwardedAt: undefined,
      exhaustedAt: undefined,
      lastError: undefined,
    });
    if (accepted.kind === "conflict") return relayFailure(RELAY_ERROR.ENVELOPE_CONFLICT, "envelope id conflicts with durable content");
    const forwarded = await this.#forwardEnvelope(input.envelope.envelopeId);
    return { ok: true, kind: accepted.kind, acceptanceId: accepted.acceptanceId, forwarding: forwarded ? "forwarded" : "pending" };
  }

  async receive(input: { readonly callerSession: string; readonly cursor: string }): Promise<RelayResult<{ readonly envelopes: readonly RelayEnvelope[]; readonly nextCursor: string; readonly hasMore: boolean }>> {
    if (!/^(0|[1-9][0-9]*)$/.test(input.cursor)) return relayFailure(RELAY_ERROR.INVALID_REQUEST, "invalid relay inbox cursor");
    const endpoint = await this.#endpointForCaller(input.callerSession);
    if (!endpoint.ok) return endpoint;
    const items = await this.#store.inbox(endpoint.endpoint.id, input.cursor);
    const page: RelayInboxItem[] = [];
    let bytes = 0;
    for (const item of items) {
      const itemBytes = encodedJsonBytes(item.envelope);
      if (page.length === RELAY_LIMITS.INBOX_PAGE_ITEMS || bytes + itemBytes > RELAY_LIMITS.INBOX_PAGE_BYTES) break;
      page.push(item);
      bytes += itemBytes;
    }
    return { ok: true, envelopes: page.map((item) => item.envelope), nextCursor: page.at(-1)?.cursor ?? input.cursor, hasMore: page.length < items.length };
  }

  async acknowledgeDelivery(input: { readonly callerSession: string; readonly envelopeId: string }): Promise<RelayResult<{ readonly kind: "acknowledged" | "duplicate" }>> {
    if (!nonEmpty(input.envelopeId)) return relayFailure(RELAY_ERROR.INVALID_REQUEST, "invalid relay delivery acknowledgement");
    const endpoint = await this.#endpointForCaller(input.callerSession);
    if (!endpoint.ok) return endpoint;
    const result = await this.#store.acknowledge(endpoint.endpoint.id, input.envelopeId, this.#now().toISOString());
    if (result === "missing") return relayFailure(RELAY_ERROR.INVALID_REQUEST, "envelope is not in caller mailbox");
    return { ok: true, kind: result };
  }

  /** Peer input is admitted by Wolfpack's inherited trusted-Tailnet HTTP policy. */
  async receivePeer(input: unknown): Promise<RelayResult<{ readonly kind: "accepted" | "duplicate"; readonly acceptanceId: string }>> {
    if (!validEnvelope(input) || input.protocolVersion !== RELAY_PROTOCOL_VERSION || !isLocalRelay(input.target)
      || !isLocalRelay(input.source) || encodedJsonBytes(input.payload) > RELAY_LIMITS.PAYLOAD_BYTES) {
      return relayFailure(RELAY_ERROR.INVALID_REQUEST, "invalid peer relay envelope");
    }
    const target = await this.#store.registration(input.target.id, this.#now());
    if (!target || !target.protocolVersions.includes(input.protocolVersion)) {
      return relayFailure(RELAY_ERROR.TARGET_NOT_REGISTERED, "peer target endpoint is not actively registered");
    }
    const accepted = await this.#store.accept(input, this.#now().toISOString());
    if (accepted.kind === "conflict") return relayFailure(RELAY_ERROR.ENVELOPE_CONFLICT, "peer envelope id conflicts with durable content");
    return { ok: true, kind: accepted.kind, acceptanceId: accepted.acceptanceId };
  }

  async flushPeerOutbox(recoverImmediately = false): Promise<{ readonly forwarded: number; readonly pending: number }> {
    let forwarded = 0;
    for (const item of await this.#store.outbox()) {
      if (item.forwardedAt !== undefined || item.exhaustedAt !== undefined) continue;
      if (await this.#forwardEnvelope(item.envelope.envelopeId, recoverImmediately)) forwarded += 1;
    }
    const pending = (await this.#store.outbox()).filter((item) => item.forwardedAt === undefined && item.exhaustedAt === undefined).length;
    return { forwarded, pending };
  }

  async cleanup(before: Date): Promise<number> {
    return this.#store.cleanup(before);
  }

  async #forwardEnvelope(envelopeId: string, recoverImmediately = false): Promise<boolean> {
    const inFlight = this.#forwarding.get(envelopeId);
    if (inFlight) return inFlight;
    let forwarding: Promise<boolean>;
    forwarding = this.#forwardEnvelopeOnce(envelopeId, recoverImmediately).finally(() => {
      if (this.#forwarding.get(envelopeId) === forwarding) this.#forwarding.delete(envelopeId);
    });
    this.#forwarding.set(envelopeId, forwarding);
    return forwarding;
  }

  async #forwardEnvelopeOnce(envelopeId: string, recoverImmediately = false): Promise<boolean> {
    const item = (await this.#store.outbox()).find((candidate) => candidate.envelope.envelopeId === envelopeId);
    if (!item || item.forwardedAt !== undefined || item.exhaustedAt !== undefined) return item?.forwardedAt !== undefined;
    if (item.attempts >= RELAY_LIMITS.MAX_FORWARD_ATTEMPTS) {
      await this.#store.updateOutbox(envelopeId, (current) => current.exhaustedAt === undefined
        ? { ...current, exhaustedAt: this.#now().toISOString() }
        : current);
      return false;
    }
    const retryAfter = item.lastAttemptAt === undefined ? undefined : Date.parse(item.lastAttemptAt) + this.#retryIntervalMs;
    if (!recoverImmediately && retryAfter !== undefined && this.#now().getTime() < retryAfter) return false;
    const attemptedAt = this.#now().toISOString();
    const attempts = item.attempts + 1;
    await this.#store.updateOutbox(envelopeId, (current) => ({ ...current, attempts, lastAttemptAt: attemptedAt }));
    if (!this.#peerOrigin || canonicalTailnetOrigin(new URL(this.#peerOrigin).hostname) !== this.#peerOrigin) {
      await this.#store.updateOutbox(envelopeId, (current) => ({
        ...current,
        lastError: "local peer origin unavailable",
        ...(attempts >= RELAY_LIMITS.MAX_FORWARD_ATTEMPTS && { exhaustedAt: this.#now().toISOString() }),
      }));
      return false;
    }
    try {
      const response = await this.#peerFetch(`${item.peerOrigin}/api/task-relay/v2/peer/receive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.#peerEnvelope(item)),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      const payload = await response.json() as unknown;
      if (!response.ok || typeof payload !== "object" || payload === null || (payload as { ok?: unknown }).ok !== true) throw new Error("peer rejected relay envelope");
      await this.#store.updateOutbox(envelopeId, (current) => ({ ...current, forwardedAt: this.#now().toISOString(), lastError: undefined }));
      return true;
    } catch {
      await this.#store.updateOutbox(envelopeId, (current) => ({
        ...current,
        lastError: "peer unavailable",
        ...(attempts >= RELAY_LIMITS.MAX_FORWARD_ATTEMPTS && { exhaustedAt: this.#now().toISOString() }),
      }));
      return false;
    }
  }

  #peerEnvelope(item: PeerOutboxItem): RelayEnvelope {
    return {
      ...item.envelope,
      source: { ...item.envelope.source, relay: RELAY_ID },
      target: { ...item.envelope.target, relay: RELAY_ID },
    };
  }

  async #endpointForCaller(callerSession: string): Promise<RelayResult<{ readonly endpoint: RelayEndpoint }>> {
    const caller = await this.#caller(callerSession);
    if (!caller.ok) return caller;
    const registration = await this.#store.registrationForSession(caller.value.sessionId, this.#now());
    if (!registration) return relayFailure(RELAY_ERROR.REGISTRATION_EXPIRED, "caller has no active relay registration");
    return { ok: true, endpoint: registration.endpoint };
  }

  async #caller(selector: string): Promise<RelayResult<{ readonly value: Inspection }>> {
    if (!nonEmpty(selector)) return relayFailure(RELAY_ERROR.CALLER_NOT_FOUND, "caller session is required");
    let inspected: SessionInspectionResult;
    try { inspected = await this.#inspectSession(selector); } catch { return relayFailure(RELAY_ERROR.STORE_UNAVAILABLE, "session inspection is unavailable", true); }
    if (!inspected.ok) return relayFailure(RELAY_ERROR.CALLER_NOT_FOUND, "caller session was not found");
    if (!inspected.alive) return relayFailure(RELAY_ERROR.CALLER_DEAD, "caller session is not alive");
    return { ok: true, value: inspected };
  }
}

let singleton: TaskRelayGateway | undefined;

export function getTaskRelayGateway(): TaskRelayGateway {
  const config = loadConfig();
  singleton ??= new TaskRelayGateway({
    root: process.env.WOLFPACK_TASK_RELAY_ROOT,
    peerOrigin: config ? remoteUrl(config) ?? undefined : undefined,
  });
  return singleton;
}

export function __setTaskRelayGatewayForTests(gateway: TaskRelayGateway): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("task relay gateway setup is test-only");
  singleton?.close();
  singleton = gateway;
}

export function __resetTaskRelayGatewayForTests(): void {
  if (!process.env.WOLFPACK_TEST) throw new Error("task relay gateway reset is test-only");
  singleton?.close();
  singleton = undefined;
}
