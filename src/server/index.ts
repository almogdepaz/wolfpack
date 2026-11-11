/**
 * Wolfpack server — HTTP + WebSocket server creation, CORS, startup.
 */
import { createServer } from "node:http";
import { SERVER_LISTENING } from "../server-startup-contract.js";
import { assertSupportedBunRuntime } from "../runtime-version.ts";
import { WebSocketServer } from "ws";

import { join } from "node:path";
import { validateRequestJwt, getCachedJwtAuthConfig, verifyJwtAuthAtStartup } from "../auth.js";
import { SHELL } from "./shell.js";
import { resolveLoginShellPath } from "./login-shell-path.js";
import { createServerContext, setDefaultServerContext, type ServerContext, type ServerContextOptions } from "./context.js";
import { createRoutes } from "./routes.js";
import {
  json,
  serveFile,
  shouldAuthenticateApiPath,
  writeUnauthorized,
  isAllowedSession,
  createPerIpRateLimiter,
} from "./http.js";
import { createLogger, errMsg, writeFatalError } from "../log.js";
import { isValidSessionName } from "../validation.js";
import { PTY_WEBSOCKET_MAX_PAYLOAD_BYTES } from "../ws-constants.js";
import { childEventTypedNotesEnabled, WOLFPACK_DIR } from "../config.js";
import {
  SESSION_SEND_DEFAULT_OBSERVE_MS, SESSION_SEND_DELIVERY, SESSION_SEND_FAILURE_REASON, SESSION_SEND_OUTCOME,
} from "../session-send-contract.js";
import { startLogRotationMonitor } from "../log-rotation.js";
import { createTailnetOriginPolicy } from "./tailnet-origin-policy.js";
import { createHostPolicy } from "./host-policy.js";
import { classifyRequestClient, isLoopbackAddress } from "./operability.js";
import { installShutdownSignalHandlers } from "./shutdown.js";

const log = createLogger("server");

const PORT =
  Number(process.env.WOLFPACK_PORT) || Number(process.argv[2]) || 18790;

// ── Rate limiting ──

/** Poll-heavy endpoints get a tighter limit (10 req/s per IP). */
const POLL_HEAVY_PATHS = new Set([
  "/api/sessions",
  "/api/machine",
  "/api/tailnet/v1/candidates",
  "/api/discover",
]);
export const MAX_WS_CONNECTIONS_PER_IP = 32;

// ── Server factory ──

export interface ServerInstanceOptions {
  readonly port?: number;
  /** Also permit HTTP origins on 127.0.0.1 at arbitrary ports; production defaults to false. */
  readonly allowLocalOrigins?: boolean;
}

