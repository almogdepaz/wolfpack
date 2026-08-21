import { createHash, randomUUID } from "node:crypto";
import { existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonicalTailnetOrigin } from "../tailnet-machine-contract.ts";
import {
  RELAY_ID,
  isOpaqueRelayId,
  isPeerRelayId,
  isRelayEndpoint,
  isRelayEnvelope,
  isRelayTimestamp,
} from "./domain.ts";
import type { RelayEndpoint, RelayEnvelope, RelayInboxItem, RelayRegistration } from "./domain.ts";

interface StoredEnvelope {
  readonly envelope: RelayEnvelope;
  readonly digest: string;
  readonly acceptedAt: string;
  readonly acceptanceId: string;
}

interface StoredMailboxItem {
  readonly endpointId: string;
  readonly envelopeId: string;
  readonly cursor: string;
  readonly acknowledgedAt: string | undefined;
}

export interface PeerRoute {
  readonly id: string;
  readonly origin: string;
}

export interface PeerOutboxItem {
  readonly envelope: RelayEnvelope;
  readonly peerOrigin: string;
  readonly digest: string;
  readonly acceptanceId: string;
  readonly queuedAt: string;
  readonly attempts: number;
  readonly lastAttemptAt: string | undefined;
  readonly forwardedAt: string | undefined;
  readonly exhaustedAt: string | undefined;
  readonly lastError: string | undefined;
}

interface RelayState {
  readonly version: 1;
  readonly registrations: readonly RelayRegistration[];
  readonly envelopes: readonly StoredEnvelope[];
  readonly mailbox: readonly StoredMailboxItem[];
  readonly peerRoutes: readonly PeerRoute[];
  readonly outbox: readonly PeerOutboxItem[];
}

const EMPTY: RelayState = { version: 1, registrations: [], envelopes: [], mailbox: [], peerRoutes: [], outbox: [] };
const PEER_RELAY_PREFIX = `${RELAY_ID}:peer:`;
const locks = new Map<string, Promise<void>>();

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("relay records require finite JSON numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]));
  }
  throw new TypeError("relay records require JSON values");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

