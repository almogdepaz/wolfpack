import { MEMORY_RELAY_PROFILE } from "./memory-store.ts";
import type { MemoryRelayCode, MemoryRelayStore } from "./memory-store.ts";
import type { RelayEndpoint, RelayEnvelope } from "./domain.ts";
import type { BoundedRelayInvestigation } from "./investigation.ts";

export const VOLATILE_RELAY_PATH = "/api/task-relay/volatile-v1";
export const VOLATILE_PEER_PATH = `${VOLATILE_RELAY_PATH}/peer`;
export const VOLATILE_GATEWAY_LIMITS = Object.freeze({ requests: 28, peerRequests: 4, inspectMs: 15_000, peerMs: 5_000, replyBytes: 4096 });

export interface VolatileBinding {
  readonly profile: typeof MEMORY_RELAY_PROFILE;
  readonly epoch: string;
  readonly callerSession: string;
  readonly endpoint: RelayEndpoint;
}
export type VolatileRequest =
  | { readonly operation: "connect"; readonly profile: typeof MEMORY_RELAY_PROFILE; readonly callerSession: string;
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
  readonly profile: typeof MEMORY_RELAY_PROFILE;
  readonly epoch: string;
  readonly sourceEpoch: string;
  readonly origin: string;
  readonly envelope: RelayEnvelope;
}
export type VolatileCode = MemoryRelayCode | "RELAY_PROFILE_REQUIRED" | "CALLER_NOT_FOUND" | "CALLER_DEAD"
  | "SOURCE_MISMATCH" | "RELAY_UNAVAILABLE" | "PEER_UNREACHABLE" | "DELIVERY_UNCONFIRMED";
export type VolatileValue =
  | { readonly kind: "connected"; readonly endpoint: RelayEndpoint; readonly leaseExpiresAt: string }
  | { readonly kind: "resolved"; readonly endpoint: RelayEndpoint }
  | { readonly kind: "accepted"; readonly envelopeId: string; readonly acceptanceId: string; readonly duplicate: boolean; readonly forwarding: "local" | "forwarded" }
  | { readonly kind: "page"; readonly deliveries: readonly { readonly cursor: string; readonly envelope: RelayEnvelope }[]; readonly nextCursor: string; readonly hasMore: boolean }
  | { readonly kind: "acknowledged"; readonly duplicate: boolean }
  | { readonly kind: "disconnected" }
  | { readonly kind: "health"; readonly store: ReturnType<MemoryRelayStore["stats"]>; readonly investigation: ReturnType<BoundedRelayInvestigation["health"]> | undefined };
export type VolatileResult =
  | { readonly ok: true; readonly profile: typeof MEMORY_RELAY_PROFILE; readonly epoch: string; readonly value: VolatileValue }
  | { readonly ok: false; readonly profile: typeof MEMORY_RELAY_PROFILE; readonly epoch?: string;
      readonly error: { readonly code: VolatileCode; readonly message: string; readonly retryable: boolean;
        readonly mayHaveBeenDelivered?: true; readonly retryAfterMs?: number } };

export function volatileFailure(code: VolatileCode, epoch?: string, retryAfterMs?: number): VolatileResult {
  return { ok: false, profile: MEMORY_RELAY_PROFILE, ...(epoch && { epoch }), error: {
    code, message: code,
    retryable: ["RELAY_CAPACITY", "RELAY_UNAVAILABLE", "PEER_UNREACHABLE"].includes(code),
    ...(["RELAY_RESET", "DELIVERY_UNCONFIRMED", "PEER_UNREACHABLE", "RELAY_UNAVAILABLE"].includes(code) && { mayHaveBeenDelivered: true as const }),
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  } };
}
