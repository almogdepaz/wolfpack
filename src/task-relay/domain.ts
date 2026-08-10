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
} as const;

export const RELAY_ERROR = {
  INVALID_REQUEST: "INVALID_REQUEST",
  CALLER_NOT_FOUND: "CALLER_NOT_FOUND",
  CALLER_DEAD: "CALLER_DEAD",
  CALLER_NOT_PI: "CALLER_NOT_PI",
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
