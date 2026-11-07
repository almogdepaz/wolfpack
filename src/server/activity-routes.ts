import type { IncomingMessage, ServerResponse } from "node:http";
import { parseActivityQuery } from "../activity-journal.js";
import { getMachineDisplayName } from "../machine-display-name.js";
import { getInstallationId } from "../tailnet-machine-installation.js";
import type { ServerContext } from "./context.js";
import { json } from "./http.js";
import { errMsg } from "../log.js";

export function createActivityRoutes(ctx: ServerContext) {
  return {
    /** This machine's journal since a cursor. Same owner auth and peer reachability as /api/sessions. */
    "GET /api/activity": (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Cache-Control", "no-store");
      const query = parseActivityQuery(new URL(req.url ?? "/", "http://localhost").searchParams);
      if (!query.ok) return json(res, { error: query.error }, 400);
      try {
        const page = ctx.activityJournal.read(query.since, query.limit);
        const { lastRowAt, lastInputAt } = ctx.activityJournal.status();
        json(res, { installationId: getInstallationId(), machine: getMachineDisplayName(), ...page, lastRowAt, lastInputAt });
      } catch (error) { json(res, { error: errMsg(error) }, 503); }
    },
  };
}
