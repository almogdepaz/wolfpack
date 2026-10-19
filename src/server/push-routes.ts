import type { IncomingMessage, ServerResponse } from "node:http";
import {
  addSubscription,
  buildAgentNotificationPayload,
  checkNotifyRateLimit,
  getSubscriptionCount,
  getVapidPublicKey,
  removeSubscription,
  sendPush,
  sendTestPush,
  validateSubscription,
} from "./push.js";
import type { PushSubscription } from "./push.js";
import {
  isJsonObject,
  json,
  parseObjectBody,
} from "./http.js";
import { resetNotificationObservation } from "./session-observation.js";
import { notifyDelivery } from "../notify-contract.js";
import { defaultServerContext, type ServerContext } from "./context.js";
import { appendParentNotification } from "./parent-inbox.js";
import { WOLFPACK_EVENT_KIND } from "../events-contract.js";
import { createLogger, errMsg } from "../log.js";

const log = createLogger("push");

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

  "POST /api/push/test": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    if (typeof body.endpoint !== "string" || !body.endpoint || body.endpoint.length > 1024) return json(res, { error: "invalid endpoint" }, 400);
    const rateLimitError = checkNotifyRateLimit();
    if (rateLimitError) return json(res, { error: rateLimitError }, 429);
    const result = await sendTestPush(body.endpoint);
    if (!result) return json(res, { error: "endpoint not registered" }, 404);
    json(res, { ok: result.sent === 1 && result.failed === 0, ...result }, result.sent === 1 && result.failed === 0 ? 200 : 502);
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

export function createPushNotifyRoutes(ctx: Pick<ServerContext, "backend" | "events">): Record<string, RouteHandler> {
return {
  "POST /api/notify": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    if (!body.message || typeof body.message !== "string") return json(res, { error: "missing message" }, 400);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    const sessionName = typeof body.sessionName === "string" ? body.sessionName : undefined;
    if ((sessionId === undefined) !== (sessionName === undefined)) {
      return json(res, { error: "sessionId and sessionName must be provided together" }, 400);
    }
    if (body.from !== undefined && (typeof body.from !== "string" || [...body.from].length > 100)) {
      return json(res, { error: "invalid notification sender" }, 400);
    }
    const from = typeof body.from === "string" ? body.from : undefined;
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

    let parentInbox: { queued: true; seq: number } | { queued: false; reason: "no_parent" | "parent_not_found" } =
      { queued: false, reason: sessionId === undefined ? "no_parent" : "parent_not_found" };
    if (sessionId !== undefined) {
      let exited = false;
      // Raw backend exits are immediate even while public reason classification waits for a kill reply.
      let unsubscribe: (() => void) | undefined;
      try {
        unsubscribe = ctx.backend.onSessionLifecycleById(sessionId, event => {
          if (event.kind === "exited") exited = true;
        });
        const inspection = await ctx.backend.inspectSession(sessionId);
        // Selectors can also be names; require this exact live incarnation.
        if (!exited && inspection.ok && inspection.alive && inspection.sessionId === sessionId && inspection.session === sessionName) {
          const notification = { message, ...(from !== undefined && { from }) };
          const { seq } = appendParentNotification(sessionId, notification);
          parentInbox = { queued: true, seq };
          ctx.events.publishEvent({ kind: WOLFPACK_EVENT_KIND.PARENT_NOTIFIED, session: inspection.session, sessionId, seq, ...notification });
        }
      } catch (error: unknown) {
        // Inbox lookup must not change the existing push delivery contract.
        log.warn("parent inbox target inspection failed", { error: errMsg(error) });
      } finally {
        unsubscribe?.();
      }
    }

    const result = await sendPush(payload);
    // `ok` means accepted; `delivered`/`reason` say whether any device got it.
    json(res, { ok: true, ...result, ...notifyDelivery(result), parentInbox });
  },
};
}

export const pushNotifyRoutes = createPushNotifyRoutes(defaultServerContext);
