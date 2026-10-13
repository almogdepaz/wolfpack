#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { writeSelectedHostPackage } from "../fixtures/selected-host-package.ts";

process.env.WOLFPACK_TEST = "1";
const socketPath = process.env.WOLFPACK_BROKER_SOCKET, home = process.env.HOME;
const kind = process.env.WOLFPACK_SELECTED_HOST_FIXTURE;
if (!socketPath || !home || (kind !== "local" && kind !== "a" && kind !== "b")) throw new Error("owned selected-host fixture configuration unavailable");
const fixtureHome = home;
const fixtureKind = kind;
const { BrokerClient } = await import("../../src/broker/client.ts");
const { BrokerBackend } = await import("../../src/server/broker-backend.ts");
const { __setTestBackend } = await import("../../src/server/backend.ts");
let backend: InstanceType<typeof BrokerBackend>;
let connected!: () => void;
const connection = new Promise<void>(resolve => { connected = resolve; });
const client = new BrokerClient({ socketPath, requestTimeoutMs: 5000, onConnect: connected, onEvent: event => backend.ingestEvent(event) });
backend = new BrokerBackend(client); __setTestBackend(backend); client.start();
let connectionTimer: ReturnType<typeof setTimeout> | undefined;
try { await Promise.race([connection, new Promise<never>((_resolve, reject) => { connectionTimer = setTimeout(() => reject(new Error("owned broker connection timed out")), 5000); })]); }
finally { clearTimeout(connectionTimer); }
const ping = await client.request("list_sessions", {}); if (ping.status !== "ok") throw new Error("owned broker readiness failed");
const { assets, ASSET_VERSION } = await import("../../src/public-assets.ts");
if (process.env.WOLFPACK_TEST_APP_BUNDLE) {
  assets.set("app.bundle.js", { content: readFileSync(process.env.WOLFPACK_TEST_APP_BUNDLE), mime: "text/javascript" });
  assets.set("index.html", { content: readFileSync(join(import.meta.dirname, '../../public/index.html'), 'utf8').replaceAll('__WOLFPACK_ASSET_VERSION__', ASSET_VERSION), mime: "text/html; charset=utf-8" });
  assets.set("styles.css", { content: readFileSync(join(import.meta.dirname, '../../public/styles.css')), mime: "text/css" });
}
const { ExtensionRuntime } = await import("../../src/extensions/runtime.ts");
const { ExtensionRouteService, __setExtensionRouteServiceForTests } = await import("../../src/server/extension-routes.ts");
const { getInstallationId } = await import("../../src/tailnet-machine-installation.ts");
const { json, parseObjectBody } = await import("../../src/server/http.ts");
const runtime = new ExtensionRuntime({ root: join(home, "extensions"), installationId: getInstallationId() });
if (kind !== "local") await runtime.install({ source: writeSelectedHostPackage(home, kind), trustBrowserCode: true });
const peerBases: unknown = JSON.parse(process.env.WOLFPACK_TEST_PEER_BASES ?? "{}");
if (!peerBases || typeof peerBases !== "object" || Array.isArray(peerBases)) throw new Error("invalid fixture peer table");
const peers = new Map<string, string>();
for (const [origin, base] of Object.entries(peerBases)) {
  if (!/^https:\/\/[ab]\.fixture\.ts\.net$/.test(origin) || typeof base !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error("fixture rejected external routing alias");
  peers.set(origin, base);
}
let safeMode = false, paused: Promise<void> | undefined, release: (() => void) | undefined;
class FixtureRoutes extends ExtensionRouteService {
  override async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (req.method === "POST" && url.pathname === "/api/fixture/extensions") {
      const body = await parseObjectBody(req, res, { maxBytes: 4096 }); if (!body) return true;
      if (body.action === "safe") safeMode = body.value === true;
      else if (body.action === "enable") runtime.setEnabled("notes", body.value === true);
      else if (body.action === "remove") runtime.remove("notes");
      else if (body.action === "update" && fixtureKind !== "local") await runtime.install({ source: writeSelectedHostPackage(fixtureHome, fixtureKind, "1.1.0"), trustBrowserCode: true });
      else if (body.action === "pause-assets") {
        if (body.value === true && !paused) paused = new Promise<void>(resolve => { release = resolve; });
        else if (body.value === false) { release?.(); paused = undefined; release = undefined; }
      } else { json(res, { error: "invalid owned fixture command" }, 400); return true; }
      json(res, { ok: true }); return true;
    }
    if (url.pathname.startsWith("/api/extensions/assets/") && paused) {
      await paused;
      if (req.aborted || res.destroyed) return true;
    }
    return super.handle(req, res, url);
  }
}
__setExtensionRouteServiceForTests(new FixtureRoutes({ runtime, backend, safeMode: () => safeMode, peerProxy: {
  fetchImpl: async (input, init) => {
    const url = new URL(String(input)), base = peers.get(url.origin);
    if (!base) throw new Error("fixture rejected unowned Tailnet target");
    // Only the external DNS/TLS boundary is projected; middleware/routes/runtime remain real.
    return fetch(`${base}${url.pathname}${url.search}`, init);
  },
} }));
const { server } = await import("../../src/server/index.ts");
server.listen(0, "127.0.0.1", () => console.log(`READY:${(server.address() as AddressInfo).port}`));
function stop(): void { release?.(); client.close(); server.closeAllConnections(); process.exit(0); }
process.stdin.resume(); process.stdin.on("end", stop); process.on("SIGTERM", stop);