interface PersistedRelayState {
  readonly version: 1;
  readonly registrations: readonly RelayRegistration[];
  readonly envelopes: readonly StoredEnvelope[];
  readonly mailbox: readonly StoredMailboxItem[];
  readonly peerRoutes?: readonly PeerRoute[];
  readonly outbox: readonly PeerOutboxItem[];
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_CURSOR_PATTERN = /^[1-9][0-9]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalTimestamp(value: unknown): value is string | undefined {
  return value === undefined || isRelayTimestamp(value);
}

function isCanonicalPeerOrigin(value: unknown): value is string {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value && url.pathname === "/"
    && url.search === "" && url.hash === "" && canonicalTailnetOrigin(url.hostname) === value;
}

function isRelayRegistration(value: unknown): value is RelayRegistration {
  if (!isRecord(value)) return false;
  return isRelayEndpoint(value.endpoint) && value.endpoint.relay === RELAY_ID
    && isNonEmptyString(value.sessionId) && isNonEmptyString(value.generation)
    && Array.isArray(value.protocolVersions) && value.protocolVersions.length > 0
    && value.protocolVersions.every(Number.isInteger) && isRelayTimestamp(value.leaseExpiresAt);
}

function hasMatchingDigest(envelope: RelayEnvelope, expected: unknown): expected is string {
  if (typeof expected !== "string" || !DIGEST_PATTERN.test(expected)) return false;
  try {
    return digest(envelope) === expected;
  } catch {
    return false;
  }
}

function isStoredEnvelope(value: unknown): value is StoredEnvelope {
  if (!isRecord(value) || !isRelayEnvelope(value.envelope)) return false;
  return Number.isInteger(value.envelope.protocolVersion)
    && value.envelope.source.relay === RELAY_ID && value.envelope.target.relay === RELAY_ID
    && hasMatchingDigest(value.envelope, value.digest)
    && isRelayTimestamp(value.acceptedAt) && isOpaqueRelayId(value.acceptanceId);
}

function isStoredMailboxItem(value: unknown): value is StoredMailboxItem {
  if (!isRecord(value)) return false;
  return isOpaqueRelayId(value.endpointId) && isNonEmptyString(value.envelopeId)
    && typeof value.cursor === "string" && DECIMAL_CURSOR_PATTERN.test(value.cursor)
    && isOptionalTimestamp(value.acknowledgedAt);
}

function isPeerRoute(value: unknown): value is PeerRoute {
  return isRecord(value) && isPeerRelayId(value.id) && isCanonicalPeerOrigin(value.origin);
}

function isPeerOutboxItem(value: unknown): value is PeerOutboxItem {
  if (!isRecord(value) || !isRelayEnvelope(value.envelope)) return false;
  return Number.isInteger(value.envelope.protocolVersion) && value.envelope.source.relay === RELAY_ID
    && isPeerRelayId(value.envelope.target.relay) && isCanonicalPeerOrigin(value.peerOrigin)
    && hasMatchingDigest(value.envelope, value.digest)
    && isOpaqueRelayId(value.acceptanceId) && isRelayTimestamp(value.queuedAt)
    && typeof value.attempts === "number" && Number.isInteger(value.attempts) && value.attempts >= 0
    && isOptionalTimestamp(value.lastAttemptAt) && isOptionalTimestamp(value.forwardedAt)
    && isOptionalTimestamp(value.exhaustedAt)
    && (value.lastError === undefined || typeof value.lastError === "string");
}

function hasValidMailboxBijection(
  mailbox: readonly StoredMailboxItem[],
  envelopes: readonly StoredEnvelope[],
): boolean {
  if (mailbox.length !== envelopes.length) return false;
  const storedEnvelopes = new Map<string, RelayEnvelope>();
  for (const item of envelopes) {
    if (storedEnvelopes.has(item.envelope.envelopeId)) return false;
    storedEnvelopes.set(item.envelope.envelopeId, item.envelope);
  }
  const mailboxEnvelopeIds = new Set<string>();
  const cursorsByEndpoint = new Map<string, Set<string>>();
  for (const item of mailbox) {
    const envelope = storedEnvelopes.get(item.envelopeId);
    if (envelope === undefined || envelope.target.id !== item.endpointId || mailboxEnvelopeIds.has(item.envelopeId)) {
      return false;
    }
    mailboxEnvelopeIds.add(item.envelopeId);
    const cursors = cursorsByEndpoint.get(item.endpointId) ?? new Set<string>();
    if (cursors.has(item.cursor)) return false;
    cursors.add(item.cursor);
    cursorsByEndpoint.set(item.endpointId, cursors);
  }
  return mailboxEnvelopeIds.size === storedEnvelopes.size;
}

function hasValidOutboxRoutes(
  outbox: readonly PeerOutboxItem[],
  peerRoutes: readonly PeerRoute[],
): boolean {
  const routes = new Map(peerRoutes.map(route => [route.id, route.origin]));
  return outbox.every(item => routes.get(item.envelope.target.relay) === item.peerOrigin);
}

function isPersistedRelayState(value: unknown): value is PersistedRelayState {
  if (!isRecord(value) || value.version !== 1) return false;
  const registrations = value.registrations;
  const envelopes = value.envelopes;
  const mailbox = value.mailbox;
  const peerRoutes = value.peerRoutes;
  const outbox = value.outbox;
  if (!Array.isArray(registrations) || !registrations.every(isRelayRegistration)) return false;
  if (!Array.isArray(envelopes) || !envelopes.every(isStoredEnvelope)) return false;
  if (!Array.isArray(mailbox) || !mailbox.every(isStoredMailboxItem)) return false;
  if (peerRoutes !== undefined && (!Array.isArray(peerRoutes) || !peerRoutes.every(isPeerRoute))) return false;
  if (!Array.isArray(outbox) || !outbox.every(isPeerOutboxItem)) return false;
  const routes = peerRoutes ?? [];
  return hasValidMailboxBijection(mailbox, envelopes) && hasValidOutboxRoutes(outbox, routes);
}

export class MalformedRelayStoreError extends TypeError {
  constructor(cause?: unknown) {
    super("relay store is malformed", cause === undefined ? undefined : { cause });
    this.name = "MalformedRelayStoreError";
  }
}

function atomicWrite(path: string, state: RelayState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(canonical(state)), "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

async function serialized<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = (locks.get(path) ?? Promise.resolve()).catch(() => undefined);
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolveRelease) => { release = resolveRelease; });
  const queued = previous.then(() => current);
  locks.set(path, queued);
  await previous;
  try { return await operation(); } finally {
    release?.();
    if (locks.get(path) === queued) locks.delete(path);
  }
}

