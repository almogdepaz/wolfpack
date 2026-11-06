import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "./context.js";
import { json, parseObjectBody, hasOnlyKeys } from "./http.js";
import { getInstallationId } from "../tailnet-machine-installation.js";
import { FocusConflict } from "./focus-store.js";
import { PersistenceReadError } from "../persistence.js";
import { errMsg } from "../log.js";

export function createFocusRoutes(ctx: ServerContext) {
  const identity = () => {
    const installationId = getInstallationId();
    const home = ctx.config?.focus?.home ?? installationId;
    return { home, installationId, local: home === installationId };
  };
  const envelope = () => {
    const owner = identity();
    const document = owner.local ? ctx.focusStore.read() : null;
    return { ...owner, document, revision: document?.revision ?? 0 };
  };
  return {
    "GET /api/focus": (_req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Cache-Control", "no-store");
      try { json(res, envelope()); }
      catch (error) { json(res, { error: errMsg(error) }, 503); }
    },
    "POST /api/focus": async (req: IncomingMessage, res: ServerResponse) => {
      const owner = identity();
      if (!owner.local) return json(res, { ...owner, error: "focus is owned by the home machine" }, 409);
      const body = await parseObjectBody(req, res);
      if (!body) return;
      if (!hasOnlyKeys(body, new Set(["expectedRevision", "ops"])) || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) return json(res, { error: "expectedRevision must be a non-negative integer" }, 400);
      try {
        const document = ctx.focusStore.update(body.expectedRevision as number, body.ops);
        json(res, { ...owner, document, revision: document.revision });
      } catch (error) {
        if (error instanceof FocusConflict) return json(res, { ...owner, error: error.message, document: error.document, revision: error.document?.revision ?? 0 }, 409);
        json(res, { error: errMsg(error) }, error instanceof PersistenceReadError ? 503 : 400);
      }
    },
  };
}
