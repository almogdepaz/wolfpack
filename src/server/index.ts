/**
 * Wolfpack server — HTTP + WebSocket server creation, CORS, startup.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { WebSocketServer } from "ws";

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import pkg from "../../package.json";
import { validateRequestJwt, getCachedJwtAuthConfig, verifyJwtAuthAtStartup } from "../auth.js";
import { SHELL } from "./shell.js";
import { initBackend, getBackend, getRouter } from "./backend.js";
import { routes } from "./routes.js";
import { getTaskGateway } from "../tasks/gateway.ts";
import {
  startSessionNotificationObserver,
  stopSessionNotificationObserver,
} from "./session-observation.js";
import {
  json,
  serveFile,
  shouldAuthenticateApiPath,
  writeUnauthorized,
  isAllowedSession,
  createPerIpRateLimiter,
} from "./http.js";
import { handlePtyWs } from "./websocket.js";
import { createLogger, errMsg } from "../log.js";
import { isValidSessionName } from "../validation.js";
import { loadConfig } from "../cli/config.js";
import { createTailnetOriginPolicy } from "./tailnet-origin-policy.js";

const log = createLogger("server");

const PORT =
  Number(process.env.WOLFPACK_PORT) || Number(process.argv[2]) || 18790;
const VERSION: string = pkg.version;

// inherit user's full PATH from login shell — launchd PATH is minimal
try {
  const shellPath = execFileSync(SHELL, ["-lic", "echo $PATH"]).toString().trim();
  if (shellPath) process.env.PATH = shellPath;
} catch { /* shell PATH extraction failed — apply common fallback paths */
  const extra = [
    `${process.env.HOME}/.local/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const cur = process.env.PATH || "";
  const have = new Set(cur.split(":"));
  const add = extra.filter(p => !have.has(p) && existsSync(p));
  if (add.length) process.env.PATH = [...add, cur].join(":");
}

// Cross-origin Tailnet access derives solely from the canonical hostname that
// setup persisted after Serve verification. No forwarded/request header can
// expand this authority.
const configuredTailnetHostname = loadConfig()?.tailscaleHostname;
const originPolicy = createTailnetOriginPolicy({
  port: PORT,
  tailscaleHostname: configuredTailnetHostname,
  testMode: Boolean(process.env.WOLFPACK_TEST),
});
if (!configuredTailnetHostname) {
  log.warn("no verified tailscaleHostname in config — remote browser access will be blocked by CORS", { hint: "run 'wolfpack setup' to fix" });
}

function isAllowedOrigin(origin: string): boolean {
  return originPolicy.isAllowed(origin);
}

// ── Rate limiting ──

/** Poll-heavy endpoints get a tighter limit (10 req/s per IP). */
const POLL_HEAVY_PATHS = new Set([
  "/api/sessions",
  "/api/machine",
  "/api/tailnet/v1/candidates",
  "/api/discover",
]);
const pollRateLimiter = createPerIpRateLimiter(10);

/** Global limit for all routes (120 req/s per IP). */
const globalRateLimiter = createPerIpRateLimiter(120);

export { pollRateLimiter as __pollRateLimiter, globalRateLimiter as __globalRateLimiter };

// ── Server factory ──

/** Create an isolated server + WebSocketServer pair. Used by tests for parallel isolation. */
export function createServerInstance(): { server: ReturnType<typeof createServer>; wss: InstanceType<typeof WebSocketServer> } {
  const wss = new WebSocketServer({ noServer: true });

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin ?? originPolicy.recoverServeOrigin(req.headers);
    if (origin) {
      if (isAllowedOrigin(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        res.setHeader("Vary", "Origin");
      } else {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "origin not allowed" }));
        return;
      }
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    if (shouldAuthenticateApiPath(url.pathname)) {
      const auth = validateRequestJwt(req.headers, url, false);
      if (!auth.ok) {
        log.debug("jwt auth failed", { path: url.pathname, reason: auth.error });
        writeUnauthorized(res);
        return;
      }
    }

    // Rate limiting — per-IP, checked before route dispatch
    const clientIp = req.socket.remoteAddress ?? "unknown";
    if (!globalRateLimiter.allow(clientIp)) {
      json(res, { error: "rate limit exceeded" }, 429);
      return;
    }
    if (POLL_HEAVY_PATHS.has(url.pathname) && !pollRateLimiter.allow(clientIp)) {
      json(res, { error: "rate limit exceeded" }, 429);
      return;
    }

    const key = `${req.method ?? "GET"} ${url.pathname}`;
    const handler = routes[key];
    if (handler) {
      try {
        await handler(req, res);
      } catch (err) {
        log.error("route error", { error: String(err) });
        if (!res.headersSent) json(res, { error: "internal error" }, 500);
      }
    } else {
      const safePath = url.pathname.replace(/^\/+/, "");
      if (safePath && !safePath.includes("\0") && !safePath.includes("/")) {
        serveFile(res, safePath, req);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    }
  });

  server.on("upgrade", async (req, socket, head) => {
    try {
      const origin = req.headers.origin;
      if (origin && !isAllowedOrigin(origin)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");

      const auth = validateRequestJwt(req.headers, url, true);
      if (!auth.ok) {
        log.debug("jwt auth failed (ws upgrade)", { path: url.pathname, reason: auth.error });
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      if (url.pathname !== "/ws/pty") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      const session = url.searchParams.get("session");
      if (!session || !isValidSessionName(session) || !(await isAllowedSession(session))) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const reset = url.searchParams.get("reset") === "1";
      wss.handleUpgrade(req, socket, head, (ws) => handlePtyWs(ws, session, reset));
    } catch (e: unknown) {
      log.error("ws upgrade error", { error: errMsg(e) });
      if (!socket.destroyed) {
        try { socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n"); } catch { /* socket already unusable */ }
        socket.destroy();
      }
    }
  });

  return { server, wss };
}

// Module-level singleton for production
const { server, wss } = createServerInstance();

export async function startServer(port = PORT, host = "127.0.0.1"): Promise<void> {
  // Verify JWT auth configuration BEFORE any listeners are bound. We fail
  // hard on misconfiguration (secret set but rejected) so a typo can never
  // silently disable authentication. A missing secret is surfaced as an
  // informational notice because Tailscale is the default remote-access boundary.
  const authCfg = getCachedJwtAuthConfig();
  const authStatus = verifyJwtAuthAtStartup(authCfg);
  if (authStatus === "invalid") {
    log.error("refusing to start: WOLFPACK_JWT_SECRET is set but invalid", {
      reason: authCfg.invalidReason,
      hint: "unset WOLFPACK_JWT_SECRET to run without auth, or use a 32+ char value",
    });
    process.exit(1);
  }
  if (authStatus === "missing") {
    log.info("WOLFPACK_JWT_SECRET is not set — ALL API ENDPOINTS ARE UNAUTHENTICATED", {
      hint: "set WOLFPACK_JWT_SECRET (32+ chars) to enable authentication",
    });
  }

  // Initialize session backend (broker is the only supported backend; the
  // WOLFPACK_BACKEND env var is accepted for back-compat but ignored).
  initBackend();
  log.info("backend initialized", { type: "broker" });

  // Verify the broker handshake before listening so we surface a clear error
  // before any session-create requests land. The router has already done a
  // sync socket-file probe; this catches the case where the file exists but
  // the daemon is dead or unresponsive.
  const router = getRouter();
  if (router.isBrokerAvailable()) {
    const ok = await router.verifyBrokerHandshake();
    if (!ok) {
      log.error("broker unreachable", { socketPath: router.getBrokerSocketPath() });
    } else {
      log.info("broker reachable", { socketPath: router.getBrokerSocketPath() });
    }
  }

  await getTaskGateway().initialize();
  getBackend().cleanupOrphans();
  startSessionNotificationObserver();
  server.once("close", stopSessionNotificationObserver);

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error("port already in use", { port, hint: "run 'wolfpack service stop' first" });
      process.exit(1);
    }
    log.error("server error", { error: err.message });
    process.exit(1);
  });

  server.listen(port, host, () => {
    log.info("server started", { url: `http://localhost:${port}/` });
  });
}

export { server, wss };

// Auto-start unless in test mode
if (!process.env.WOLFPACK_TEST) {
  startServer().catch((err: unknown) => {
    log.error("server start failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
