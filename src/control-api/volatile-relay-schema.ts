import { RELAY_ID, RELAY_LIMITS, RELAY_PROTOCOL_VERSION } from "../task-relay/domain.ts";
import type { VolatileCode } from "../task-relay/volatile-protocol.ts";

type Schema = Record<string, unknown>;
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: "object", properties, required, additionalProperties: false });
const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });
const text = { type: "string", minLength: 1, maxLength: 512 };
const uuid = { type: "string", format: "uuid" };
const cursor = { type: "string", pattern: "^(0|[1-9][0-9]{0,31})$" };
const boolean = { type: "boolean" };
const count = { type: "integer", minimum: 0 };
const profile = { const: "volatile-v1" };
const localEndpoint = object({ relay: { const: RELAY_ID }, id: uuid });
const binding = { profile, epoch: uuid, callerSession: text, endpoint: localEndpoint };
const bound = (operation: string, fields: Record<string, Schema> = {}, optional: string[] = []): Schema => {
  const properties = { ...binding, operation: { const: operation }, ...fields };
  return object(properties, Object.keys(properties).filter(key => !optional.includes(key)));
};
const value = (kind: string, fields: Record<string, Schema> = {}, optional: string[] = []): Schema => {
  const properties = { kind: { const: kind }, ...fields };
  return object(properties, Object.keys(properties).filter(key => !optional.includes(key)));
};
const counters = (names: string[]) => Object.fromEntries(names.map(name => [name, count]));
const codes = {
  RELAY_CAPACITY: true, RELAY_RESET: true, INVALID_REQUEST: true, INVALID_CURSOR: true,
  REGISTRATION_EXPIRED: true, TARGET_NOT_REGISTERED: true, CROSS_RELAY_ENDPOINT: true,
  ENVELOPE_CONFLICT: true, ENVELOPE_EXPIRED: true, RELAY_PROFILE_REQUIRED: true,
  CALLER_NOT_FOUND: true, CALLER_DEAD: true, SOURCE_MISMATCH: true, RELAY_UNAVAILABLE: true,
  PEER_UNREACHABLE: true, DELIVERY_UNCONFIRMED: true, PEER_POLICY_REQUIRED: true,
} satisfies Record<VolatileCode | "PEER_POLICY_REQUIRED", true>;

export const volatileRelayDefinitions: Record<string, Schema> = {
  VolatileEnvelope: object({ envelopeId: text, protocolVersion: { const: RELAY_PROTOCOL_VERSION }, source: localEndpoint, target: localEndpoint,
    payload: { description: "Opaque JSON. Runtime enforces the 48 KiB encoded payload and 64 KiB HTTP body bounds." }, createdAt: { type: "string", format: "date-time" } }),
  VolatileRequest: { oneOf: [
    object({ profile, operation: { const: "connect" }, callerSession: text, generation: text,
      protocolVersions: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 16 },
      epoch: uuid, leaseMs: { type: "integer", minimum: 1, maximum: RELAY_LIMITS.MAX_LEASE_MS } }, ["profile", "operation", "callerSession", "generation", "protocolVersions"]),
    bound("resolve", { target: localEndpoint }), bound("send", { envelope: ref("VolatileEnvelope") }),
    bound("receive", { cursor, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["limit"]),
    bound("acknowledge", { envelopeId: text }), bound("disconnect"), bound("health"),
  ] },
  VolatileErrorEnvelope: object({ ok: { const: false }, profile: { enum: ["durable-v2", "volatile-v1"] }, epoch: uuid,
    error: object({ code: { enum: Object.keys(codes) }, message: { type: "string" }, retryable: boolean,
      mayHaveBeenDelivered: { const: true }, retryAfterMs: count }, ["code", "message", "retryable"]) }, ["ok", "profile", "error"]),
  VolatileResponse: { oneOf: [ref("VolatileErrorEnvelope"), object({ ok: { const: true }, profile, epoch: uuid, value: { oneOf: [
    value("connected", { endpoint: localEndpoint, leaseExpiresAt: { type: "string", format: "date-time" } }),
    value("resolved", { endpoint: localEndpoint }),
    value("accepted", { envelopeId: text, acceptanceId: uuid, duplicate: boolean, forwarding: { const: "local" } }),
    value("page", { deliveries: { type: "array", maxItems: 50, items: object({ cursor, envelope: ref("VolatileEnvelope") }) }, nextCursor: cursor, hasMore: boolean }),
    value("acknowledged", { duplicate: boolean }), value("disconnected"),
    value("health", {
      store: object({ ...counters(["activeItems", "activeBytes", "receipts", "receiptBytes", "registrations", "sessions", "routes", "metadataBytes", "expiryEntries", "logDrops"]), investigationEnabled: boolean }),
      investigation: object({ ...counters(["queuedItems", "queuedBytes", "written", "droppedRecords", "droppedBytes", "invalidRecords", "writeFailures", "maintenanceFailures"]), degraded: boolean, closed: boolean, lastFailure: { type: "string" } },
        ["queuedItems", "queuedBytes", "written", "droppedRecords", "droppedBytes", "invalidRecords", "writeFailures", "maintenanceFailures", "degraded", "closed"]),
    }, ["investigation"]),
  ] } })] },
  TaskRelayProfileResponse: { oneOf: [ref("VolatileErrorEnvelope"),
    object({ ok: { const: true }, profile: { const: "durable-v2" }, endpointPath: { const: "/api/task-relay/v2/connect" }, federation: { const: "existing-v2-policy" } }),
    object({ ok: { const: true }, profile, epoch: uuid, endpointPath: { const: "/api/task-relay/volatile-v1" }, federation: { const: "disabled" } }),
  ] },
};
