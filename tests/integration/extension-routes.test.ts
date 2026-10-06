import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.WOLFPACK_TEST = "1";
process.env.WOLFPACK_JWT_SECRET = "extension-routes-test-secret-long-enough";
const { __resetJwtAuthConfig } = await import("../../src/test-hooks.ts"); __resetJwtAuthConfig();
const { ExtensionRuntime } = await import("../../src/extensions/runtime.ts");
const { ExtensionRouteService, __setExtensionRouteServiceForTests } = await import("../../src/server/extension-routes.ts");
const { createServerInstance } = await import("../../src/server/index.ts");
const scope = "b0a80123-1234-4234-9234-123456789abc";
const temp = mkdtempSync(join(tmpdir(), "wolfpack-extension-route-"));
const source = join(temp, "source"); mkdirSync(join(source, "dist"), { recursive: true }); mkdirSync(join(source, "schemas"), { recursive: true });
writeFileSync(join(source, "package.json"), JSON.stringify({ name: "route-fixture", version: "1.0.0", wolfpack: { manifestVersion: 1, apiVersion: 1, id: "route-fixture", ui: "dist/ui.js", skills: [], documents: [{ id: "context", schemaVersion: 1, schema: "schemas/context.json" }] } }));
writeFileSync(join(source, "dist", "ui.js"), "export default () => null;"); writeFileSync(join(source, "schemas", "context.json"), JSON.stringify({ type: "object", required: ["schemaVersion"], properties: { schemaVersion: { const: 1 } } }));
const runtime = new ExtensionRuntime({ root: join(temp, "runtime") }); await runtime.install({ source, trustBrowserCode: true });
const project = join(temp, "project"); mkdirSync(project);
expect(Bun.spawnSync(["git", "init", "--initial-branch=main", project], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
writeFileSync(join(project, "new <file>.ts"), "hello\n");
const backend = { async listSessionFacts() { return [{ name: "live", alive: true, identity: { wolfpackSessionId: scope, projectPath: project } }]; } } as any;
__setExtensionRouteServiceForTests(new ExtensionRouteService({ runtime, backend }));
const { server } = createServerInstance(); let base = "";
beforeAll(async () => { await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); })); });
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); __setExtensionRouteServiceForTests(undefined); __resetJwtAuthConfig(); rmSync(temp, { recursive: true, force: true }); delete process.env.WOLFPACK_JWT_SECRET; });
function token() { const crypto = require("node:crypto"); const now = Math.floor(Date.now() / 1000); const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"); const p = Buffer.from(JSON.stringify({ iat: now, exp: now + 60 })).toString("base64url"); return `${h}.${p}.${crypto.createHmac("sha256", process.env.WOLFPACK_JWT_SECRET).update(`${h}.${p}`).digest("base64url")}`; }
describe("extension HTTP routes", () => {
  test("Git status is authenticated, exact-session scoped and read-only with no client path", async () => {
    const route = `${base}/api/extensions/project/git-status/route-fixture`;
    expect((await fetch(`${route}?session=${scope}`)).status).toBe(401);
    const headers = { Authorization: `Bearer ${token()}` };
    const response = await fetch(`${route}?session=${scope}`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value = await response.json() as any;
    expect(value.scopeSessionId).toBe(scope); expect(value.extensionId).toBe("route-fixture");
    expect(value.status).toMatchObject({ state: "ready", branch: "main", staged: [], unstaged: [], untracked: [{ path: "new <file>.ts", status: "untracked" }], truncated: false });
    for (const query of ["session=live", `session=${scope}&path=/tmp`, `session=${scope}&session=${scope}`, `session=${scope}&command=log`]) {
      expect((await fetch(`${route}?${query}`, { headers })).status).toBe(400);
    }
    expect((await fetch(`${route}?session=11111111-1111-4111-8111-111111111111`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/api/extensions/project/git-status/not-installed?session=${scope}`, { headers })).status).toBe(404);
    expect((await fetch(`${route}?session=${scope}`, { method: "POST", headers })).status).toBe(404);
  });
  test("project status rejects disabled/safe-mode scopes and bounds concurrent work with a liveness recheck", async () => {
    const headers = { Authorization: `Bearer ${token()}` };
    const route = `${base}/api/extensions/project/git-status/route-fixture?session=${scope}`;
    let safeMode = false, alive = true, calls = 0;
    let release!: () => void, ready!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { ready = resolve; });
    const service = new ExtensionRouteService({ runtime, safeMode: () => safeMode,
      backend: { listSessionFacts: async () => [{ name: "reusable-name", alive, identity: { wolfpackSessionId: scope, projectPath: project } }] } as any,
      readGitStatus: async path => { expect(path).toBe(project); if (++calls === 2) ready(); await pending; return { state: "not-repository" }; },
    });
    __setExtensionRouteServiceForTests(service);
    try {
      runtime.setEnabled("route-fixture", false);
      expect((await fetch(route, { headers })).status).toBe(409); expect(calls).toBe(0);
      runtime.setEnabled("route-fixture", true); safeMode = true;
      expect((await fetch(route, { headers })).status).toBe(409); expect(calls).toBe(0);
      safeMode = false;
      const first = fetch(route, { headers }), second = fetch(route, { headers });
      await started;
      expect((await fetch(route, { headers })).status).toBe(503); expect(calls).toBe(2);
      alive = false; release();
      expect((await first).status).toBe(404); expect((await second).status).toBe(404);
      alive = true; expect((await fetch(route, { headers })).status).toBe(200); expect(calls).toBe(3);
    } finally {
      release(); runtime.setEnabled("route-fixture", true);
      __setExtensionRouteServiceForTests(new ExtensionRouteService({ runtime, backend }));
    }
  });
  test("requires normal API auth and only delivers installed allowlisted JS", async () => { expect((await fetch(`${base}/api/extensions`)).status).toBe(401); const headers = { Authorization: `Bearer ${token()}` }; const catalog = await fetch(`${base}/api/extensions`, { headers }); expect(catalog.status).toBe(200); const item = (await catalog.json() as any).installations[0]; const asset = await fetch(`${base}${item.ui.url}`, { headers }); expect(asset.status).toBe(200); expect(asset.headers.get("cache-control")).toBe("no-store"); expect(asset.headers.get("x-wolfpack-extension-digest")).toBe(item.ui.digest); const denied = await fetch(`${base}/api/extensions/assets/${item.extensionId}/${item.package.digest}/package.json`, { headers }); expect(denied.status).toBe(404); });
  test("rejects nonexact scopes before document publication", async () => { const headers = { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" }; const response = await fetch(`${base}/api/extensions/documents/route-fixture/context`, { method: "POST", headers, body: JSON.stringify({ sessionId: "not-a-uuid", document: { schemaVersion: 1 }, ifRevision: 0, requestId: "c0a80123-1234-4234-9234-123456789abc", schemaVersion: 1 }) }); expect(response.status).toBe(400); });
});
