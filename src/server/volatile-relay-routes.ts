import type { IncomingMessage, ServerResponse } from "node:http";
import { RELAY_LIMITS, isRelayEndpoint, isLocalRelay } from "../task-relay/domain.ts";
import { getRelayPeerTransport, trustedRelayClient } from "./relay-peer-transport.ts";
import { RelayPeerPolicyError } from "../task-relay/peer-transport.ts";
import { getTaskRelayProfile, getVolatileTaskRelayGateway } from "../task-relay/gateway.ts";
import { VOLATILE_RELAY_PATH, VOLATILE_PEER_PATH } from "../task-relay/volatile-protocol.ts";
import { json } from "./http.ts";

export const VOLATILE_HTTP_LIMITS = Object.freeze({ requests: 24, bodyMs: 5000, bodyBytes: RELAY_LIMITS.HTTP_BODY_BYTES });
const operations = new Set(["connect", "resolve", "send", "receive", "acknowledge", "disconnect", "health"]);
let active = 0, activePeers = 0;
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
class BodyError extends Error { constructor(readonly status: number) { super("invalid volatile relay body"); } }

function reject(res: ServerResponse, code: string, status: number, epoch?: string): void {
  if (res.destroyed) return;
  res.setHeader("Cache-Control", "no-store");
  json(res, { ok: false, profile: getTaskRelayProfile(), ...(epoch && { epoch }), error: { code, message: code, retryable: code === "RELAY_CAPACITY" || code === "RELAY_UNAVAILABLE" || code === "PEER_UNREACHABLE" } }, status);
}
function discard(req: IncomingMessage, res: ServerResponse): void {
  req.once("error", () => undefined); // Destroying an incomplete request may emit a final reset error.
  res.setHeader("Connection", "close");
  res.once("finish", () => req.destroy());
  req.resume();
}
function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0;
    const cleanup = () => { clearTimeout(timer); chunks.length = 0; req.off("data", data); req.off("end", end); req.off("error", error); req.off("aborted", aborted); };
    const error = () => { cleanup(); reject(new BodyError(400)); };
    const aborted = () => { req.once("error", () => undefined); error(); };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > VOLATILE_HTTP_LIMITS.bodyBytes) { cleanup(); reject(new BodyError(413)); }
      else chunks.push(chunk);
    };
    const end = () => {
      try { const value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); cleanup(); resolve(value); }
      catch { error(); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new BodyError(408)); }, VOLATILE_HTTP_LIMITS.bodyMs);
    req.on("data", data); req.once("end", end); req.once("error", error); req.once("aborted", aborted);
  });
}

