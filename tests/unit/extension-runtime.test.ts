import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRuntime } from "../../src/extensions/runtime.ts";
import { ExtensionRouteService } from "../../src/server/extension-routes.ts";
import type { SessionBackend } from "../../src/server/backend-contract.ts";

const sessionId = "b0a80123-1234-4234-9234-123456789abc";
const roots: string[] = [];
function root() { const value = mkdtempSync(join(tmpdir(), "wolfpack-extension-runtime-")); roots.push(value); return value; }
function fixture(parent: string, version = "1.0.0", goal = "first") { const source = join(parent, `source-${version}`); mkdirSync(join(source, "dist"), { recursive: true }); mkdirSync(join(source, "schemas"), { recursive: true }); writeFileSync(join(source, "package.json"), JSON.stringify({ name: "fixture-extension", version, wolfpack: { manifestVersion: 1, apiVersion: 1, id: "fixture", ui: "dist/ui.js", skills: [], documents: [{ id: "context", schemaVersion: 1, schema: "schemas/context.json" }] } })); writeFileSync(join(source, "dist", "ui.js"), `export default function(){ return ${JSON.stringify(goal)}; }`); writeFileSync(join(source, "schemas", "context.json"), JSON.stringify({ type: "object", additionalProperties: false, required: ["schemaVersion", "goal"], properties: { schemaVersion: { const: 1 }, goal: { type: "string" } } })); return source; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const backend = { async listSessionFacts() { return [{ name: "live", alive: true, identity: { wolfpackSessionId: sessionId } }]; } } as unknown as SessionBackend;

describe("extension runtime integration", () => {
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
  test("rejects a registry snapshot whose copied bytes no longer match its immutable digest", async () => {
    const base = root(); const runtime = new ExtensionRuntime({ root: join(base, "runtime") });
    const installed = await runtime.install({ source: fixture(base), trustBrowserCode: true });
    writeFileSync(join(installed.installation.snapshot, "dist", "ui.js"), "copied bytes changed after admission");
    expect(() => runtime.catalog()).toThrow("coherent owned registry");
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
