import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonicalJson } from "../canonical-json.ts";
import { canonicalTailnetOrigin } from "../tailnet-machine-contract.ts";
import {
  RELAY_ID,
  RELAY_LIMITS,
  encodedJsonBytes,
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

interface StoredMailboxCursor {
  readonly endpointId: string;
  readonly cursor: string;
}

export interface PeerRoute {
  readonly id: string;
  readonly origin: string;
}

export interface RelayInboxPage {
  readonly items: readonly RelayInboxItem[];
  readonly hasMore: boolean;
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
  readonly version: 2;
  readonly registrations: readonly RelayRegistration[];
  readonly envelopes: readonly StoredEnvelope[];
  readonly mailbox: readonly StoredMailboxItem[];
  readonly mailboxCursors: readonly StoredMailboxCursor[];
  readonly peerRoutes: readonly PeerRoute[];
  readonly outbox: readonly PeerOutboxItem[];
}

interface PersistedRelayStateV2 {
  readonly version: 2;
  readonly registrations: readonly RelayRegistration[];
  readonly envelopes: readonly StoredEnvelope[];
  readonly mailbox: readonly StoredMailboxItem[];
  readonly mailboxCursors?: readonly StoredMailboxCursor[];
  readonly peerRoutes: readonly PeerRoute[];
  readonly outbox: readonly PeerOutboxItem[];
}

const EMPTY: RelayState = { version: 2, registrations: [], envelopes: [], mailbox: [], mailboxCursors: [], peerRoutes: [], outbox: [] };
const PEER_RELAY_PREFIX = `${RELAY_ID}:peer:`;
const locks = new Map<string, Promise<void>>();
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_CURSOR_PATTERN = /^[1-9][0-9]*$/;

/**
 * A store instance observes external writers only when they atomically replace or
 * remove/recreate relay-state.json. Same-process writers are serialized below;
 * independent processes must coordinate a single writer because this JSON store
 * has no cross-process compare-and-swap. Direct in-place edits are unsupported:
 * they can defeat file identity checks and were never a safe mutation protocol.
 * An idle second instance may retain its prior immutable snapshot until its next
 * access or collection; there is no process-global strong cache/eager invalidator.
 */
interface FileVersion {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface RelaySnapshot {
  readonly state: RelayState;
  readonly version: FileVersion | undefined;
  readonly registrationBySession: ReadonlyMap<string, RelayRegistration>;
  readonly registrationByEndpoint: ReadonlyMap<string, RelayRegistration>;
  readonly peerOriginByRoute: ReadonlyMap<string, string>;
  readonly envelopeById: ReadonlyMap<string, StoredEnvelope>;
  readonly mailboxByEndpoint: ReadonlyMap<string, readonly StoredMailboxItem[]>;
  readonly outboxByEnvelopeId: ReadonlyMap<string, PeerOutboxItem>;
  readonly pendingOutboxCount: number;
}

function digestJson(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digest(value: unknown): string {
  return digestJson(canonicalJson(value));
}

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
    && (value.envelope.source.relay === RELAY_ID || isPeerRelayId(value.envelope.source.relay))
    && value.envelope.target.relay === RELAY_ID
    && hasMatchingDigest(value.envelope, value.digest)
    && isRelayTimestamp(value.acceptedAt) && isOpaqueRelayId(value.acceptanceId);
}

function isStoredMailboxItem(value: unknown): value is StoredMailboxItem {
  if (!isRecord(value)) return false;
  return isOpaqueRelayId(value.endpointId) && isNonEmptyString(value.envelopeId)
    && typeof value.cursor === "string" && DECIMAL_CURSOR_PATTERN.test(value.cursor)
    && isOptionalTimestamp(value.acknowledgedAt);
}

function isStoredMailboxCursor(value: unknown): value is StoredMailboxCursor {
  return isRecord(value) && isOpaqueRelayId(value.endpointId)
    && typeof value.cursor === "string" && DECIMAL_CURSOR_PATTERN.test(value.cursor);
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

function hasValidMailboxCursors(
  mailbox: readonly StoredMailboxItem[],
  mailboxCursors: readonly StoredMailboxCursor[],
): boolean {
  const cursors = new Map<string, bigint>();
  for (const item of mailboxCursors) {
    if (cursors.has(item.endpointId)) return false;
    cursors.set(item.endpointId, BigInt(item.cursor));
  }
  return mailbox.every(item => (cursors.get(item.endpointId) ?? 0n) >= BigInt(item.cursor));
}

function mailboxCursorWatermarks(mailbox: readonly StoredMailboxItem[]): readonly StoredMailboxCursor[] {
  const cursors = new Map<string, bigint>();
  for (const item of mailbox) {
    const cursor = BigInt(item.cursor);
    if (cursor > (cursors.get(item.endpointId) ?? 0n)) cursors.set(item.endpointId, cursor);
  }
  return [...cursors].map(([endpointId, cursor]) => ({ endpointId, cursor: cursor.toString() }));
}

function addLocalEndpointReference(references: Set<string>, endpoint: RelayEndpoint): void {
  if (endpoint.relay === RELAY_ID) references.add(endpoint.id);
}

function hasValidEnvelopeRoutes(
  envelopes: readonly StoredEnvelope[],
  peerRoutes: readonly PeerRoute[],
): boolean {
  const routes = new Set(peerRoutes.map(route => route.id));
  return envelopes.every(item => item.envelope.source.relay === RELAY_ID || routes.has(item.envelope.source.relay));
}

function hasValidOutboxRoutes(
  outbox: readonly PeerOutboxItem[],
  peerRoutes: readonly PeerRoute[],
): boolean {
  const routes = new Map(peerRoutes.map(route => [route.id, route.origin]));
  return outbox.every(item => routes.get(item.envelope.target.relay) === item.peerOrigin);
}

function isPersistedRelayStateV2(value: unknown): value is PersistedRelayStateV2 {
  if (!isRecord(value) || value.version !== 2) return false;
  const registrations = value.registrations;
  const envelopes = value.envelopes;
  const mailbox = value.mailbox;
  const mailboxCursors = value.mailboxCursors;
  const peerRoutes = value.peerRoutes;
  const outbox = value.outbox;
  if (!Array.isArray(registrations) || !registrations.every(isRelayRegistration)) return false;
  if (!Array.isArray(envelopes) || !envelopes.every(isStoredEnvelope)) return false;
  if (!Array.isArray(mailbox) || !mailbox.every(isStoredMailboxItem)) return false;
  if (mailboxCursors !== undefined && (!Array.isArray(mailboxCursors) || !mailboxCursors.every(isStoredMailboxCursor))) return false;
  if (!Array.isArray(peerRoutes) || !peerRoutes.every(isPeerRoute)) return false;
  if (!Array.isArray(outbox) || !outbox.every(isPeerOutboxItem)) return false;
  return hasValidMailboxBijection(mailbox, envelopes)
    && (mailboxCursors === undefined || hasValidMailboxCursors(mailbox, mailboxCursors))
    && hasValidEnvelopeRoutes(envelopes, peerRoutes)
    && hasValidOutboxRoutes(outbox, peerRoutes);
}

function parsePersistedRelayState(value: unknown): RelayState | "reset" | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version === 1) return "reset";
  if (value.version === 2 && isPersistedRelayStateV2(value)) {
    return { ...value, mailboxCursors: value.mailboxCursors ?? mailboxCursorWatermarks(value.mailbox) };
  }
  return undefined;
}

export class MalformedRelayStoreError extends TypeError {
  constructor(cause?: unknown) {
    super("relay store is malformed", cause === undefined ? undefined : { cause });
    this.name = "MalformedRelayStoreError";
  }
}

function atomicWrite(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(descriptor, source, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function fileVersion(path: string): FileVersion | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

function sameFileVersion(left: FileVersion | undefined, right: FileVersion | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function freeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const item of Object.values(value)) freeze(item);
  Object.freeze(value);
}

function immutableCopy<T>(value: T): T {
  const copy = JSON.parse(canonicalJson(value)) as T;
  freeze(copy);
  return copy;
}

function firstBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T> {
  const index = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (!index.has(id)) index.set(id, value);
  }
  return index;
}

function snapshot(state: RelayState, version: FileVersion | undefined): RelaySnapshot {
  freeze(state);
  // Persisted validation permits duplicate registrations, routes, and outbox
  // IDs. Array callers historically use find(), so indexes deliberately retain
  // the first entry instead of introducing last-write-wins behavior.
  const registrationBySession = firstBy(state.registrations, item => item.sessionId);
  const registrationByEndpoint = firstBy(state.registrations, item => item.endpoint.id);
  const peerOriginByRoute = new Map([...firstBy(state.peerRoutes, item => item.id)].map(([id, route]) => [id, route.origin]));
  const envelopeById = new Map(state.envelopes.map(item => [item.envelope.envelopeId, item]));
  const mailboxByEndpoint = new Map<string, StoredMailboxItem[]>();
  for (const item of state.mailbox) {
    const mailbox = mailboxByEndpoint.get(item.endpointId) ?? [];
    mailbox.push(item);
    mailboxByEndpoint.set(item.endpointId, mailbox);
  }
  for (const mailbox of mailboxByEndpoint.values()) mailbox.sort((left, right) => BigInt(left.cursor) < BigInt(right.cursor) ? -1 : 1);
  return {
    state,
    version,
    registrationBySession,
    registrationByEndpoint,
    peerOriginByRoute,
    envelopeById,
    mailboxByEndpoint,
    outboxByEnvelopeId: firstBy(state.outbox, item => item.envelope.envelopeId),
    pendingOutboxCount: state.outbox.filter(item => item.forwardedAt === undefined && item.exhaustedAt === undefined).length,
  };
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
  #snapshot: RelaySnapshot | undefined;

  constructor(root: string | undefined = undefined) {
    this.root = resolve(root ?? join(homedir(), ".wolfpack", "pi-tasks-relay-v2"));
    this.path = join(this.root, "relay-state.json");
  }

  async register(input: Omit<RelayRegistration, "endpoint" | "leaseExpiresAt"> & { readonly endpoint: RelayEndpoint; readonly leaseExpiresAt: string }): Promise<RelayRegistration> {
    // Copy before #mutate yields on the per-path queue: callers may mutate the
    // object immediately after receiving this Promise.
    const ownedInput = immutableCopy(input);
    const registered = await this.#mutate((state) => {
      const existing = state.registrations.find((item) => item.sessionId === ownedInput.sessionId && item.generation === ownedInput.generation);
      const registration = existing
        ? { ...existing, protocolVersions: ownedInput.protocolVersions, leaseExpiresAt: ownedInput.leaseExpiresAt }
        : ownedInput;
      if (existing && canonicalJson(existing) === canonicalJson(registration)) return { state, value: existing };
      return { state: { ...state, registrations: [...state.registrations.filter((item) => item.sessionId !== ownedInput.sessionId), registration] }, value: registration };
    });
    // Return the owned, persisted snapshot rather than an input alias.
    return this.#read().registrationBySession.get(registered.sessionId) ?? immutableCopy(registered);
  }

  async registrationForSession(sessionId: string, now: Date): Promise<RelayRegistration | undefined> {
    const registration = this.#read().registrationBySession.get(sessionId);
    return registration && Date.parse(registration.leaseExpiresAt) > now.getTime() ? registration : undefined;
  }

  async registrationsForSessions(sessionIds: readonly string[], now: Date): Promise<ReadonlyMap<string, RelayRegistration>> {
    const registrations = new Map<string, RelayRegistration>();
    const snapshot = this.#read();
    for (const sessionId of sessionIds) {
      const registration = snapshot.registrationBySession.get(sessionId);
      if (registration && Date.parse(registration.leaseExpiresAt) > now.getTime()) registrations.set(sessionId, registration);
    }
    return registrations;
  }

  async registration(endpointId: string, now: Date): Promise<RelayRegistration | undefined> {
    const registration = this.#read().registrationByEndpoint.get(endpointId);
    return registration && Date.parse(registration.leaseExpiresAt) > now.getTime() ? registration : undefined;
  }

  async deactivateRegistration(sessionId: string, endpointId: string, leaseExpiresAt: string): Promise<boolean> {
    return this.#mutate((state) => {
      const registration = state.registrations.find((item) => item.sessionId === sessionId && item.endpoint.id === endpointId);
      return {
        state: registration && registration.leaseExpiresAt !== leaseExpiresAt
          ? { ...state, registrations: state.registrations.map((item) => item === registration ? { ...item, leaseExpiresAt } : item) }
          : state,
        value: registration !== undefined,
      };
    });
  }

  async accept(envelope: RelayEnvelope, acceptedAt: string): Promise<{ readonly kind: "accepted" | "duplicate" | "conflict"; readonly acceptanceId: string }> {
    const ownedEnvelope = immutableCopy(envelope);
    return this.#mutate<{ readonly kind: "accepted" | "duplicate" | "conflict"; readonly acceptanceId: string }>((state) => {
      const existing = state.envelopes.find((item) => item.envelope.envelopeId === ownedEnvelope.envelopeId);
      const nextDigest = digest(ownedEnvelope);
      if (existing) return { state, value: { kind: existing.digest === nextDigest ? "duplicate" as const : "conflict" as const, acceptanceId: existing.acceptanceId } };
      const stored: StoredEnvelope = { envelope: ownedEnvelope, digest: nextDigest, acceptedAt, acceptanceId: randomUUID() };
      const previousCursor = state.mailboxCursors.find(item => item.endpointId === ownedEnvelope.target.id)?.cursor ?? "0";
      const cursor = (BigInt(previousCursor) + 1n).toString();
      const mailbox: StoredMailboxItem = { endpointId: ownedEnvelope.target.id, envelopeId: ownedEnvelope.envelopeId, cursor, acknowledgedAt: undefined };
      const mailboxCursor = { endpointId: ownedEnvelope.target.id, cursor };
      return {
        state: {
          ...state,
          envelopes: [...state.envelopes, stored],
          mailbox: [...state.mailbox, mailbox],
          mailboxCursors: [...state.mailboxCursors.filter(item => item.endpointId !== ownedEnvelope.target.id), mailboxCursor],
        },
        value: { kind: "accepted" as const, acceptanceId: stored.acceptanceId },
      };
    });
  }

  async inbox(endpointId: string, cursor: string): Promise<RelayInboxPage> {
    const snapshot = this.#read();
    const mailbox = snapshot.mailboxByEndpoint.get(endpointId) ?? [];
    const requestedCursor = BigInt(cursor);
    let first = 0;
    let last = mailbox.length;
    while (first < last) {
      const middle = first + Math.floor((last - first) / 2);
      if (BigInt(mailbox[middle]!.cursor) <= requestedCursor) first = middle + 1;
      else last = middle;
    }
    const matchingItems = mailbox.length - first;
    const selectedMailbox = mailbox.slice(first, first + RELAY_LIMITS.INBOX_PAGE_ITEMS);
    const items: RelayInboxItem[] = [];
    let bytes = 0;
    for (const item of selectedMailbox) {
      const envelope = snapshot.envelopeById.get(item.envelopeId)?.envelope;
      if (envelope === undefined) continue;
      const itemBytes = encodedJsonBytes(envelope);
      if (bytes + itemBytes > RELAY_LIMITS.INBOX_PAGE_BYTES) break;
      items.push({ cursor: item.cursor, envelope, acknowledgedAt: item.acknowledgedAt });
      bytes += itemBytes;
    }
    return { items, hasMore: items.length < matchingItems };
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
    return this.#read().peerOriginByRoute.get(routeId);
  }

  async queuePeer(input: Omit<PeerOutboxItem, "digest" | "acceptanceId">): Promise<{ readonly kind: "accepted" | "duplicate" | "conflict"; readonly acceptanceId: string }> {
    const ownedInput = immutableCopy(input);
    return this.#mutate<{ readonly kind: "accepted" | "duplicate" | "conflict"; readonly acceptanceId: string }>((state) => {
      const existing = state.outbox.find((item) => item.envelope.envelopeId === ownedInput.envelope.envelopeId);
      const nextDigest = digest(ownedInput.envelope);
      if (existing) return {
        state,
        value: {
          kind: existing.digest === nextDigest ? "duplicate" as const : "conflict" as const,
          acceptanceId: existing.acceptanceId,
        },
      };
      const item: PeerOutboxItem = { ...ownedInput, digest: nextDigest, acceptanceId: randomUUID() };
      return { state: { ...state, outbox: [...state.outbox, item] }, value: { kind: "accepted" as const, acceptanceId: item.acceptanceId } };
    });
  }

  async outbox(): Promise<readonly PeerOutboxItem[]> {
    return this.#read().state.outbox;
  }

  async outboxItem(envelopeId: string): Promise<PeerOutboxItem | undefined> {
    return this.#read().outboxByEnvelopeId.get(envelopeId);
  }

  async pendingOutboxCount(): Promise<number> {
    return this.#read().pendingOutboxCount;
  }

  async updateOutbox(envelopeId: string, update: (item: PeerOutboxItem) => PeerOutboxItem): Promise<void> {
    await this.#mutate((state) => {
      let changed = false;
      const outbox = state.outbox.map((item) => {
        if (item.envelope.envelopeId !== envelopeId) return item;
        // Callers receive a detached immutable item, and their result is copied
        // before this synchronous mutation operation can yield to persistence.
        const next = immutableCopy(update(immutableCopy(item)));
        if (canonicalJson(next) === canonicalJson(item)) return item;
        changed = true;
        return next;
      });
      return { state: changed ? { ...state, outbox } : state, value: undefined };
    });
  }

  async cleanup(before: Date): Promise<number> {
    const cutoff = before.getTime();
    if (!Number.isFinite(cutoff)) throw new TypeError("relay cleanup cutoff must be a valid date");
    return this.#mutate((state) => {
      const envelopesById = new Map(state.envelopes.map(item => [item.envelope.envelopeId, item]));
      const retainedMailbox = state.mailbox.filter((item) => {
        const stored = envelopesById.get(item.envelopeId);
        const retainedFrom = item.acknowledgedAt ?? stored?.acceptedAt;
        return retainedFrom !== undefined && Date.parse(retainedFrom) >= cutoff;
      });
      const retainedIds = new Set(retainedMailbox.map(item => item.envelopeId));
      const retainedEnvelopes = state.envelopes.filter(item => retainedIds.has(item.envelope.envelopeId));
      const retainedOutbox = state.outbox.filter((item) => {
        const retainedFrom = item.forwardedAt ?? item.exhaustedAt ?? item.queuedAt;
        return Date.parse(retainedFrom) >= cutoff;
      });
      const referencedEndpoints = new Set<string>();
      for (const item of retainedEnvelopes) {
        addLocalEndpointReference(referencedEndpoints, item.envelope.source);
        addLocalEndpointReference(referencedEndpoints, item.envelope.target);
      }
      for (const item of retainedOutbox) {
        addLocalEndpointReference(referencedEndpoints, item.envelope.source);
        addLocalEndpointReference(referencedEndpoints, item.envelope.target);
      }
      const retainedRegistrations = state.registrations.filter(item =>
        referencedEndpoints.has(item.endpoint.id) || Date.parse(item.leaseExpiresAt) >= cutoff);
      const retainedCursorEndpoints = new Set([
        ...retainedRegistrations.map(item => item.endpoint.id),
        ...retainedMailbox.map(item => item.endpointId),
      ]);
      const retainedMailboxCursors = state.mailboxCursors.filter(item => retainedCursorEndpoints.has(item.endpointId));
      const removed = state.registrations.length - retainedRegistrations.length
        + state.mailbox.length - retainedMailbox.length
        + state.outbox.length - retainedOutbox.length;
      const changed = removed !== 0 || state.mailboxCursors.length !== retainedMailboxCursors.length;
      return {
        state: !changed ? state : {
          ...state,
          registrations: retainedRegistrations,
          mailbox: retainedMailbox,
          mailboxCursors: retainedMailboxCursors,
          envelopes: retainedEnvelopes,
          outbox: retainedOutbox,
        },
        value: removed,
      };
    });
  }

  #read(): RelaySnapshot {
    const currentVersion = fileVersion(this.path);
    if (this.#snapshot && sameFileVersion(this.#snapshot.version, currentVersion)) return this.#snapshot;
    if (currentVersion === undefined) return this.#snapshot = snapshot(EMPTY, undefined);

    // Read a stable file identity. An external atomic replacement between stat
    // and read is retried rather than publishing a snapshot for the old file.
    for (let attempts = 0; attempts < 3; attempts += 1) {
      const before = fileVersion(this.path);
      if (before === undefined) return this.#snapshot = snapshot(EMPTY, undefined);
      let source: string;
      try {
        source = readFileSync(this.path, "utf8");
      } catch (cause: unknown) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw cause;
      }
      const after = fileVersion(this.path);
      if (!sameFileVersion(before, after)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(source);
      } catch (cause) {
        throw new MalformedRelayStoreError(cause);
      }
      const state = parsePersistedRelayState(parsed);
      if (!state) throw new MalformedRelayStoreError();
      if (state === "reset") return this.#write(EMPTY);
      return this.#snapshot = snapshot(state, after);
    }
    throw new MalformedRelayStoreError(new Error("relay store changed while loading"));
  }

  #write(state: RelayState): RelaySnapshot {
    const source = canonicalJson(state);
    try {
      atomicWrite(this.path, source);
    } catch (cause) {
      // A failure can happen before rename or after it during directory fsync.
      // Re-read durable authority on the next operation in either case.
      this.#snapshot = undefined;
      throw cause;
    }
    // Do not pair our serialized bytes with a later path stat: another atomic
    // replacement could win after rename. Reload through #read's stable
    // before/read/after identity check so cache authority always matches bytes.
    this.#snapshot = undefined;
    return this.#read();
  }

  async #mutate<T>(operation: (state: RelayState) => { readonly state: RelayState; readonly value: T }): Promise<T> {
    return serialized(this.path, async () => {
      const previous = this.#read();
      const { state, value } = operation(previous.state);
      if (state !== previous.state) this.#write(state);
      return value;
    });
  }
}

export function newOpaqueEndpoint(): RelayEndpoint {
  return { relay: RELAY_ID, id: randomUUID() };
}