/** Create an isolated server, WebSocketServer and request quotas. */
export function createServerInstance(ctx: ServerContext, options: ServerInstanceOptions = {}) {
  // Cross-origin Tailnet access derives solely from the canonical hostname that
  // setup persisted after Serve verification. No forwarded/request header can
  // expand this authority.
  const configuredServer = ctx.config;
  const configuredTailnetHostname = configuredServer?.tailscaleHostname;
  const hostPolicy = createHostPolicy({
    configuredHostname: configuredTailnetHostname,
    extraHosts: configuredServer?.allowedHosts ?? [],
    readSelfStatus: () => ctx.readTailscaleStatus(true),
  });
  const originPolicy = createTailnetOriginPolicy({
    port: options.port ?? PORT,
    tailscaleHostname: configuredTailnetHostname,
    testMode: options.allowLocalOrigins ?? false,
  });
  if (!configuredTailnetHostname) {
    log.warn("no verified tailscaleHostname in config — remote browser access will be blocked by CORS", { hint: "run 'wolfpack setup' to fix" });
  }

  function isAllowedOrigin(origin: string): boolean {
    return originPolicy.isAllowed(origin);
  }

  const pollRateLimiter = createPerIpRateLimiter(10);

  /** Global limit for all routes (120 req/s per IP). */
  const globalRateLimiter = createPerIpRateLimiter(120);
  /** WebSocket upgrade attempts per second per IP, before auth/backend work. */
  const wsUpgradeRateLimiter = createPerIpRateLimiter(20);
  const wsConnectionsByIp = new Map<string, number>();

  function reserveWsConnection(ip: string): boolean {
    const current = wsConnectionsByIp.get(ip) ?? 0;
    if (current >= MAX_WS_CONNECTIONS_PER_IP) return false;
    wsConnectionsByIp.set(ip, current + 1);
    return true;
  }

  function releaseWsConnection(ip: string): void {
    const current = wsConnectionsByIp.get(ip) ?? 0;
    if (current <= 1) wsConnectionsByIp.delete(ip);
    else wsConnectionsByIp.set(ip, current - 1);
  }

  const routes = createRoutes(ctx);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: PTY_WEBSOCKET_MAX_PAYLOAD_BYTES,
  });

  const server = createServer(async (req, res) => {
    try {
      if (!(await hostPolicy.isAllowed(req.headers.host))) {
        const sanitizedHost = (req.headers.host ?? "").slice(0, 255).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
        log.warn("host not allowed", { host: sanitizedHost });
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "host not allowed" }));
        return;
      }
      const directOrigin = req.headers.origin;
      const recoveredServeOrigin = directOrigin
        ? undefined
        : originPolicy.recoverTailscaleServeOrigin({
            fromLoopback: isLoopbackAddress(req.socket.remoteAddress),
            tailscaleUserLogin: req.headers["tailscale-user-login"],
            referer: req.headers.referer,
          });
      const origin = directOrigin ?? recoveredServeOrigin;
      res.setHeader("Vary", directOrigin ? "Origin" : "Origin, Referer, Tailscale-User-Login");
      if (origin) {
        if (isAllowedOrigin(origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        json(res, { error: "invalid request URL" }, 400);
        return;
      }
      const client = classifyRequestClient({
        remoteAddress: req.socket.remoteAddress,
        tailscaleUserLogin: req.headers["tailscale-user-login"],
      });
      const operationalPath = url.pathname === "/api/health" || url.pathname === "/api/metrics" || url.pathname === "/metrics";
      const localOperationalRequest = operationalPath && client.isDirectLoopback;
      if ((shouldAuthenticateApiPath(url.pathname) || url.pathname === "/metrics") && !localOperationalRequest) {
        const auth = validateRequestJwt(req.headers, url, false, ctx.jwtAuthConfig);
        if (!auth.ok) {
          log.debug("jwt auth failed", { path: url.pathname, reason: auth.error });
          writeUnauthorized(res);
          return;
        }
      }

      // Rate limiting — per-IP, checked before route dispatch
      if (!globalRateLimiter.allow(client.clientKey)) {
        json(res, { error: "rate limit exceeded" }, 429);
        return;
      }
      if (POLL_HEAVY_PATHS.has(url.pathname) && !pollRateLimiter.allow(client.clientKey)) {
        json(res, { error: "rate limit exceeded" }, 429);
        return;
      }

      if (await ctx.extensionRouteService.handle(req, res, url)) return;
      const key = `${req.method ?? "GET"} ${url.pathname}`;
      const handler = routes[key];
      if (handler) {
        await handler(req, res);
      } else {
        const safePath = url.pathname.replace(/^\/+/, "");
        if (safePath && !safePath.includes("\0") && !safePath.includes("/")) serveFile(res, safePath, req);
        else { res.writeHead(404); res.end("Not Found"); }
      }
    } catch (err) {
      log.error("route error", { error: String(err) });
      if (!res.headersSent) json(res, { error: "internal error" }, 500);
      else if (!res.writableEnded) res.destroy();
    }
  });

  server.on("upgrade", async (req, socket, head) => {
    let reservedIp: string | null = null;
    try {
      const client = classifyRequestClient({
        remoteAddress: req.socket.remoteAddress,
        tailscaleUserLogin: req.headers["tailscale-user-login"],
      });
      if (!wsUpgradeRateLimiter.allow(client.clientKey)) {
        socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
        return;
      }
      if (!(await hostPolicy.isAllowed(req.headers.host))) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      if (!reserveWsConnection(client.clientKey)) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        return;
      }
      reservedIp = client.clientKey;
      const origin = req.headers.origin;
      if (origin && !isAllowedOrigin(origin)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");

      const ticket = url.searchParams.get("ticket");
      const ticketOk = ticket ? ctx.webSocketTickets.consumeWebSocketTicket(ticket, client.clientKey) : false;
      const auth = ticketOk ? { ok: true } : validateRequestJwt(req.headers, url, true, ctx.jwtAuthConfig);
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
      if (!session || !isValidSessionName(session) || !(await isAllowedSession(session, ctx.backend))) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const reset = url.searchParams.get("reset") === "1";
      wss.handleUpgrade(req, socket, head, (ws) => {
        const activeClientKey = client.clientKey;
        reservedIp = null;
        ws.once("close", () => releaseWsConnection(activeClientKey));
        ctx.terminals.handlePtyWs(ws, session, reset);
      });
    } catch (e: unknown) {
      log.error("ws upgrade error", { error: errMsg(e) });
      if (!socket.destroyed) {
        try { socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n"); } catch { /* socket already unusable */ }
        socket.destroy();
      }
    } finally {
      if (reservedIp) releaseWsConnection(reservedIp);
    }
  });

  return { server, wss, pollRateLimiter, globalRateLimiter, wsUpgradeRateLimiter, wsConnectionsByIp, reserveWsConnection };
}

