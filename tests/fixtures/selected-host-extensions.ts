import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { validateJwtHs256, extractBearerToken } from "../../src/auth.ts";
import { buildMachineHandshake } from "../../src/tailnet-machine-contract.ts";
import { ExtensionRuntime } from "../../src/extensions/runtime.ts";
import { ExtensionRouteService, __setExtensionRouteServiceForTests } from "../../src/server/extension-routes.ts";
import type { ExtensionPeerFetch } from "../../src/server/extension-peer-proxy.ts";
import type { SessionBackend } from "../../src/server/backend-contract.ts";

export const SELECTED_HOST_SESSION = "22222222-2222-4222-8222-222222222222";
const IDS = { local: "44444444-4444-4444-8444-444444444444", a: "11111111-1111-4111-8111-111111111111", b: "33333333-3333-4333-8333-333333333333" };
export function fixtureToken(secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 300 })).toString("base64url");
  return `${header}.${payload}.${createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url")}`;
}
export type PeerMode = "normal" | "wrong-identity" | "redirect" | "oversized" | "stalled" | "error-secret";
interface Trace { readonly path: string; readonly authorization: string | undefined; readonly cookie: string | undefined; readonly peerHeader: string | string[] | undefined; }
export interface InstalledPeer {
  readonly key: "a" | "b";
  readonly identity: string;
  readonly origin: string;
  readonly runtime: ExtensionRuntime;
  readonly token: string;
  readonly trace: Trace[];
  readonly stalled: ServerResponse[];
  readonly base: string;
  readonly server: Server;
  safeMode: boolean;
  online: boolean;
  mode: PeerMode;
  afterCatalog?: () => void;
  handleRequest?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

/** Actual installed runtimes/routes/git with controlled exact session facts and isolated Tailnet DNS/TLS. */
export async function createSelectedHostFixture(options: { readonly timeoutMs?: number; readonly maxActive?: number; readonly handleLocalRequest?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean> } = {}) {
  process.env.WOLFPACK_TEST = "1";
  const root = mkdtempSync(join(tmpdir(), "wolfpack-selected-hosts-"));
  const previousSecret = process.env.WOLFPACK_JWT_SECRET, previousStatus = process.env.WOLFPACK_TAILSCALE_STATUS_JSON;
  const localSecret = "selected-host-local-test-secret-123";
  process.env.WOLFPACK_JWT_SECRET = localSecret;
  const { __resetJwtAuthConfig } = await import("../../src/test-hooks.ts"); __resetJwtAuthConfig();
  const peers: InstalledPeer[] = [];
  const redirectTrace: string[] = [];
  const redirectServer = createServer((req, res) => {
    redirectTrace.push(req.url ?? "/");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ safeMode: false, installations: [] }));
  });
  const redirectBase = await listen(redirectServer);
  for (const key of ["a", "b"] as const) {
    const source = join(root, key, "source"), project = join(root, key, "project");
    mkdirSync(join(source, "dist"), { recursive: true }); mkdirSync(join(source, "schemas")); mkdirSync(project);
    const init = Bun.spawnSync(["git", "init", `--initial-branch=branch-${key}`, project], { stdout: "pipe", stderr: "pipe" });
    if (init.exitCode !== 0) throw new Error("owned git fixture initialization failed");
    writeFileSync(join(project, `only-${key}.txt`), key);
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: `remote-only-notes-${key}`, version: "1.0.0", wolfpack: { manifestVersion: 1, apiVersion: 1, id: "notes", ui: "dist/ui.js", skills: [], documents: [{ id: "context", schemaVersion: 1, schema: "schemas/context.json" }] } }));
    writeFileSync(join(source, "schemas/context.json"), JSON.stringify({ type: "string" }));
    writeFileSync(join(source, "dist/ui.js"), `globalThis.remoteBundleEvaluations=(globalThis.remoteBundleEvaluations||0)+1; export default host=>host.registerContextView({id:'scope',title:'Selected notes',mount(root,context){const code=document.createElement('p'),doc=document.createElement('p'),git=document.createElement('p'),draft=document.createElement('textarea');code.textContent='code ${key}';code.dataset.peerCode='${key}';doc.dataset.peerDocument='${key}';git.dataset.peerGit='${key}';draft.setAttribute('aria-label','Selected widget draft');draft.value=context.storage.get('draft')||'';draft.oninput=()=>context.storage.set('draft',draft.value);root.append(code,doc,git,draft);context.documents.subscribe('context',value=>doc.textContent=value||'empty');context.project.gitStatus().then(value=>git.textContent=value.state==='ready'?value.branch+':'+value.untracked.map(file=>file.path).join(','):value.state);return{dispose(){globalThis.remoteViewDisposals=(globalThis.remoteViewDisposals||0)+1}}}});`);
    const runtime = new ExtensionRuntime({ root: join(root, key, "runtime"), installationId: IDS[key] });
    await runtime.install({ source, trustBrowserCode: true });
    // Routes require only facts; unused broker operations are deliberately not simulated.
    const now = new Date().toISOString();
    const backend: Pick<SessionBackend, "listSessionFacts"> = { listSessionFacts: async () => [{ name: `session-${key}`, alive: true, identity: { wolfpackSessionId: SELECTED_HOST_SESSION, wolfpackSessionName: `session-${key}`, projectPath: project, agentKind: "shell", createdAt: now, updatedAt: now } }] };
    const secret = `selected-host-peer-${key}-secret-123`;
    let peer!: InstalledPeer;
    const service = new ExtensionRouteService({ runtime, backend, safeMode: () => peer.safeMode });
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      peer.trace.push({ path: req.url ?? "/", authorization: req.headers.authorization, cookie: req.headers.cookie, peerHeader: req.headers["x-wolfpack-extension-peer-authorization"] });
      res.setHeader("Cache-Control", "no-store");
      if (peer.handleRequest?.(req, res, url)) return;
      if (url.pathname === "/api/machine") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(buildMachineHandshake({ tailscaleHostname: `${key}.fixture.ts.net`, tailscaleNodeId: `node-${key}`, installationId: peer.mode === "wrong-identity" ? IDS.local : IDS[key], displayName: `Peer ${key}`, version: "1.6.25" }))); return;
      }
      const token = extractBearerToken(req.headers.authorization);
      if (!token || !validateJwtHs256(token, secret).ok) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "authentication required" })); return; }
      if (url.pathname === "/api/extensions" && peer.mode !== "normal" && peer.mode !== "wrong-identity") {
        if (peer.mode === "redirect") { res.writeHead(302, { Location: `${redirectBase}/unexpected-redirect` }); res.end(); return; }
        if (peer.mode === "error-secret") { res.writeHead(403, { "Content-Type": "application/json", "Set-Cookie": "upstream-secret=value", "X-Private": "secret" }); res.end(JSON.stringify({ error: "SECRET upstream private detail" })); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        if (peer.mode === "oversized") { res.end(" ".repeat(256 * 1024 + 1)); return; }
        res.write('{"safeMode":false,'); peer.stalled.push(res); return;
      }
      if (!await service.handle(req, res, url)) { res.writeHead(404); res.end(); }
      if (url.pathname === "/api/extensions") peer.afterCatalog?.();
    });
    peer = { key, identity: `node-${key}:${IDS[key]}`, origin: `https://${key}.fixture.ts.net`, runtime, token: fixtureToken(secret), trace: [], stalled: [], server, base: await listen(server), safeMode: false, online: true, mode: "normal" };
    peers.push(peer);
    const published = await fetch(`${peer.base}/api/extensions/documents/notes/context`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: SELECTED_HOST_SESSION, document: `document ${key}`, ifRevision: 0, requestId: key === "a" ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", schemaVersion: 1 }) });
    if (published.status !== 200) throw new Error(`owned document fixture publication failed: ${published.status}`);
    peer.trace.length = 0;
  }
  function updateTopology(): void {
    process.env.WOLFPACK_TAILSCALE_STATUS_JSON = JSON.stringify({ Self: { ID: "node-local", DNSName: "local.fixture.ts.net", HostName: "local" }, Peer: Object.fromEntries(peers.map(peer => [peer.key, { ID: `node-${peer.key}`, DNSName: `${peer.key}.fixture.ts.net`, Online: peer.online }])) });
  }
  updateTopology();
  const localRuntime = new ExtensionRuntime({ root: join(root, "local-runtime"), installationId: IDS.local });
  const fetchTrace: string[] = [];
  const fetchImpl: ExtensionPeerFetch = async (input, init) => {
    const url = new URL(String(input)); fetchTrace.push(url.href);
    const peer = peers.find(value => value.origin === url.origin);
    if (!peer) throw new Error("fixture rejected unauthorized external target");
    // Project canonical HTTPS onto actual isolated HTTP hosts; production retains native fetch/TLS.
    return fetch(`${peer.base}${url.pathname}${url.search}`, init);
  };
  const serviceOptions = { runtime: localRuntime, backend: { listSessionFacts: async () => [] },
    peerProxy: { fetchImpl, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.maxActive === undefined ? {} : { maxActive: options.maxActive }) } };
  class FixtureLocalRoutes extends ExtensionRouteService {
    override async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      if (await options.handleLocalRequest?.(req, res, url)) return true;
      return super.handle(req, res, url);
    }
  }
  __setExtensionRouteServiceForTests(new FixtureLocalRoutes(serviceOptions));
  const { createServerInstance } = await import("../../src/server/index.ts");
  const { server } = createServerInstance(); const base = await listen(server);
  return {
    root, peers, localRuntime, base, localToken: fixtureToken(localSecret), fetchTrace, updateTopology, redirectBase, redirectTrace,
    async close() {
      await close(server); for (const peer of peers) await close(peer.server); await close(redirectServer);
      __setExtensionRouteServiceForTests(undefined); __resetJwtAuthConfig();
      if (previousSecret === undefined) delete process.env.WOLFPACK_JWT_SECRET; else process.env.WOLFPACK_JWT_SECRET = previousSecret;
      if (previousStatus === undefined) delete process.env.WOLFPACK_TAILSCALE_STATUS_JSON; else process.env.WOLFPACK_TAILSCALE_STATUS_JSON = previousStatus;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
