import { afterEach, describe, expect, spyOn, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ExtensionRuntime } from "../../src/extensions/runtime.ts";
import { ExtensionDocumentStore, compileStaticDocumentSchema } from "../../src/extensions/document-contract.ts";
import { ExtensionRouteService } from "../../src/server/extension-routes.ts";
import type { SessionBackend } from "../../src/server/backend-contract.ts";

const sessionId = "b0a80123-1234-4234-9234-123456789abc";
const roots: string[] = [];
function root() { const value = mkdtempSync(join(tmpdir(), "wolfpack-extension-runtime-")); roots.push(value); return value; }
function fixture(parent: string, version = "1.0.0", goal = "first") { const source = join(parent, `source-${version}`); mkdirSync(join(source, "dist"), { recursive: true }); mkdirSync(join(source, "schemas"), { recursive: true }); writeFileSync(join(source, "package.json"), JSON.stringify({ name: "fixture-extension", version, wolfpack: { manifestVersion: 1, apiVersion: 1, id: "fixture", ui: "dist/ui.js", skills: [], documents: [{ id: "context", schemaVersion: 1, schema: "schemas/context.json" }] } })); writeFileSync(join(source, "dist", "ui.js"), `export default function(){ return ${JSON.stringify(goal)}; }`); writeFileSync(join(source, "schemas", "context.json"), JSON.stringify({ type: "object", additionalProperties: false, required: ["schemaVersion", "goal"], properties: { schemaVersion: { const: 1 }, goal: { type: "string" } } })); return source; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const backend = { async listSessionFacts() { return [{ name: "live", alive: true, identity: { wolfpackSessionId: sessionId } }]; } } as unknown as SessionBackend;

describe("extension runtime integration", () => {
  test("validates one registry snapshot per synchronous mutation and reads each declaration once", async () => {
    const base = root(), runtime = new ExtensionRuntime({ root: join(base, "runtime") });
    await runtime.install({ source: fixture(base), trustBrowserCode: true });
    const { installation } = await runtime.install({ source: fixture(base, "1.1.0"), trustBrowserCode: true });
    const registry = spyOn(runtime as any, "registry");
    try {
      for (const operation of [() => runtime.setEnabled("fixture", false), () => runtime.rollback("fixture"), () => runtime.remove("fixture")]) {
        registry.mockClear(); operation(); expect(registry).toHaveBeenCalledTimes(1);
      }
    } finally { registry.mockRestore(); }
    const open = spyOn(fs, "openSync");
    try {
      (runtime as any).declarations(installation.snapshot);
      expect(open.mock.calls.filter(([path]) => path === join(installation.snapshot, "schemas/context.json"))).toHaveLength(1);
    } finally { open.mockRestore(); }
  });

  test("document publication verifies once before preparation and again after writable authority", async () => {
    const base = root(), runtime = new ExtensionRuntime({ root: join(base, "runtime") });
    await runtime.install({ source: fixture(base), trustBrowserCode: true });
    const service = new ExtensionRouteService({ runtime, backend });
    const registry = spyOn(runtime as any, "registry");
    try {
      const body = { sessionId, document: { schemaVersion: 1, goal: "saved" }, ifRevision: 0, requestId: "c0a80123-1234-4234-9234-123456789abc", schemaVersion: 1 };
      const first = await fetchThrough(service, "POST", "/api/extensions/documents/fixture/context", body);
      expect(first.status).toBe(200);
      expect(registry).toHaveBeenCalledTimes(2);
      registry.mockClear();
      const duplicate = await fetchThrough(service, "POST", "/api/extensions/documents/fixture/context", body);
      expect(duplicate.body).toEqual(first.body);
      expect(registry).toHaveBeenCalledTimes(1);
      registry.mockClear();
      expect((await fetchThrough(service, "GET", `/api/extensions/documents/fixture/context?session=${sessionId}`)).status).toBe(200);
      expect(registry).toHaveBeenCalledTimes(1);
    } finally { registry.mockRestore(); }
  });

  test.each(["GET", "DELETE"] as const)("blob %s reuses only the same-stack declaration verification", async method => {
    const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
    const base = root(), source = fixture(base);
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    manifest.wolfpack.blobs = { maxBlobBytes: 64 };
    writeFileSync(join(source, "package.json"), JSON.stringify(manifest));
    const runtime = new ExtensionRuntime({ root: join(base, "runtime") });
    await runtime.install({ source, trustBrowserCode: true });
    const bytes = Buffer.from("null"), digest = createHash("sha256").update(bytes).digest("hex");
    new ExtensionBlobStore({ root: runtime.root }).put({ installationId: runtime.installationId, extensionId: "fixture" }, digest, bytes, 64);
    const registry = spyOn(runtime as any, "registry");
    try {
      const response = await fetchThrough(new ExtensionRouteService({ runtime, backend }), method,
        `/api/extensions/blobs/fixture/${digest}${method === "DELETE" ? `?session=${sessionId}` : ""}`);
      expect(response.status).toBe(200);
      expect(registry).toHaveBeenCalledTimes(method === "GET" ? 1 : 2);
    } finally { registry.mockRestore(); }
  });

  test("publication still detects a tampered previous snapshot after the writable-scope await", async () => {
    const base = root(), runtime = new ExtensionRuntime({ root: join(base, "runtime") });
    const first = await runtime.install({ source: fixture(base), trustBrowserCode: true });
    await runtime.install({ source: fixture(base, "1.1.0"), trustBrowserCode: true });
    const service = new ExtensionRouteService({ runtime, backend: { async listSessionFacts() {
      writeFileSync(join(first.installation.snapshot, "dist/ui.js"), "tampered during authority await");
      return backend.listSessionFacts();
    } } });
    const result = await fetchThrough(service, "POST", "/api/extensions/documents/fixture/context", {
      sessionId, document: { schemaVersion: 1, goal: "not committed" }, ifRevision: 0, requestId: "c0a80123-1234-4234-9234-123456789abc", schemaVersion: 1,
    });
    expect(result.status).not.toBe(200);
    expect(fs.existsSync(join(runtime.root, "documents"))).toBe(false);
  });

  test("publication keeps invalid schema-version precedence when an extension is disabled", async () => {
    const base = root(), runtime = new ExtensionRuntime({ root: join(base, "runtime") });
    await runtime.install({ source: fixture(base), trustBrowserCode: true });
    runtime.setEnabled("fixture", false);
    const service = new ExtensionRouteService({ runtime, backend });
    const body = { sessionId, document: { schemaVersion: 1, goal: "blocked" }, ifRevision: 0, requestId: "c0a80123-1234-4234-9234-123456789abc", schemaVersion: 2 };
    expect((await fetchThrough(service, "POST", "/api/extensions/documents/fixture/context", body)).status).toBe(400);
    expect((await fetchThrough(service, "POST", "/api/extensions/documents/fixture/context", { ...body, schemaVersion: 1 })).status).toBe(409);
  });

  test("catalog/assets never compile, validators reuse verified bytes with bounded retention and tampering still fails", async () => {
    const base = root(), options = { root: join(base, "runtime") };
    const { installation } = await new ExtensionRuntime(options).install({ source: fixture(base), trustBrowserCode: true });
    const runtime = new ExtensionRuntime(options);
    const compile = spyOn(Ajv2020.prototype, "compile");
    const key = { installationId: runtime.installationId, scopeSessionId: sessionId, extensionId: "fixture", documentId: "context" };
    try {
      runtime.catalog(); runtime.asset("fixture", installation.package.digest, "dist/ui.js");
      expect(compile).toHaveBeenCalledTimes(0);
      const first = runtime.schema(key); expect(runtime.schema(key)).toBe(first);
      expect(compile).toHaveBeenCalledTimes(1);
      // Cache pressure must not become unbounded retention of admitted schemas.
      for (let index = 0; index < 33; index++) (runtime as any).validator(Buffer.from(JSON.stringify({ const: index })));
      expect((runtime as any).validatorCache.size).toBe(32);
      const evicted = runtime.schema(key); expect(evicted).not.toBe(first);
      expect(compile).toHaveBeenCalledTimes(35);
      writeFileSync(join(installation.snapshot, "schemas/context.json"), JSON.stringify({ type: "object" }));
      expect(() => runtime.schema(key)).toThrow("coherent owned registry");
      expect(compile).toHaveBeenCalledTimes(35);
    } finally { compile.mockRestore(); }
  });
  test("installs immutable local snapshot, only serves manifest UI, and updates/rolls back", async () => {
    const base = root(); const runtime = new ExtensionRuntime({ root: join(base, "runtime") }); const source = fixture(base);
    const first = await runtime.install({ source, trustBrowserCode: true });
    expect(runtime.catalog().installations).toMatchObject([{ installationId: first.installation.installationId, enabled: true, package: { version: "1.0.0" } }]);
    expect(runtime.asset("fixture", first.installation.package.digest, "dist/ui.js").bytes.toString()).toContain("first");
    expect(() => runtime.asset("fixture", first.installation.package.digest, "package.json")).toThrow();
    writeFileSync(join(source, "dist", "ui.js"), "changed without update");
    expect(runtime.asset("fixture", first.installation.package.digest, "dist/ui.js").bytes.toString()).toContain("first");
    await runtime.install({ source: fixture(base, "1.1.0", "second"), trustBrowserCode: true });
    expect(runtime.get("fixture").package.version).toBe("1.1.0");
    expect(runtime.rollback("fixture").package.version).toBe("1.0.0");
    runtime.remove("fixture");
    const reinstalled = await runtime.install({ source: fixture(base, "1.2.0", "third"), trustBrowserCode: true });
    expect(reinstalled.installation.installationId).toBe(first.installation.installationId);
    runtime.remove("fixture"); runtime.purge("fixture");
    expect(runtime.catalog().installations).toEqual([]);
  });
  test("purge recovers only private document crash temporaries and retains other documents", async () => {
    const base = root(), runtimeRoot = join(base, "runtime");
    const runtime = new ExtensionRuntime({ root: runtimeRoot });
    await runtime.install({ source: fixture(base), trustBrowserCode: true });
    const store = new ExtensionDocumentStore({ root: runtimeRoot });
    const key = { installationId: runtime.installationId, scopeSessionId: sessionId, extensionId: "fixture", documentId: "context" };
    const request = { key, document: { schemaVersion: 1, goal: "saved" }, ifRevision: 0, schemaVersion: 1, requestId: "11111111-1111-4111-8111-111111111111" };
    const schema = compileStaticDocumentSchema(true);
    await store.publish(request, schema);
    await store.publish({ ...request, key: { ...key, extensionId: "other" } }, schema);
    const docs = join(runtimeRoot, "documents"), record = fs.readdirSync(docs)[0]!;
    writeFileSync(join(docs, `${record}.tmp-123-abcdef012345`), "partial", { mode: 0o600 });
    new ExtensionRuntime({ root: runtimeRoot }).purge("fixture");
    expect(store.read(key)).toBeNull();
    expect(store.read({ ...key, extensionId: "other" })?.revision).toBe(1);
    expect(fs.readdirSync(docs)).toHaveLength(1);
    expect(runtime.catalog().installations).toEqual([]);
  });

  test("reclaims superseded snapshots on update and leaves none after purge", async () => {
    const base = root(); const runtimeRoot = join(base, "runtime"); const runtime = new ExtensionRuntime({ root: runtimeRoot });
    const snapshots = () => fs.readdirSync(join(runtimeRoot, "snapshots")).filter((name) => !name.startsWith(".")).sort();
    const v1 = await runtime.install({ source: fixture(base, "1.0.0", "first"), trustBrowserCode: true });
    const v2 = await runtime.install({ source: fixture(base, "1.1.0", "second"), trustBrowserCode: true });
    const v3 = await runtime.install({ source: fixture(base, "1.2.0", "third"), trustBrowserCode: true });
    expect(snapshots()).toEqual([v2.installation.package.digest, v3.installation.package.digest].sort());
    expect(fs.existsSync(v1.installation.snapshot)).toBe(false);
    const again = await runtime.install({ source: fixture(base, "1.1.0", "second"), trustBrowserCode: true });
    expect(again.installation.package.digest).toBe(v2.installation.package.digest);
    expect(snapshots()).toEqual([v2.installation.package.digest, v3.installation.package.digest].sort());
    expect(runtime.asset("fixture", v2.installation.package.digest, "dist/ui.js").bytes.toString()).toContain("second");
    runtime.remove("fixture"); runtime.purge("fixture");
    expect(snapshots()).toEqual([]);
  });
  test("rejects a registry snapshot whose copied bytes no longer match its immutable digest", async () => {
    const base = root(); const runtime = new ExtensionRuntime({ root: join(base, "runtime") });
    const installed = await runtime.install({ source: fixture(base), trustBrowserCode: true });
    writeFileSync(join(installed.installation.snapshot, "dist", "ui.js"), "copied bytes changed after admission");
    expect(() => runtime.catalog()).toThrow("coherent owned registry");
  });
  test("rejects invalid schemas before committing an installation", async () => {
    const base = root(); const source = fixture(base);
    writeFileSync(join(source, "schemas", "context.json"), JSON.stringify({ type: "not-a-json-schema-type" }));
    const runtime = new ExtensionRuntime({ root: join(base, "runtime") });
    await expect(runtime.install({ source, trustBrowserCode: true })).rejects.toThrow();
    expect(runtime.catalog().installations).toEqual([]);
  });

  test("qualifies same relative UI asset names by extension and immutable package digest", async () => {
    const base = root(); const runtime = new ExtensionRuntime({ root: join(base, "runtime") });
    const first = await runtime.install({ source: fixture(base, "1.0.0", "one"), trustBrowserCode: true });
    const secondSource = fixture(base, "1.0.1", "two");
    const packageJson = JSON.parse(readFileSync(join(secondSource, "package.json"), "utf8")); packageJson.name = "second-fixture"; packageJson.wolfpack.id = "second-fixture"; writeFileSync(join(secondSource, "package.json"), JSON.stringify(packageJson));
    const second = await runtime.install({ source: secondSource, trustBrowserCode: true });
    const catalog = runtime.catalog().installations; expect(catalog[0]!.ui!.url).not.toBe(catalog[1]!.ui!.url);
    expect(runtime.asset("fixture", first.installation.package.digest, "dist/ui.js").bytes.toString()).toContain("one");
    expect(runtime.asset("second-fixture", second.installation.package.digest, "dist/ui.js").bytes.toString()).toContain("two");
  });
  test("server document service uses installation and exact live UUID, retains reads after exit and blocks disable", async () => {
    const base = root(); const runtime = new ExtensionRuntime({ root: join(base, "runtime") }); const { installation: installed } = await runtime.install({ source: fixture(base), trustBrowserCode: true }); const service = new ExtensionRouteService({ runtime, backend });
    const res = await fetchThrough(service, "POST", "/api/extensions/documents/fixture/context", { sessionId, document: { schemaVersion: 1, goal: "saved" }, ifRevision: 0, requestId: "c0a80123-1234-4234-9234-123456789abc", schemaVersion: 1 });
    expect(res.status).toBe(200); expect(res.body).toMatchObject({ receipt: { revision: 1, scopeSessionId: sessionId } });
    const read = await fetchThrough(service, "GET", `/api/extensions/documents/fixture/context?session=${sessionId}`); expect(read.body).toMatchObject({ installationId: installed.installationId, revision: 1, document: { goal: "saved" } });
    runtime.setEnabled("fixture", false);
    const blocked = await fetchThrough(service, "POST", "/api/extensions/documents/fixture/context", { sessionId, document: { schemaVersion: 1, goal: "new" }, ifRevision: 1, requestId: "d0a80123-1234-4234-9234-123456789abc", schemaVersion: 1 }); expect(blocked.status).toBe(409); expect(blocked.body).toMatchObject({ error: { code: "DISABLED" } });
  });
});
async function fetchThrough(service: ExtensionRouteService, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const request = new Request(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const req = Object.assign(Bun.serve as unknown as Record<string, unknown>, { method, url: path, headers: {}, on() {}, destroy() {} }) as any;
  // Route body parser only needs a normal Node readable; this tiny async stream keeps the test at the HTTP route boundary.
  req[Symbol.asyncIterator] = async function* () { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); };
  req.on = (event: string, callback: (...args: any[]) => void) => { if (event === "data" && body !== undefined) callback(Buffer.from(JSON.stringify(body))); if (event === "end") queueMicrotask(callback); return req; };
  const chunks: Buffer[] = []; const response: any = { headersSent: false, setHeader() {}, getHeader() { return undefined; }, writeHead(status: number) { response.status = status; response.headersSent = true; }, end(value?: string | Buffer) { if (value) chunks.push(Buffer.from(value)); response.done?.(); } };
  await new Promise<void>(async (done) => { response.done = done; const handled = await service.handle(req, response, new URL(request.url)); if (!handled) done(); });
  return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
}
