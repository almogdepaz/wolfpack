import type { IncomingMessage, ServerResponse } from "node:http";
import { RELAY_ERROR, RELAY_LIMITS } from "../task-relay/domain.ts";
import type { RelayEndpoint, RelayResult } from "../task-relay/domain.ts";
import { getTaskRelayGateway } from "../task-relay/gateway.ts";
import { json, parseBody } from "./http.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
type Body = Record<string, unknown>;

function object(value: unknown): value is Body {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function endpoint(value: unknown): value is RelayEndpoint {
  return object(value) && typeof value.relay === "string" && value.relay.length > 0 && typeof value.id === "string" && value.id.length > 0;
}

function only(body: Body, keys: readonly string[]): boolean {
  return Object.keys(body).every((key) => keys.includes(key));
}

function response(res: ServerResponse, value: RelayResult<object>): void {
  if (value.ok) return json(res, value);
  const status = value.error.code === RELAY_ERROR.CALLER_NOT_FOUND || value.error.code === RELAY_ERROR.TARGET_NOT_REGISTERED ? 404
    : value.error.code === RELAY_ERROR.CALLER_DEAD || value.error.code === RELAY_ERROR.REGISTRATION_EXPIRED ? 410
      : value.error.code === RELAY_ERROR.PAYLOAD_TOO_LARGE ? 413
        : value.error.code === RELAY_ERROR.STORE_UNAVAILABLE || value.error.code === RELAY_ERROR.PEER_UNREACHABLE ? 503
          : value.error.code === RELAY_ERROR.SOURCE_MISMATCH || value.error.code === RELAY_ERROR.ENVELOPE_CONFLICT ? 409 : 400;
  json(res, value, status);
}

async function relayBody(req: IncomingMessage, res: ServerResponse): Promise<Body | undefined> {
  if (typeof req.headers["content-type"] !== "string" || !req.headers["content-type"].toLowerCase().startsWith("application/json")) {
    json(res, { ok: false, error: { code: RELAY_ERROR.INVALID_REQUEST, message: "relay routes require application/json", retryable: false } }, 400);
    return undefined;
  }
  const body = await parseBody(req, res, {
    maxBytes: RELAY_LIMITS.HTTP_BODY_BYTES,
    respondOnTooLarge: true,
    invalidResponse: { envelope: { ok: false, error: { code: RELAY_ERROR.INVALID_REQUEST, message: "invalid relay JSON", retryable: false } }, status: 400 },
    tooLargeResponse: { envelope: { ok: false, error: { code: RELAY_ERROR.PAYLOAD_TOO_LARGE, message: "relay request body exceeds limit", retryable: false } }, status: 413 },
  });
  if (!object(body)) {
    if (body !== undefined) json(res, { ok: false, error: { code: RELAY_ERROR.INVALID_REQUEST, message: "relay request body must be an object", retryable: false } }, 400);
    return undefined;
  }
  return body;
}

export const taskRelayRoutes: Record<string, Handler> = {
  "POST /api/task-relay/v2/connect": async (req, res) => {
    const body = await relayBody(req, res);
    if (!body) return;
    if (!only(body, ["callerSession", "generation", "protocolVersions", "leaseMs"]) || typeof body.callerSession !== "string" || typeof body.generation !== "string"
      || !Array.isArray(body.protocolVersions) || !body.protocolVersions.every(Number.isInteger) || (body.leaseMs !== undefined && typeof body.leaseMs !== "number")) {
      return response(res, { ok: false, error: { code: RELAY_ERROR.INVALID_REQUEST, message: "invalid relay registration", retryable: false } });
    }
    response(res, await getTaskRelayGateway().connect({ callerSession: body.callerSession, generation: body.generation, protocolVersions: body.protocolVersions, leaseMs: body.leaseMs as number | undefined }));
  },
  "POST /api/task-relay/v2/disconnect": async (req, res) => {
    const body = await relayBody(req, res);
    if (!body) return;
    if (!only(body, ["callerSession", "endpoint"]) || typeof body.callerSession !== "string" || !endpoint(body.endpoint)) {
      return response(res, { ok: false, error: { code: RELAY_ERROR.INVALID_REQUEST, message: "invalid relay disconnect", retryable: false } });
    }
    response(res, await getTaskRelayGateway().disconnect({ callerSession: body.callerSession, endpoint: body.endpoint }));
  },
  "POST /api/task-relay/v2/resolve": async (req, res) => {
    const body = await relayBody(req, res);
    if (!body) return;
    if (!only(body, ["callerSession", "target", "protocolVersion"]) || typeof body.callerSession !== "string" || !endpoint(body.target) || typeof body.protocolVersion !== "number") {
      return response(res, { ok: false, error: { code: RELAY_ERROR.INVALID_REQUEST, message: "invalid relay resolve request", retryable: false } });
    }
    response(res, await getTaskRelayGateway().resolve({ callerSession: body.callerSession, target: body.target, protocolVersion: body.protocolVersion }));
  },
  "POST /api/task-relay/v2/send": async (req, res) => {
    const body = await relayBody(req, res);
    if (!body) return;
    if (!only(body, ["callerSession", "envelope"]) || typeof body.callerSession !== "string" || !object(body.envelope)) {
      return response(res, { ok: false, error: { code: RELAY_ERROR.INVALID_REQUEST, message: "invalid relay send request", retryable: false } });
    }
    response(res, await getTaskRelayGateway().send({ callerSession: body.callerSession, envelope: body.envelope as never }));
  },
  "GET /api/task-relay/v2/receive": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const callerSession = url.searchParams.get("callerSession");
    const cursor = url.searchParams.get("cursor");
    if (!callerSession || !cursor || [...url.searchParams.keys()].some((key) => key !== "callerSession" && key !== "cursor")) {
      return response(res, { ok: false, error: { code: RELAY_ERROR.INVALID_REQUEST, message: "invalid relay receive query", retryable: false } });
    }
    response(res, await getTaskRelayGateway().receive({ callerSession, cursor }));
  },
  "POST /api/task-relay/v2/delivery-ack": async (req, res) => {
    const body = await relayBody(req, res);
    if (!body) return;
    if (!only(body, ["callerSession", "envelopeId"]) || typeof body.callerSession !== "string" || typeof body.envelopeId !== "string") {
      return response(res, { ok: false, error: { code: RELAY_ERROR.INVALID_REQUEST, message: "invalid relay acknowledgement", retryable: false } });
    }
    response(res, await getTaskRelayGateway().acknowledgeDelivery({ callerSession: body.callerSession, envelopeId: body.envelopeId }));
  },
  "POST /api/task-relay/v2/peer/resolve": async (req, res) => {
    const body = await relayBody(req, res);
    if (!body) return;
    if (!only(body, ["origin", "endpoint"]) || typeof body.origin !== "string" || !endpoint(body.endpoint)) {
      return response(res, { ok: false, error: { code: RELAY_ERROR.INVALID_REQUEST, message: "invalid peer topology request", retryable: false } });
    }
    response(res, await getTaskRelayGateway().resolvePeerEndpoint({ origin: body.origin, endpoint: body.endpoint }));
  },
  "POST /api/task-relay/v2/peer/receive": async (req, res) => {
    const body = await relayBody(req, res);
    if (!body) return;
    if (!only(body, ["envelopeId", "protocolVersion", "source", "target", "payload", "createdAt"])) {
      return response(res, { ok: false, error: { code: RELAY_ERROR.INVALID_REQUEST, message: "invalid peer relay envelope", retryable: false } });
    }
    response(res, await getTaskRelayGateway().receivePeer(body));
  },
};
