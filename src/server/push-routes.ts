import type { IncomingMessage, ServerResponse } from "node:http";
import {
  addSubscription,
  buildAgentNotificationPayload,
  checkNotifyRateLimit,
  getSubscriptionCount,
  getVapidPublicKey,
  removeSubscription,
  sendPush,
  validateSubscription,
} from "./push.js";
import type { PushSubscription } from "./push.js";
import {
  isJsonObject,
  json,
  parseObjectBody,
} from "./http.js";
import { resetNotificationObservation } from "./session-observation.js";

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export const pushSubscriptionRoutes: Record<string, RouteHandler> = {
  "GET /api/push/vapid-key": (_req, res) => {
    json(res, { publicKey: getVapidPublicKey() });
  },

  "POST /api/push/subscribe": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    if (
      typeof body.endpoint !== "string" ||
      !isJsonObject(body.keys) ||
      typeof body.keys.p256dh !== "string" ||
      typeof body.keys.auth !== "string"
    ) return json(res, { error: "invalid subscription" }, 400);
    const sub: PushSubscription = {
      endpoint: body.endpoint,
      keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    };
    const validationError = validateSubscription(sub);
    if (validationError) return json(res, { error: validationError }, 400);
    const hadSubscriptions = getSubscriptionCount() > 0;
    const result = addSubscription(sub);
    if (!result.ok) return json(res, { error: result.error }, 429);
    if (!hadSubscriptions) resetNotificationObservation();
    json(res, { ok: true });
  },

  "POST /api/push/unsubscribe": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    if (!body.endpoint || typeof body.endpoint !== "string") return json(res, { error: "missing endpoint" }, 400);
    removeSubscription(body.endpoint);
    if (getSubscriptionCount() === 0) resetNotificationObservation();
    json(res, { ok: true });
  },
};

export const pushNotifyRoutes: Record<string, RouteHandler> = {
  "POST /api/notify": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    if (!body.message || typeof body.message !== "string") return json(res, { error: "missing message" }, 400);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    const sessionName = typeof body.sessionName === "string" ? body.sessionName : undefined;
    if ((sessionId === undefined) !== (sessionName === undefined)) {
      return json(res, { error: "sessionId and sessionName must be provided together" }, 400);
    }
    const message = body.message.slice(0, 500);
    let payload;
    try {
      payload = buildAgentNotificationPayload(message, sessionId !== undefined && sessionName !== undefined ? {
        sessionId,
        sessionName,
      } : undefined);
    } catch {
      return json(res, { error: "invalid notification session target" }, 400);
    }

    const rateLimitError = checkNotifyRateLimit();
    if (rateLimitError) return json(res, { error: rateLimitError }, 429);

    const result = await sendPush(payload);
    json(res, { ok: true, ...result });
  },
};
