/**
 * HTTP route handlers.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { execFile } from "node:child_process";
import { createLogger, errMsg } from "../log.js";
import { clampCols, clampRows, isValidProjectName } from "../validation.js";

import { assets } from "../public-assets.js";
import { getAgentRuntimeStateStore } from "./agent-status.js";
import pkg from "../../package.json";
import { issueWebSocketTicket } from "./ws-ticket.js";
import {
  boundedMetrics,
  classifyRequestClient,
  operationalHealth,
  prometheusMetrics,
} from "./operability.js";
import { getBackend, getRouter } from "./backend.js";

import {
  hasOnlyKeys,
  isAllowedSession,
  json,
  parseObjectBody,
  serveFile,
  enumerateLocalTailnetCandidates,
  getLocalMachineHandshake,
} from "./http.js";
import { activePtySessions, teardownPty } from "./websocket.js";
import {
  forgetSessionObservation,
  observeDashboardSessions,
} from "./session-observation.js";
export {
  __resetSessionObservationForTests,
  __runSessionNotificationObservationForTests,
} from "./session-observation.js";
import { taskRoutes } from "./task-routes.ts";
import { taskRelayRoutes } from "./task-relay-routes.ts";
import { getTaskGateway } from "../tasks/gateway.ts";
import { projectSettingsRoutes } from "./project-settings-routes.js";
import { resolveActiveSession, sessionControlRoutes } from "./session-control-routes.js";
import { pushNotifyRoutes, pushSubscriptionRoutes } from "./push-routes.js";

const log = createLogger("routes");
const RESIZE_BODY_KEYS = new Set(["session", "cols", "rows"]);

interface AgentRuntimeAckBody extends Record<string, unknown> {
  sessionId: string;
  transitionSequence: number;
}

function isAgentRuntimeAckBody(body: Record<string, unknown>): body is AgentRuntimeAckBody {
  const allowedKeys = new Set(["sessionId", "transitionSequence"]);
  return Object.keys(body).every(key => allowedKeys.has(key))
    && typeof body.sessionId === "string"
    && body.sessionId.length > 0
    && typeof body.transitionSequence === "number"
    && Number.isInteger(body.transitionSequence)
    && body.transitionSequence > 0;
}

/** Validate project name param. Returns project string or sends 400 and returns null. */
function validateProject(res: ServerResponse, project: string | null | undefined): project is string {
  if (!project || !isValidProjectName(project)) {
    json(res, { error: "invalid project" }, 400);
    return false;
  }
  return true;
}

