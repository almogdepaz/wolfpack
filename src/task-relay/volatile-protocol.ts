import type { RelayOwnerFailureCode, RelayOwnerFailureData } from "./owner-failure.ts";
import { MEMORY_RELAY_PROFILE, RESTART_SAFE_RELAY_PROFILE } from "./memory-store.ts";
import type { MemoryRelayCode, MemoryRelayStore } from "./memory-store.ts";
import type { RelayEndpoint, RelayEnvelope } from "./domain.ts";
import type { BoundedRelayInvestigation } from "./investigation.ts";

export type RelayProfile = typeof MEMORY_RELAY_PROFILE | typeof RESTART_SAFE_RELAY_PROFILE;
export const VOLATILE_RELAY_PATH = "/api/task-relay/volatile-v1";
export const VOLATILE_PEER_PATH = `${VOLATILE_RELAY_PATH}/peer`;
export const RESTART_SAFE_RELAY_PATH = "/api/task-relay/restart-safe-v1";
export const RESTART_SAFE_PEER_PATH = `${RESTART_SAFE_RELAY_PATH}/peer`;
export const relayEndpointPath = (profile: RelayProfile): string => profile === RESTART_SAFE_RELAY_PROFILE ? RESTART_SAFE_RELAY_PATH : VOLATILE_RELAY_PATH;
export const relayPeerPath = (profile: RelayProfile): string => `${relayEndpointPath(profile)}/peer`;
export const VOLATILE_GATEWAY_LIMITS = Object.freeze({ requests: 28, peerRequests: 4, inspectMs: 15_000, peerMs: 5_000, replyBytes: 4096 });

export interface VolatileBinding {
  readonly profile: RelayProfile;
  readonly epoch: string;
  readonly callerSession: string;
  readonly endpoint: RelayEndpoint;
}
export type VolatileRequest =
  | { readonly operation: "connect"; readonly profile: RelayProfile; readonly callerSession: string;
      readonly generation: string; readonly protocolVersions: readonly number[]; readonly leaseMs?: number; readonly epoch?: string }
  | (VolatileBinding & (
      | { readonly operation: "resolve"; readonly target: RelayEndpoint }
      | { readonly operation: "send"; readonly envelope: RelayEnvelope }
      | { readonly operation: "receive"; readonly cursor: string; readonly limit?: number }
      | { readonly operation: "acknowledge"; readonly envelopeId: string }
      | { readonly operation: "disconnect" | "health" }
    ));
/** Host-only resolution from current verified topology, not caller-supplied URLs. */
export type VolatileTopologyRequest = VolatileBinding & {
  readonly operation: "resolvePeer"; readonly origin: string; readonly peerEpoch: string; readonly target: RelayEndpoint;
};
/** Only the trusted peer ingress may submit this command, never endpoint ingress. */
export interface VolatilePeerRequest {
  readonly operation: "receivePeer";
  readonly profile: RelayProfile;
  readonly epoch: string;
  readonly sourceEpoch: string;
  readonly origin: string;
  readonly envelope: RelayEnvelope;
}
export type VolatileCode = MemoryRelayCode | RelayOwnerFailureCode | "RELAY_PROFILE_REQUIRED" | "CALLER_NOT_FOUND" | "CALLER_DEAD"
  | "SOURCE_MISMATCH" | "RELAY_STORAGE_RECOVERING" | "RELAY_UNAVAILABLE" | "PEER_UNREACHABLE" | "DELIVERY_UNCONFIRMED";
export type VolatileValue =
  | { readonly kind: "connected"; readonly endpoint: RelayEndpoint; readonly leaseExpiresAt: string; readonly sessionId?: string }
  | { readonly kind: "resolved"; readonly endpoint: RelayEndpoint }
  | { readonly kind: "accepted"; readonly envelopeId: string; readonly acceptanceId: string; readonly duplicate: boolean; readonly forwarding: "local" | "forwarded" }
  | { readonly kind: "page"; readonly deliveries: readonly { readonly cursor: string; readonly envelope: RelayEnvelope }[]; readonly nextCursor: string; readonly hasMore: boolean }
  | { readonly kind: "acknowledged"; readonly duplicate: boolean }
  | { readonly kind: "disconnected" }
  | { readonly kind: "health"; readonly store: ReturnType<MemoryRelayStore["stats"]>; readonly investigation: ReturnType<BoundedRelayInvestigation["health"]> | undefined };
export type VolatileResult =
  | { readonly ok: true; readonly profile: RelayProfile; readonly epoch: string; readonly value: VolatileValue }
  | { readonly ok: false; readonly profile: RelayProfile; readonly epoch?: string;
      readonly error: { readonly code: VolatileCode; readonly message: string; readonly retryable: boolean;
        readonly mayHaveBeenDelivered?: true; readonly retryAfterMs?: number; readonly ownerFatal?: true } };

export function relayOwnerFailureResult(failure: RelayOwnerFailureData, profile: RelayProfile, retryAfterMs?: number): VolatileResult {
  return { ok: false, profile, error: { code: failure.code, message: failure.code, retryable: failure.retryable, ownerFatal: true,
    ...(failure.mayHaveBeenDelivered && { mayHaveBeenDelivered: true }), ...(retryAfterMs !== undefined && { retryAfterMs }) } };
}

export function volatileFailure(code: VolatileCode, epoch?: string, retryAfterMs?: number, profile: RelayProfile = MEMORY_RELAY_PROFILE): VolatileResult {
  return { ok: false, profile, ...(epoch && { epoch }), error: {
    code, message: code,
    retryable: ["RELAY_CAPACITY", "RELAY_UNAVAILABLE", "PEER_UNREACHABLE", "RELAY_STORAGE_BUSY", "RELAY_STORAGE_UNAVAILABLE", "RELAY_STORAGE_UNCERTAIN", "RELAY_STORAGE_RECOVERING"].includes(code),
    ...(["RELAY_RESET", "DELIVERY_UNCONFIRMED", "PEER_UNREACHABLE", "RELAY_UNAVAILABLE", "RELAY_STORAGE_UNCERTAIN"].includes(code) && { mayHaveBeenDelivered: true as const }),
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  } };
}
