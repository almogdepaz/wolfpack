import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "./context.js";
import { json, parseObjectBody, hasOnlyKeys } from "./http.js";
import { getInstallationId } from "../tailnet-machine-installation.js";
import { FocusConflict, FocusValidationError } from "./focus-store.js";
import { errMsg } from "../log.js";
import { InvalidInboxFile, UnknownInboxFile } from "../focus-coverage.js";

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
    "GET /api/focus": async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        const current = envelope();
        // Opening the dashboard is a catch-up trigger; the debounce still applies.
        if (current.local && new URL(req.url ?? "/", "http://localhost").searchParams.get("open") === "1") void ctx.focusRuntime.routines.tick();
        json(res, { ...current, ...(current.local && { assistant: await ctx.focusRuntime.status(), routines: ctx.focusRuntime.routines.status(current.document?.daySummary?.date) }) });
      }
      catch (error) { json(res, { error: errMsg(error) }, 503); }
    },
    "POST /api/focus/assistant": async (req: IncomingMessage, res: ServerResponse) => {
      if (!identity().local) return json(res, { error: "enable the assistant on the focus home machine" }, 409);
      const body = await parseObjectBody(req, res);
      if (!body) return;
      if (!hasOnlyKeys(body, new Set(["enabled", "loginConfirmed"])) || typeof body.enabled !== "boolean" || (body.loginConfirmed !== undefined && typeof body.loginConfirmed !== "boolean")) return json(res, { error: "enabled boolean required" }, 400);
      try {
        if (body.enabled) {
          await ctx.assistantService.enable(body.loginConfirmed === true);
          ctx.focusRuntime.pins.reset("assistant");
          ctx.focusRuntime.queue.clear();
          ctx.focusRuntime.start();
          await ctx.focusRuntime.pins.tick();
        } else {
          await ctx.focusRuntime.pins.tick();
          ctx.assistantService.unpin("assistant");
          ctx.focusRuntime.queue.clear("assistant disabled");
          const facts = await ctx.backend.listSessionFacts();
          const session = facts.find(f => f.alive && f.name === "assistant" && f.identity?.projectPath === ctx.assistantService.folder);
          if (session?.identity) await ctx.backend.killSessionById(session.identity.wolfpackSessionId);
        }
        json(res, await ctx.focusRuntime.status());
      } catch (error) { json(res, { error: errMsg(error) }, 409); }
    },
    "POST /api/focus/ask": async (req: IncomingMessage, res: ServerResponse) => {
      if (!identity().local) return json(res, { error: "assistant is on the home machine" }, 409);
      const body = await parseObjectBody(req, res);
      if (!body) return;
      if (!hasOnlyKeys(body, new Set(["text"])) || typeof body.text !== "string") return json(res, { error: "text required" }, 400);
      try { json(res, await ctx.focusRuntime.ask(body.text)); }
      catch (error) { json(res, { error: errMsg(error) }, 409); }
    },
    "POST /api/focus/catch-up": async (_req: IncomingMessage, res: ServerResponse) => {
      if (!identity().local) return json(res, { error: "catch-up runs on the focus home machine" }, 409);
      if (!ctx.assistantService.enabled) return json(res, { error: "assistant is off" }, 409);
      const refusal = ctx.focusRuntime.routines.manualRefusal();
      if (refusal) return json(res, { error: refusal }, 409);
      await ctx.focusRuntime.routines.tick({ manual: true });
      json(res, ctx.focusRuntime.routines.status());
    },
    "GET /api/focus/day-note": async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Cache-Control", "no-store");
      if (!identity().local) return json(res, { error: "day notes live on the focus home machine" }, 409);
      const date = new URL(req.url ?? "/", "http://localhost").searchParams.get("date") ?? "";
      try {
        const markdown = ctx.focusRuntime.routines.dayNote(date);
        if (markdown === null) return json(res, { error: "no day note for that date" }, 404);
        json(res, { date, markdown });
      } catch (error) { json(res, { error: errMsg(error) }, 400); }
    },
    "POST /api/activity/ack": async (req: IncomingMessage, res: ServerResponse) => {
      if (!identity().local) return json(res, { error: "ack on the focus home machine" }, 409);
      const body = await parseObjectBody(req, res);
      if (!body) return;
      if (!hasOnlyKeys(body, new Set(["file"])) || typeof body.file !== "string") return json(res, { error: "file required" }, 400);
      try { json(res, await ctx.focusRuntime.routines.ack(body.file)); }
      catch (error) { json(res, { error: errMsg(error) }, error instanceof UnknownInboxFile ? 404 : error instanceof InvalidInboxFile ? 400 : 503); }
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
        json(res, { error: errMsg(error) }, error instanceof FocusValidationError ? 400 : 503);
      }
    },
  };
}