const VERSION: string = pkg.version;
export const routes: Record<
  string,
  (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
> = {
  "GET /": (req, res) => serveFile(res, "index.html", req),
  "GET /manifest.json": (req, res) => {
    const asset = assets.get("manifest.json");
    if (!asset) { res.writeHead(404); res.end("Not Found"); return; }
    const url = new URL(req.url ?? "/", "http://localhost");
    const customName = url.searchParams.get("name");
    const host = (req.headers.host ?? "localhost").replace(/[:.]/g, "-");
    const manifest = JSON.parse(asset.content as string);
    manifest.id = `/?host=${host}`;
    if (customName) {
      const safeName = customName.replace(/[^\w\s\-().]/g, "").slice(0, 50);
      manifest.name = safeName;
      manifest.short_name = safeName;
    } else {
      const label = host.split("-").slice(0, -1).join("-") || host;
      manifest.name = `Wolfpack (${label})`;
      manifest.short_name = label;
    }
    res.writeHead(200, { "Content-Type": "application/manifest+json" });
    res.end(JSON.stringify(manifest, null, 2));
  },

  "GET /api/info": (_req, res) => {
    const name = hostname()
      .replace(/\.local$/, "")
      .replace(/\.tail[a-z0-9-]*\.ts\.net$/i, "");
    json(res, { name, version: VERSION, machineId: getTaskGateway().machineId });
  },

  "GET /api/machine": async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const handshake = await getLocalMachineHandshake(VERSION);
    if (!handshake) return json(res, { error: "tailnet machine identity unavailable" }, 503);
    json(res, handshake);
  },

  "GET /api/sessions": async (_req, res) => {
    json(res, { sessions: await observeDashboardSessions() });
  },

  "POST /api/agent-runtime-state/ack": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    if (!isAgentRuntimeAckBody(body)) {
      return json(res, { error: "sessionId and positive integer transitionSequence required" }, 400);
    }
    const runtimeState = getAgentRuntimeStateStore().acknowledge(body.sessionId, body.transitionSequence);
    if (!runtimeState) return json(res, { error: "runtime state not found" }, 404);
    json(res, { ok: true, runtimeState });
  },

  ...projectSettingsRoutes,

  "GET /api/backend": async (_req, res) => {
    const router = getRouter();
    const counts = await router.getSessionCounts();
    json(res, {
      brokerAvailable: router.isBrokerAvailable(),
      counts,
    });
  },

  "POST /api/kill": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    const selector = body.session;
    if (typeof selector !== "string" || !selector) return json(res, { error: "missing session" }, 400);
    const resolved = await resolveActiveSession(res, selector);
    if (!resolved) return;
    // Clean up any associated desktop PTY session (wp_*) before killing
    teardownPty(resolved.name);
    forgetSessionObservation(resolved.identity.wolfpackSessionId, resolved.name);
    await getBackend().killSession(resolved.name);
    json(res, {
      ok: true,
      session: resolved.name,
      sessionId: resolved.identity.wolfpackSessionId,
    });
  },

  ...sessionControlRoutes,

  "POST /api/resize": async (req, res) => {
    const body = await parseObjectBody(req, res);
    if (!body) return;
    const { session, cols, rows } = body;
    if (
      !hasOnlyKeys(body, RESIZE_BODY_KEYS) ||
      typeof session !== "string" || !session ||
      typeof cols !== "number" || !Number.isInteger(cols) ||
      typeof rows !== "number" || !Number.isInteger(rows)
    ) return json(res, { error: "missing params" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    if (!activePtySessions.has(session)) {
      try {
        await getBackend().resize(session, clampCols(cols), clampRows(rows));
      } catch (e: unknown) {
        log.warn("resize failed", { session, error: errMsg(e) });
        return json(res, { error: "backend unavailable" }, 503);
      }
    }
    json(res, { ok: true });
  },

  "GET /api/tailnet/v1/candidates": async (_req, res) => {
    json(res, await enumerateLocalTailnetCandidates());
  },

  "GET /api/discover": async (_req, res) => {
    const discovery = await enumerateLocalTailnetCandidates();
    res.setHeader("Deprecation", "true");
    res.setHeader("Link", '</api/tailnet/v1/candidates>; rel="successor-version"');
    json(res, {
      peers: discovery.candidates
        .filter((candidate) => candidate.online)
        .map((candidate) => ({
          hostname: candidate.hostname,
          url: candidate.origin,
          name: candidate.hostname,
        })),
      ...(discovery.error ? { error: discovery.error } : {}),
    });
  },

  "GET /api/poll": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const session = url.searchParams.get("session");
    if (!session) return json(res, { error: "missing session param" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    const pane = await getBackend().capturePane(session);
    json(res, { pane });
  },

  "GET /api/copy-text": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const session = url.searchParams.get("session");
    if (!session) return json(res, { error: "missing session param" }, 400);
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    const text = await getBackend().capturePane(session);
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(text);
  },

  "GET /api/git-status": async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const session = url.searchParams.get("session");
    if (!validateProject(res, session)) return;
    if (!(await isAllowedSession(session)))
      return json(res, { error: "session not found" }, 404);
    const projectDir = getBackend().sessionDir(session);
    if (!projectDir || !existsSync(projectDir))
      return json(res, { error: "project directory not found" }, 404);
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile("git", ["status", "--short", "--branch"], { cwd: projectDir }, (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr || err.message));
          resolve(stdout);
        });
      });
      json(res, { status: output });
    } catch (e: unknown) {
      json(res, { error: errMsg(e) || "git status failed" }, 500);
    }
  },

  // ── Readiness and bounded operational metrics ──

  "GET /api/health": (_req, res) => {
    const health = operationalHealth();
    json(res, health, health.status === "ready" ? 200 : 503);
  },

  "GET /api/metrics": (_req, res) => json(res, boundedMetrics()),

  "GET /metrics": (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(prometheusMetrics());
  },

  // ── Browser authentication ──

  "POST /api/auth/ws-ticket": (req, res) => {
    const client = classifyRequestClient({
      remoteAddress: req.socket.remoteAddress,
      tailscaleUserLogin: req.headers["tailscale-user-login"],
    });
    json(res, issueWebSocketTicket(client.clientKey));
  },

  // ── Push notifications ──

  ...pushSubscriptionRoutes,

  // ── Agent-triggered notifications ──

  ...taskRoutes,
  ...taskRelayRoutes,

  ...pushNotifyRoutes,
};
