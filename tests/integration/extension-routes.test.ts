import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { CONTROL_API_SCHEMA_ARTIFACT } from "../../src/control-api/schema.ts";
import { validateControlApiSchemaValue as validate, type JsonObject } from "../control-api-schema-validator.ts";
const artifact = JSON.parse(readFileSync(CONTROL_API_SCHEMA_ARTIFACT, "utf8")) as JsonObject;
function contract(operation: string, value: unknown) { expect(validate((artifact.http as Record<string, { response: unknown }>)[operation]!.response, value, artifact)).toEqual([]); }

process.env.WOLFPACK_TEST = "1";
process.env.WOLFPACK_JWT_SECRET = "extension-routes-test-secret-long-enough";
const { __resetJwtAuthConfig } = await import("../../src/test-hooks.ts"); __resetJwtAuthConfig();
const { ExtensionRuntime } = await import("../../src/extensions/runtime.ts");
const { ExtensionRouteService, __setExtensionRouteServiceForTests } = await import("../../src/server/extension-routes.ts");
const { createServerInstance } = await import("../../src/server/index.ts");
const scope = "b0a80123-1234-4234-9234-123456789abc";
const temp = mkdtempSync(join(tmpdir(), "wolfpack-extension-route-"));
const source = join(temp, "source"); mkdirSync(join(source, "dist"), { recursive: true }); mkdirSync(join(source, "schemas"), { recursive: true });
writeFileSync(join(source, "package.json"), JSON.stringify({ name: "route-fixture", version: "1.0.0", wolfpack: { manifestVersion: 1, apiVersion: 1, id: "route-fixture", blobs: { maxBlobBytes: 64 }, ui: "dist/ui.js", skills: [], documents: [{ id: "context", schemaVersion: 1, schema: "schemas/context.json" }] } }));
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
  test("blob routes authenticate, bound, verify and idempotently store/delete raw bytes", async () => {
    const bytes = Buffer.from([0, 255, 3]); const digest = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
    const path = `${base}/api/extensions/blobs/route-fixture/${digest}`;
    const headers = { Authorization: `Bearer ${token()}`, "Content-Type": "application/octet-stream" };
    expect((await fetch(path)).status).toBe(401);
    const put = () => fetch(`${path}?session=${scope}`, { method: "PUT", headers, body: bytes });
    const created = await put(); expect(created.status).toBe(201); contract("putExtensionBlob", await created.json());
    const duplicate = await (await put()).json(); expect(duplicate).toMatchObject({ digest, bytes: 3, created: false }); contract("putExtensionBlob", duplicate);
    const get = await fetch(path, { headers }); expect(get.status).toBe(200); expect(get.headers.get("x-wolfpack-blob-digest")).toBe(digest); expect(get.headers.get("cache-control")).toBe("no-store"); expect(Buffer.from(await get.arrayBuffer())).toEqual(bytes);
    expect((await fetch(`${path}?session=${scope}`, { method: "PUT", headers, body: Buffer.alloc(65) })).status).toBe(413);
    const chunked = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(32)); controller.enqueue(new Uint8Array(33)); controller.close(); } });
    expect((await fetch(`${path}?session=${scope}`, { method: "PUT", headers, body: chunked, duplex: "half" } as RequestInit)).status).toBe(413);
    expect((await fetch(`${path}?session=${scope}`, { method: "PUT", headers, body: "wrong" })).status).toBe(400);
    expect((await fetch(`${path}?session=live`, { method: "DELETE", headers })).status).toBe(400);
    expect((await fetch(`${path}?session=11111111-1111-4111-8111-111111111111`, { method: "DELETE", headers })).status).toBe(409);
    runtime.setEnabled("route-fixture", false); expect((await put()).status).toBe(409); runtime.setEnabled("route-fixture", true);
    __setExtensionRouteServiceForTests(new ExtensionRouteService({ runtime, backend, safeMode: () => true })); expect((await put()).status).toBe(409); __setExtensionRouteServiceForTests(new ExtensionRouteService({ runtime, backend }));
    const noBlob = join(temp, "no-blob"); mkdirSync(noBlob); writeFileSync(join(noBlob, "package.json"), JSON.stringify({ name: "no-blob", version: "1.0.0", wolfpack: { manifestVersion: 1, apiVersion: 1, id: "no-blob", skills: [], documents: [] } })); await runtime.install({ source: noBlob, trustBrowserCode: true });
    expect((await fetch(`${base}/api/extensions/blobs/no-blob/${digest}?session=${scope}`, { method: "PUT", headers, body: bytes })).status).toBe(400);
    const catalog = await (await fetch(`${base}/api/extensions`, { headers })).json(); contract("listInstalledExtensions", catalog);
    expect(catalog.installations.find((item: any) => item.extensionId === "no-blob").blobs).toBeNull();
    expect(catalog.installations.find((item: any) => item.extensionId === "route-fixture").blobs).toEqual({ maxBlobBytes: 64 });
    for (const deleted of [true, false]) { const result = await (await fetch(`${path}?session=${scope}`, { method: "DELETE", headers })).json(); expect(result).toEqual({ digest, deleted }); contract("deleteExtensionBlob", result); }
    expect((await fetch(path, { headers })).status).toBe(404);
  });
  test("GET refuses disabled and removed installations while retained blobs survive reinstall", async () => {
    const bytes = Buffer.from([41]), digest = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
    const path = `${base}/api/extensions/blobs/route-fixture/${digest}`, headers = { Authorization: `Bearer ${token()}`, "Content-Type": "application/octet-stream" };
    expect((await fetch(`${path}?session=${scope}`, { method: "PUT", headers, body: bytes })).status).toBe(201);
    try {
      runtime.setEnabled("route-fixture", false); expect((await fetch(path, { headers })).status).toBe(409);
      runtime.setEnabled("route-fixture", true); runtime.remove("route-fixture"); expect((await fetch(path, { headers })).status).toBe(404);
      await runtime.install({ source, trustBrowserCode: true }); runtime.setEnabled("route-fixture", true);
      const retained = await fetch(path, { headers }); expect(retained.status).toBe(200); expect(Buffer.from(await retained.arrayBuffer())).toEqual(bytes);
    } finally { await runtime.install({ source, trustBrowserCode: true }); runtime.setEnabled("route-fixture", true); }
  });
  test.each(["dead-session", "disabled", "safe-mode", "removed", "updated"] as const)("PUT rechecks authority after partial upload: %s", async transition => {
    const bytes = Buffer.from([42, 43]), digest = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
    let alive = true, safeMode = false, checks = 0, began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    __setExtensionRouteServiceForTests(new ExtensionRouteService({ runtime, safeMode: () => safeMode, backend: { listSessionFacts: async () => { const facts = [{ name: "reused", alive, identity: { wolfpackSessionId: scope } }]; if (++checks === 1) began(); return facts; } } as any }));
    const upload = request(`${base}/api/extensions/blobs/route-fixture/${digest}?session=${scope}`, { method: "PUT", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/octet-stream" } });
    const result = new Promise<number>( (resolve, reject) => { upload.on("response", response => { response.resume(); response.on("end", () => resolve(response.statusCode!)); }); upload.on("error", reject); });
    try {
      upload.write(bytes.subarray(0, 1)); await started;
      if (transition === "dead-session") alive = false;
      else if (transition === "disabled") runtime.setEnabled("route-fixture", false);
      else if (transition === "safe-mode") safeMode = true;
      else if (transition === "removed") runtime.remove("route-fixture");
      else { const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8")); manifest.version = "1.0.1"; writeFileSync(join(source, "package.json"), JSON.stringify(manifest)); await runtime.install({ source, trustBrowserCode: true }); }
      upload.end(bytes.subarray(1)); expect(await result).toBe(transition === "removed" ? 404 : 409); if (transition === "dead-session") expect(checks).toBe(2);
      const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts"); expect(new ExtensionBlobStore({ root: runtime.root }).read({ installationId: runtime.installationId, extensionId: "route-fixture" }, digest)).toBeNull();
    } finally {
      upload.destroy(); const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8")); manifest.version = "1.0.0"; writeFileSync(join(source, "package.json"), JSON.stringify(manifest)); await runtime.install({ source, trustBrowserCode: true }); runtime.setEnabled("route-fixture", true);
      __setExtensionRouteServiceForTests(new ExtensionRouteService({ runtime, backend }));
    }
  });
  test("concurrent PUTs at the installation count quota admit exactly one", async () => {
    const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
    const quotaSource = join(temp, "quota-source"); mkdirSync(quotaSource);
    writeFileSync(join(quotaSource, "package.json"), JSON.stringify({ name: "quota", version: "1.0.0", wolfpack: { manifestVersion: 1, apiVersion: 1, id: "quota", skills: [], documents: [], blobs: { maxBlobBytes: 64 } } }));
    await runtime.install({ source: quotaSource, trustBrowserCode: true });
    const store = new ExtensionBlobStore({ root: runtime.root }), key = { installationId: runtime.installationId, extensionId: "quota" }, hash = (bytes: Buffer) => require("node:crypto").createHash("sha256").update(bytes).digest("hex");
    for (let n = 0; n < 63; n++) { const bytes = Buffer.from([n]); store.put(key, hash(bytes), bytes, 64); }
    const candidates = [Buffer.from([63]), Buffer.from([64])];
    try {
      const responses = await Promise.all(candidates.map(body => fetch(`${base}/api/extensions/blobs/quota/${hash(body)}?session=${scope}`, { method: "PUT", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/octet-stream" }, body })));
      expect(responses.map(response => response.status).sort()).toEqual([201, 413]);
      expect(candidates.filter(bytes => store.read(key, hash(bytes)) !== null)).toHaveLength(1);
      expect(store.read(key, hash(Buffer.from([0])))).toEqual(Buffer.from([0]));
    } finally { runtime.purge("quota"); }
  });
  test("overflow stops an unfinished chunked upload but still delivers HTTP 413", async () => {
    const upload = request(`${base}/api/extensions/blobs/route-fixture/${"a".repeat(64)}?session=${scope}`, { method: "PUT", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/octet-stream" } });
    const closed = new Promise<void>(resolve => upload.on("socket", socket => socket.once("close", () => resolve())));
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => { upload.on("response", message => { const chunks: Buffer[] = []; message.on("data", chunk => chunks.push(chunk)); message.on("end", () => resolve({ status: message.statusCode!, body: Buffer.concat(chunks).toString("utf8") })); message.on("error", reject); }); upload.on("error", reject); });
    try { upload.write(Buffer.alloc(65)); const result = await response; expect(result.status).toBe(413); expect(JSON.parse(result.body)).toMatchObject({ error: { code: "QUOTA_EXCEEDED" } }); await closed; }
    finally { upload.destroy(); }
  });
  test("oversized upload returns 413 and closes the connection", async () => {
    const digest = "a".repeat(64), headers = { Authorization: `Bearer ${token()}`, "Content-Type": "application/octet-stream" };
    for (const body of [Buffer.alloc(65), new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65)); controller.close(); } })]) {
      const response = await fetch(`${base}/api/extensions/blobs/route-fixture/${digest}?session=${scope}`, { method: "PUT", headers, body, duplex: "half" } as RequestInit);
      expect(response.status).toBe(413); expect(response.headers.get("connection")).toBe("close"); expect(await response.json()).toMatchObject({ error: { code: "QUOTA_EXCEEDED" } });
    }
  });
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
  test("Git diff is authenticated, exact-session scoped, read-only and diffs no untracked files", async () => {
    const route = `${base}/api/extensions/project/git-diff/route-fixture`;
    expect((await fetch(`${route}?session=${scope}`)).status).toBe(401);
    const headers = { Authorization: `Bearer ${token()}` };
    const response = await fetch(`${route}?session=${scope}`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value = await response.json() as any;
    contract("readExtensionProjectGitDiff", value);
    expect(value).toEqual({ installationId: runtime.get("route-fixture").installationId, scopeSessionId: scope, extensionId: "route-fixture", diff: { state: "ready", staged: "", unstaged: "", truncated: false } });
    for (const query of ["session=live", `session=${scope}&path=/tmp`, `session=${scope}&session=${scope}`, `session=${scope}&args=--output=/tmp/x`]) {
      expect((await fetch(`${route}?${query}`, { headers })).status).toBe(400);
    }
    expect((await fetch(`${route}?session=11111111-1111-4111-8111-111111111111`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/api/extensions/project/git-diff/not-installed?session=${scope}`, { headers })).status).toBe(404);
    expect((await fetch(`${route}?session=${scope}`, { method: "POST", headers })).status).toBe(404);
  });
  test("Git diff shares the project work bound with status and maps reader failures to PROJECT_UNAVAILABLE", async () => {
    const headers = { Authorization: `Bearer ${token()}` };
    const status = `${base}/api/extensions/project/git-status/route-fixture?session=${scope}`, diff = `${base}/api/extensions/project/git-diff/route-fixture?session=${scope}`;
    let statusCalls = 0, diffCalls = 0, fail = false, safeMode = false;
    let release!: () => void, ready!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { ready = resolve; });
    const check = () => { if (statusCalls + diffCalls === 2) ready(); };
    const service = new ExtensionRouteService({ runtime, backend, safeMode: () => safeMode,
      readGitStatus: async () => { statusCalls++; check(); await pending; return { state: "not-repository" }; },
      readGitDiff: async path => { expect(path).toBe(project); diffCalls++; check(); await pending; if (fail) throw new Error("Git diff unavailable"); return { state: "ready", staged: "diff --git a/x b/x\n", unstaged: "", truncated: true }; },
    });
    __setExtensionRouteServiceForTests(service);
    try {
      runtime.setEnabled("route-fixture", false);
      expect((await fetch(diff, { headers })).status).toBe(409); expect(diffCalls).toBe(0);
      runtime.setEnabled("route-fixture", true); safeMode = true;
      expect((await fetch(diff, { headers })).status).toBe(409); expect(diffCalls).toBe(0);
      safeMode = false;
      const first = fetch(status, { headers }), second = fetch(diff, { headers });
      await started;
      const busy = await fetch(diff, { headers });
      expect(busy.status).toBe(503); expect(await busy.json()).toMatchObject({ error: { code: "PROJECT_UNAVAILABLE" } });
      expect([statusCalls, diffCalls]).toEqual([1, 1]);
      release();
      expect((await first).status).toBe(200);
      const value = await (await second).json() as any;
      contract("readExtensionProjectGitDiff", value);
      expect(value.diff).toEqual({ state: "ready", staged: "diff --git a/x b/x\n", unstaged: "", truncated: true }); expect(value.status).toBeUndefined();
      fail = true;
      const failed = await fetch(diff, { headers });
      expect(failed.status).toBe(503); expect(await failed.json()).toMatchObject({ error: { code: "PROJECT_UNAVAILABLE", message: "Git diff unavailable for this project" } });
    } finally {
      release(); runtime.setEnabled("route-fixture", true);
      __setExtensionRouteServiceForTests(new ExtensionRouteService({ runtime, backend }));
    }
  });
  test("requires normal API auth and only delivers installed allowlisted JS", async () => { expect((await fetch(`${base}/api/extensions`)).status).toBe(401); const headers = { Authorization: `Bearer ${token()}` }; const catalog = await fetch(`${base}/api/extensions`, { headers }); expect(catalog.status).toBe(200); const item = (await catalog.json() as any).installations.find((item: any) => item.extensionId === "route-fixture"); const asset = await fetch(`${base}${item.ui.url}`, { headers }); expect(asset.status).toBe(200); expect(asset.headers.get("cache-control")).toBe("no-store"); expect(asset.headers.get("x-wolfpack-extension-digest")).toBe(item.ui.digest); const denied = await fetch(`${base}/api/extensions/assets/${item.extensionId}/${item.package.digest}/package.json`, { headers }); expect(denied.status).toBe(404); });
  test("rejects nonexact scopes before document publication", async () => { const headers = { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" }; const response = await fetch(`${base}/api/extensions/documents/route-fixture/context`, { method: "POST", headers, body: JSON.stringify({ sessionId: "not-a-uuid", document: { schemaVersion: 1 }, ifRevision: 0, requestId: "c0a80123-1234-4234-9234-123456789abc", schemaVersion: 1 }) }); expect(response.status).toBe(400); });
});
