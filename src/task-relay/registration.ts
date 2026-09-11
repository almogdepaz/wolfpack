import { isOpaqueRelayId, isRelayEndpoint, RELAY_ID } from "./domain.ts";
import type { RelayEndpoint } from "./domain.ts";

/** Host-observed transport registration, not model readiness or relay recovery. */
export type TaskRelayRegistration = {
  readonly endpoint: RelayEndpoint;
  readonly leaseExpiresAt: string;
  readonly profile: "volatile-v1";
  readonly epoch: string;
};

export function isLiveTaskRelayRegistration(value: TaskRelayRegistration, profile: TaskRelayRegistration["profile"], now = Date.now()): boolean {
  return value !== null && typeof value === "object" && value.profile === profile
    && isRelayEndpoint(value.endpoint) && value.endpoint.relay === RELAY_ID
    && Number.isFinite(Date.parse(value.leaseExpiresAt)) && Date.parse(value.leaseExpiresAt) > now
    && isOpaqueRelayId(value.epoch);
}

export function sameTaskRelayRegistration(left: TaskRelayRegistration, right: TaskRelayRegistration): boolean {
  return left.profile === right.profile && left.endpoint.relay === right.endpoint.relay && left.endpoint.id === right.endpoint.id
    && left.epoch === right.epoch;
}
