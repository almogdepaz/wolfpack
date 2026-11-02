import { SESSION_ORGANIZATION_ID, SESSION_ORGANIZATION_MAX_REQUEST_BYTES, SessionOrganizationError } from "../session-organization-contract.ts";
import { createLogger, errMsg } from "../log.ts";
import type { ServerContext } from "./context.ts";
import { json, parseObjectBody } from "./http.ts";
import type { RouteHandler } from "./route-handler.ts";
const log = createLogger("routes");

export function createSessionOrganizationRoutes(ctx: ServerContext): Record<string, RouteHandler> {
  const handle: RouteHandler = async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const mutation = req.method === "POST";
    const body = mutation ? await parseObjectBody(req, res, { maxBytes: SESSION_ORGANIZATION_MAX_REQUEST_BYTES, respondOnTooLarge: true }) : null;
    if (mutation && !body) return;
    const sessionId = mutation ? body!.sessionId : new URL(req.url ?? "/", "http://localhost").searchParams.get("sessionId");
    if (typeof sessionId !== "string" || !SESSION_ORGANIZATION_ID.test(sessionId)) return json(res, { code: "INVALID_ORGANIZATION", error: "canonical session UUID required" }, 400);
    // Inspect exact UUID after reading the body. Never fall back to a reusable name.
    try {
      const inspection = await ctx.backend.inspectSession(sessionId);
      if (!inspection.ok || inspection.sessionId !== sessionId) return json(res, { code: "SESSION_NOT_FOUND", error: "session not found" }, 404);
      if (!inspection.alive) return json(res, { code: "SESSION_DEAD", error: "session is not alive" }, 410);
    } catch (error) {
      log.warn("organization target inspection failed", { error: errMsg(error) });
      return json(res, { code: "BACKEND_UNAVAILABLE", error: "backend unavailable" }, 503);
    }
    try {
      const { sessionId: _id, ...update } = body ?? {};
      const organization = mutation ? ctx.sessionOrganization.update(sessionId, update) : ctx.sessionOrganization.read(sessionId);
      return json(res, { sessionId, organization });
    } catch (error) {
      if (error instanceof SessionOrganizationError) return json(res, { code: error.code, error: error.message }, error.code === "ORGANIZATION_CONFLICT" ? 409 : 400);
      log.warn("organization storage failed", { sessionId, error: errMsg(error) });
      return json(res, { code: "ORGANIZATION_UNAVAILABLE", error: "organization storage unavailable; read again before retrying an uncertain save" }, 503);
    }
  };
  return { "GET /api/session-control/organization": handle, "POST /api/session-control/organization": handle };
}
