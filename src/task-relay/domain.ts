export const RELAY_ID = "wolfpack-pi-tasks-v2";
export const RELAY_PROTOCOL_VERSION = 2;

export const RELAY_LIMITS = {
  HTTP_BODY_BYTES: 64 * 1024,
  PAYLOAD_BYTES: 48 * 1024,
  INBOX_PAGE_ITEMS: 50,
  INBOX_PAGE_BYTES: 256 * 1024,
  LEASE_MS: 60_000,
  MAX_LEASE_MS: 5 * 60_000,
  MAX_FORWARD_ATTEMPTS: 4,
  FORWARD_RETRY_MS: 1_000,
  RETENTION_MS: 24 * 60 * 60 * 1_000,
  CLEANUP_INTERVAL_MS: 60 * 60 * 1_000,
} as const;

export const RELAY_ERROR = {
  INVALID_REQUEST: "INVALID_REQUEST",
  CALLER_NOT_FOUND: "CALLER_NOT_FOUND",
  CALLER_DEAD: "CALLER_DEAD",
  INCOMPATIBLE_PROTOCOL: "INCOMPATIBLE_PROTOCOL",
  REGISTRATION_EXPIRED: "REGISTRATION_EXPIRED",
  SOURCE_MISMATCH: "SOURCE_MISMATCH",
  TARGET_NOT_REGISTERED: "TARGET_NOT_REGISTERED",
  CROSS_RELAY_ENDPOINT: "CROSS_RELAY_ENDPOINT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  ENVELOPE_CONFLICT: "ENVELOPE_CONFLICT",
  PEER_UNREACHABLE: "PEER_UNREACHABLE",
  STORE_UNAVAILABLE: "STORE_UNAVAILABLE",
} as const;

export type RelayErrorCode = (typeof RELAY_ERROR)[keyof typeof RELAY_ERROR];

export interface RelayEndpoint {
  readonly relay: string;
  readonly id: string;
}

export interface RelayEnvelope {
  readonly envelopeId: string;
  readonly protocolVersion: number;
  readonly source: RelayEndpoint;
  readonly target: RelayEndpoint;
  /** Relay content is deliberately only JSON data. No task fields are interpreted. */
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface RelayRegistration {
  readonly endpoint: RelayEndpoint;
  readonly sessionId: string;
  readonly generation: string;
  readonly protocolVersions: readonly number[];
  readonly leaseExpiresAt: string;
}

export interface RelayInboxItem {
  readonly cursor: string;
  readonly envelope: RelayEnvelope;
  readonly acknowledgedAt: string | undefined;
}

const OPAQUE_RELAY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PEER_RELAY_ID = new RegExp(`^${RELAY_ID}:peer:${OPAQUE_RELAY_ID.source.slice(1, -1)}$`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isJsonArray(value: readonly unknown[], ancestors: Set<object>): boolean {
  if (Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || lengthDescriptor.configurable || lengthDescriptor.enumerable
    || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
    || keys.length !== lengthDescriptor.value + 1) return false;
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string") return false;
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= lengthDescriptor.value || String(index) !== key) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
      || !isJsonValueAt(descriptor.value, ancestors)) return false;
  }
  return true;
}

function isJsonValueAt(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return isJsonArray(value, ancestors);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
        || !isJsonValueAt(descriptor.value, ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

export function isJsonValue(value: unknown): boolean {
  try {
    return isJsonValueAt(value, new Set());
  } catch {
    return false;
  }
}

export function isOpaqueRelayId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_RELAY_ID.test(value);
}

export function isPeerRelayId(value: unknown): value is string {
  return typeof value === "string" && PEER_RELAY_ID.test(value);
}

export function isRelayTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isRelayEndpoint(value: unknown): value is RelayEndpoint {
  return isRecord(value) && nonEmpty(value.relay) && isOpaqueRelayId(value.id);
}

export function isRelayEnvelope(value: unknown): value is RelayEnvelope {
  return isRecord(value) && nonEmpty(value.envelopeId) && typeof value.protocolVersion === "number"
    && isRelayEndpoint(value.source) && isRelayEndpoint(value.target)
    && typeof value.createdAt === "string" && isJsonValue(value.payload);
}

export type RelayResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly error: { readonly code: RelayErrorCode; readonly message: string; readonly retryable: boolean } };

export function relayFailure(code: RelayErrorCode, message: string, retryable = false): RelayResult<never> {
  return { ok: false, error: { code, message, retryable } };
}

export function isLocalRelay(endpoint: RelayEndpoint): boolean {
  return endpoint.relay === RELAY_ID;
}

export function encodedJsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : new TextEncoder().encode(json).byteLength;
}