const handlers: Record<string, Handler> = {
  "GET /api/task-relay/profile": async (req, res) => {
    if (new URL(req.url ?? "/", "http://localhost").search) return reject(res, "INVALID_REQUEST", 400);
    if (active >= VOLATILE_HTTP_LIMITS.requests) return reject(res, "RELAY_CAPACITY", 503);
    active++;
    try {
      const gateway = getVolatileTaskRelayGateway();
      const epoch = await gateway?.volatileEpoch();
      if (res.destroyed) return;
      res.setHeader("Cache-Control", "no-store");
      json(res, { ok: true, profile: getTaskRelayProfile(), ...(epoch && { epoch }), endpointPath: VOLATILE_RELAY_PATH, federation: "trusted-tailnet-v1" });
    } catch { reject(res, "RELAY_UNAVAILABLE", 503); }
    finally { active--; }
  },
  [`POST ${VOLATILE_PEER_PATH}`]: async (req, res) => {
    const gateway = getVolatileTaskRelayGateway();
    if (!gateway) { discard(req, res); return reject(res, "RELAY_PROFILE_REQUIRED", 409); }
    if (activePeers >= 4) { discard(req, res); return reject(res, "RELAY_CAPACITY", 503); }
    activePeers++;
    try {
      if (new URL(req.url ?? "/", "http://localhost").search || typeof req.headers["content-type"] !== "string"
        || req.headers["content-type"].split(";")[0]!.trim().toLowerCase() !== "application/json") throw new BodyError(400);
      const raw = await read(req);
      await getRelayPeerTransport(gateway).verify(raw);
      const result = await gateway.volatilePeer(JSON.parse(raw));
      if (!res.destroyed) { res.setHeader("Cache-Control", "no-store"); json(res, result, result.ok ? 200 : result.error.retryable ? 503 : 409); }
    } catch (error) {
      if (error instanceof BodyError) { discard(req, res); reject(res, "INVALID_REQUEST", error.status); }
      else reject(res, error instanceof RelayPeerPolicyError ? error.code : "RELAY_UNAVAILABLE", error instanceof RelayPeerPolicyError && error.code === "PEER_POLICY_REQUIRED" ? 403 : 503);
    } finally { activePeers--; }
  },
  [`POST ${VOLATILE_RELAY_PATH}/resolve-peer`]: async (req, res) => {
    const gateway = getVolatileTaskRelayGateway();
    if (!gateway) { discard(req, res); return reject(res, "RELAY_PROFILE_REQUIRED", 409); }
    if (active >= VOLATILE_HTTP_LIMITS.requests) { discard(req, res); return reject(res, "RELAY_CAPACITY", 503); }
    active++;
    try {
      if (new URL(req.url ?? "/", "http://localhost").search || typeof req.headers["content-type"] !== "string"
        || req.headers["content-type"].split(";")[0]!.trim().toLowerCase() !== "application/json") throw new BodyError(400);
      const body: unknown = JSON.parse(await read(req));
      if (!object(body) || Object.keys(body).some(key => !["profile", "epoch", "callerSession", "endpoint", "origin", "target"].includes(key))
        || typeof body.origin !== "string" || !isRelayEndpoint(body.target) || !isLocalRelay(body.target)) throw new BodyError(400);
      const owner = await gateway.volatile({ operation: "health", profile: body.profile, epoch: body.epoch, callerSession: body.callerSession, endpoint: body.endpoint });
      if (!owner.ok) return json(res, owner, owner.error.retryable ? 503 : 409);
      const peer = await getRelayPeerTransport(gateway).peer(body.origin);
      const result = await gateway.volatileTopology({ ...body, operation: "resolvePeer", peerEpoch: peer.epoch });
      if (!res.destroyed) { res.setHeader("Cache-Control", "no-store"); json(res, result, result.ok ? 200 : result.error.retryable ? 503 : 409); }
    } catch (error) {
      if (error instanceof BodyError || error instanceof SyntaxError) { discard(req, res); reject(res, "INVALID_REQUEST", error instanceof BodyError ? error.status : 400); }
      else reject(res, error instanceof RelayPeerPolicyError ? error.code : "RELAY_UNAVAILABLE", error instanceof RelayPeerPolicyError && error.code === "PEER_POLICY_REQUIRED" ? 403 : 503);
    } finally { active--; }
  },
  [`POST ${VOLATILE_RELAY_PATH}`]: async (req, res) => {
    const gateway = getVolatileTaskRelayGateway();
    if (!gateway) { discard(req, res); return reject(res, "RELAY_PROFILE_REQUIRED", 409); }
    if (active >= VOLATILE_HTTP_LIMITS.requests) { discard(req, res); return reject(res, "RELAY_CAPACITY", 503); }
    active++;
    let epoch: string | undefined;
    try {
      if (new URL(req.url ?? "/", "http://localhost").search || typeof req.headers["content-type"] !== "string"
        || req.headers["content-type"].split(";")[0]!.trim().toLowerCase() !== "application/json") throw new BodyError(400);
      const raw = await read(req);
      epoch = await gateway.volatileEpoch();
      let body: unknown;
      try { body = JSON.parse(raw) as unknown; } catch { throw new BodyError(400); }
      if (!object(body) || typeof body.operation !== "string" || !operations.has(body.operation)) throw new BodyError(400);
      // Nonlocal IDs must already be host-resolved aliases. The worker refuses
      // unknown routes; trusted-Tailnet transport rechecks topology on every attempt.
      const result = await gateway.volatile(body);
      if (res.destroyed) return;
      res.setHeader("Cache-Control", "no-store");
      const status = result.ok ? 200 : result.error.code === "RELAY_CAPACITY" || result.error.code === "RELAY_UNAVAILABLE" || result.error.code === "PEER_UNREACHABLE" ? 503
        : result.error.code === "TARGET_NOT_REGISTERED" || result.error.code === "CALLER_NOT_FOUND" ? 404
          : result.error.code === "CALLER_DEAD" || result.error.code === "REGISTRATION_EXPIRED" ? 410
            : ["RELAY_RESET", "SOURCE_MISMATCH", "ENVELOPE_CONFLICT", "DELIVERY_UNCONFIRMED", "RELAY_PROFILE_REQUIRED"].includes(result.error.code) ? 409 : 400;
      json(res, !result.ok && result.epoch === undefined && epoch ? { ...result, epoch } : result, status);
    } catch (error) {
      if (error instanceof BodyError) { discard(req, res); reject(res, "INVALID_REQUEST", error.status, epoch); }
      else reject(res, "RELAY_UNAVAILABLE", 503, epoch);
    } finally { active--; }
  },
};

export const volatileRelayRoutes: Record<string, Handler> = Object.fromEntries(Object.entries(handlers).map(([path, handler]) => [path, async (req: IncomingMessage, res: ServerResponse) => {
  if (!trustedRelayClient(req.socket.remoteAddress, req.headers["x-forwarded-for"])) {
    discard(req, res); return reject(res, "PEER_POLICY_REQUIRED", 403);
  }
  await handler(req, res);
}]));