export class TaskRelayStore {
  readonly root: string;
  readonly path: string;

  constructor(root: string | undefined = undefined) {
    this.root = resolve(root ?? join(homedir(), ".wolfpack", "pi-tasks-relay-v2"));
    this.path = join(this.root, "relay-state.json");
  }

  async register(input: Omit<RelayRegistration, "endpoint" | "leaseExpiresAt"> & { readonly endpoint: RelayEndpoint; readonly leaseExpiresAt: string }): Promise<RelayRegistration> {
    return this.#mutate((state) => {
      const existing = state.registrations.find((item) => item.sessionId === input.sessionId && item.generation === input.generation);
      const registration = existing
        ? { ...existing, protocolVersions: input.protocolVersions, leaseExpiresAt: input.leaseExpiresAt }
        : input;
      return { state: { ...state, registrations: [...state.registrations.filter((item) => item.sessionId !== input.sessionId), registration] }, value: registration };
    });
  }

  async registrationForSession(sessionId: string, now: Date): Promise<RelayRegistration | undefined> {
    return this.#read().registrations.find((item) => item.sessionId === sessionId && Date.parse(item.leaseExpiresAt) > now.getTime());
  }

  async registration(endpointId: string, now: Date): Promise<RelayRegistration | undefined> {
    return this.#read().registrations.find((item) => item.endpoint.id === endpointId && Date.parse(item.leaseExpiresAt) > now.getTime());
  }

  async deactivateRegistration(sessionId: string, endpointId: string, leaseExpiresAt: string): Promise<boolean> {
    return this.#mutate((state) => {
      const registration = state.registrations.find((item) => item.sessionId === sessionId && item.endpoint.id === endpointId);
      return {
        state: registration
          ? { ...state, registrations: state.registrations.map((item) => item === registration ? { ...item, leaseExpiresAt } : item) }
          : state,
        value: registration !== undefined,
      };
    });
  }

  async accept(envelope: RelayEnvelope, acceptedAt: string): Promise<{ readonly kind: "accepted" | "duplicate" | "conflict"; readonly acceptanceId: string }> {
    return this.#mutate<{ readonly kind: "accepted" | "duplicate" | "conflict"; readonly acceptanceId: string }>((state) => {
      const existing = state.envelopes.find((item) => item.envelope.envelopeId === envelope.envelopeId);
      const nextDigest = digest(envelope);
      if (existing) return { state, value: { kind: existing.digest === nextDigest ? "duplicate" as const : "conflict" as const, acceptanceId: existing.acceptanceId } };
      const stored: StoredEnvelope = { envelope, digest: nextDigest, acceptedAt, acceptanceId: randomUUID() };
      const cursor = (state.mailbox.filter((item) => item.endpointId === envelope.target.id)
        .reduce((maximum, item) => BigInt(item.cursor) > maximum ? BigInt(item.cursor) : maximum, 0n) + 1n).toString();
      const mailbox: StoredMailboxItem = { endpointId: envelope.target.id, envelopeId: envelope.envelopeId, cursor, acknowledgedAt: undefined };
      return { state: { ...state, envelopes: [...state.envelopes, stored], mailbox: [...state.mailbox, mailbox] }, value: { kind: "accepted" as const, acceptanceId: stored.acceptanceId } };
    });
  }

  async inbox(endpointId: string, cursor: string): Promise<readonly RelayInboxItem[]> {
    const state = this.#read();
    const envelopes = new Map(state.envelopes.map((item) => [item.envelope.envelopeId, item.envelope]));
    return state.mailbox
      .filter((item) => item.endpointId === endpointId && BigInt(item.cursor) > BigInt(cursor))
      .sort((left, right) => BigInt(left.cursor) < BigInt(right.cursor) ? -1 : 1)
      .flatMap((item) => {
        const envelope = envelopes.get(item.envelopeId);
        return envelope ? [{ cursor: item.cursor, envelope, acknowledgedAt: item.acknowledgedAt }] : [];
      });
  }

  async acknowledge(endpointId: string, envelopeId: string, at: string): Promise<"acknowledged" | "duplicate" | "missing"> {
    return this.#mutate((state) => {
      const item = state.mailbox.find((candidate) => candidate.endpointId === endpointId && candidate.envelopeId === envelopeId);
      if (!item) return { state, value: "missing" as const };
      if (item.acknowledgedAt !== undefined) return { state, value: "duplicate" as const };
      return { state: { ...state, mailbox: state.mailbox.map((candidate) => candidate === item ? { ...candidate, acknowledgedAt: at } : candidate) }, value: "acknowledged" as const };
    });
  }

  async peerRoute(origin: string): Promise<PeerRoute> {
    return this.#mutate((state) => {
      const existing = state.peerRoutes.find((item) => item.origin === origin);
      if (existing) return { state, value: existing };
      const route = { id: `${PEER_RELAY_PREFIX}${randomUUID()}`, origin };
      return { state: { ...state, peerRoutes: [...state.peerRoutes, route] }, value: route };
    });
  }

  async peerOrigin(routeId: string): Promise<string | undefined> {
    return this.#read().peerRoutes.find((item) => item.id === routeId)?.origin;
  }

  async queuePeer(input: Omit<PeerOutboxItem, "digest" | "acceptanceId">): Promise<{ readonly kind: "accepted" | "duplicate" | "conflict"; readonly acceptanceId: string }> {
    return this.#mutate<{ readonly kind: "accepted" | "duplicate" | "conflict"; readonly acceptanceId: string }>((state) => {
      const existing = state.outbox.find((item) => item.envelope.envelopeId === input.envelope.envelopeId);
      const nextDigest = digest(input.envelope);
      if (existing) return {
        state,
        value: {
          kind: existing.digest === nextDigest ? "duplicate" as const : "conflict" as const,
          acceptanceId: existing.acceptanceId,
        },
      };
      const item: PeerOutboxItem = { ...input, digest: nextDigest, acceptanceId: randomUUID() };
      return { state: { ...state, outbox: [...state.outbox, item] }, value: { kind: "accepted" as const, acceptanceId: item.acceptanceId } };
    });
  }

  async outbox(): Promise<readonly PeerOutboxItem[]> {
    return this.#read().outbox;
  }

  async updateOutbox(envelopeId: string, update: (item: PeerOutboxItem) => PeerOutboxItem): Promise<void> {
    await this.#mutate((state) => ({ state: { ...state, outbox: state.outbox.map((item) => item.envelope.envelopeId === envelopeId ? update(item) : item) }, value: undefined }));
  }

  async cleanup(before: Date): Promise<number> {
    return this.#mutate((state) => {
      const retainedMailbox = state.mailbox.filter((item) => item.acknowledgedAt === undefined || Date.parse(item.acknowledgedAt) >= before.getTime());
      const retainedIds = new Set(retainedMailbox.map((item) => item.envelopeId));
      const retainedOutbox = state.outbox.filter((item) => {
        const completedAt = item.forwardedAt ?? item.exhaustedAt;
        return completedAt === undefined || Date.parse(completedAt) >= before.getTime();
      });
      return {
        state: {
          ...state,
          mailbox: retainedMailbox,
          envelopes: state.envelopes.filter((item) => retainedIds.has(item.envelope.envelopeId)),
          outbox: retainedOutbox,
        },
        value: state.mailbox.length - retainedMailbox.length + state.outbox.length - retainedOutbox.length,
      };
    });
  }

  #read(): RelayState {
    if (!existsSync(this.path)) return EMPTY;
    const source = readFileSync(this.path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (cause) {
      throw new MalformedRelayStoreError(cause);
    }
    if (!isPersistedRelayState(parsed)) throw new MalformedRelayStoreError();
    return { ...parsed, peerRoutes: parsed.peerRoutes ?? [] };
  }

  async #mutate<T>(operation: (state: RelayState) => { readonly state: RelayState; readonly value: T }): Promise<T> {
    return serialized(this.path, async () => {
      const { state, value } = operation(this.#read());
      atomicWrite(this.path, state);
      return value;
    });
  }
}

export function newOpaqueEndpoint(): RelayEndpoint {
  return { relay: RELAY_ID, id: randomUUID() };
}