function onUnhandledRejection(reason: unknown): void {
  try {
    writeFatalError("server", "unhandled rejection", { error: errMsg(reason), stack: reason instanceof Error ? reason.stack : undefined });
  } finally {
    process.exit(1);
  }
}

function onUncaughtException(error: unknown): void {
  try {
    writeFatalError("server", "uncaught exception", { error: errMsg(error), stack: error instanceof Error ? error.stack : undefined });
  } finally {
    process.exit(1);
  }
}

export async function startServer(port = PORT, host = "127.0.0.1", overrides: ServerContextOptions & ServerInstanceOptions = {}): Promise<ReturnType<typeof createServerInstance>> {
  assertSupportedBunRuntime();
  // inherit user's full PATH from login shell — launchd PATH is minimal
  const loginShellPath = resolveLoginShellPath({ shell: SHELL, currentPath: process.env.PATH || "", home: process.env.HOME });
  if (loginShellPath.path) process.env.PATH = loginShellPath.path;
  if (loginShellPath.source === "fallback") {
    log.warn("login shell PATH unavailable; using fallback PATH", { shell: SHELL, reason: loginShellPath.reason });
  }

  // Bun already exits 1; add structured diagnostics without installing on import.
  // Stable listeners avoid duplicate registration if an embedder restarts the server.
  if (!process.listeners("unhandledRejection").includes(onUnhandledRejection)) {
    process.once("unhandledRejection", onUnhandledRejection);
  }
  if (!process.listeners("uncaughtException").includes(onUncaughtException)) {
    process.once("uncaughtException", onUncaughtException);
  }
  // Verify JWT auth configuration BEFORE any listeners are bound. We fail
  // hard on misconfiguration (secret set but rejected) so a typo can never
  // silently disable authentication. A missing secret is surfaced as a
  // warning (not an error: Tailscale is the default remote-access boundary, and
  // doctor treats logged errors as unhealthy).
  const authCfg = overrides.jwtAuthConfig ?? getCachedJwtAuthConfig();
  const authStatus = verifyJwtAuthAtStartup(authCfg);
  if (authStatus === "invalid") {
    log.error("refusing to start: WOLFPACK_JWT_SECRET is set but invalid", {
      reason: authCfg.invalidReason,
      hint: "unset WOLFPACK_JWT_SECRET to run without auth, or use a 32+ char value",
    });
    process.exit(1);
  }
  if (authStatus === "missing") {
    log.warn("WOLFPACK_JWT_SECRET is not set — ALL API ENDPOINTS ARE UNAUTHENTICATED", {
      hint: "set WOLFPACK_JWT_SECRET (32+ chars) to enable authentication",
    });
  }

  // Initialize session backend (broker is the only supported backend; the
  // WOLFPACK_BACKEND env var is accepted for back-compat but ignored).
  const ctx = createServerContext({ ...overrides, jwtAuthConfig: authCfg });
  setDefaultServerContext(ctx);
  const instance = createServerInstance(ctx, { ...overrides, port });
  const { server, wss } = instance;
  log.info("backend initialized", { type: "broker" });

  // Verify the broker handshake before listening so we surface a clear error
  // before any session-create requests land. The router has already done a
  // sync socket-file probe; this catches the case where the file exists but
  // the daemon is dead or unresponsive.
  const router = ctx.supervisor;
  if (router?.isBrokerAvailable()) {
    const ok = await router.verifyBrokerHandshake();
    if (!ok) {
      log.error("broker unreachable", { socketPath: router.getBrokerSocketPath() });
    } else {
      log.info("broker reachable", { socketPath: router.getBrokerSocketPath() });
    }
  }

  if (process.platform === "darwin" && process.env.WOLFPACK_SERVICE === "1") {
    const stopLogRotation = startLogRotationMonitor(
      [join(WOLFPACK_DIR, "wolfpack.log"), join(WOLFPACK_DIR, "broker.log")],
      { onError: (path, error) => log.warn("service log rotation failed", { path, error: errMsg(error) }) },
    );
    server.once("close", stopLogRotation);
  }

  await ctx.taskGateway.initialize();
  const taskRelay = ctx.taskRelayGateway;
  await taskRelay.initialize();
  void ctx.backend.cleanupOrphans();
  const stopChildEventDelivery = ctx.childEventDelivery.startChildEventDelivery({
    hostEnvelope: input => taskRelay.hostEnvelope(input),
    send: async (sessionId, sessionName, text, writeGuard) => {
      const streaming = ctx.supervisor ? ctx.supervisor.backend() : ctx.backend;
      if (!streaming) {
        return { delivery: SESSION_SEND_DELIVERY.NOT_DELIVERED, outcome: SESSION_SEND_OUTCOME.NOT_DELIVERED, observedMs: 0,
          reason: SESSION_SEND_FAILURE_REASON.BACKEND_UNAVAILABLE };
      }
      return streaming.sendAndObserveSubmission(sessionId, {
        text, noEnter: false, observeMs: SESSION_SEND_DEFAULT_OBSERVE_MS, ensureSubmitted: true, sessionName, writeGuard,
      });
    },
    typedNotesEnabled: childEventTypedNotesEnabled,
    lastViewerInputAt: ctx.viewerInput.lastViewerInputAt,
    now: Date.now,
  });
  ctx.sessionObservation.startSessionNotificationObserver();
  // Parent death kills cascade children. The first table after this start is a
  // baseline, so sessions that died while the server was down do not cascade.
  const stopChildCleanupCascade = ctx.sessionCascade.startChildCleanupCascade();
  server.once("close", () => {
    stopChildCleanupCascade();
    stopChildEventDelivery();
    void taskRelay.close();
    void ctx.sessionObservation.dispose();
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error("port already in use", { port, hint: "run 'wolfpack service stop' first" });
      process.exit(1);
    }
    log.error("server error", { error: err.message });
    process.exit(1);
  });

  installShutdownSignalHandlers(wss);

  server.listen(port, host, () => {
    log.info("server started", { url: `http://localhost:${port}/` });
    process.send?.({ type: SERVER_LISTENING, port });
  });
  return instance;
}
