import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const scratch = mkdtempSync(join(tmpdir(), "wp-runtime-review-"));
const hostId = "11111111-1111-4111-8111-111111111111";
const scope = "22222222-2222-4222-8222-222222222222";
process.env.HOME = scratch;
process.env.WOLFPACK_TEST = "1";
process.env.WOLFPACK_MACHINE_ID_PATH = join(scratch, "machine-id");
process.env.WOLFPACK_BROKER_SOCKET = join(scratch, "unused.sock");
process.env.WOLFPACK_TASK_ROOT = join(scratch, "tasks");
process.env.WOLFPACK_TASK_RELAY_ROOT = join(scratch, "relay");
process.env.WOLFPACK_JWT_SECRET = "isolated-runtime-review-secret-not-a-credential";
writeFileSync(process.env.WOLFPACK_MACHINE_ID_PATH, `${hostId}\n`, { mode: 0o600 });
const persistence = await import("../../src/server/persistence.ts");
const realWrite = persistence.writePrivateJsonFile;
let failRegistryWrite = false;
mock.module("../../src/server/persistence.ts", () => ({
  ...persistence,
  writePrivateJsonFile(path: string, value: unknown) {
    if (failRegistryWrite && path.endsWith("/registry.json")) throw new Error("injected registry commit I/O failure");
    return realWrite(path, value);
  },
}));
const { ExtensionRuntime } = await import("../../src/extensions/runtime.ts");
const { getInstallationId } = await import("../../src/tailnet-machine-installation.ts");
const { ExtensionRouteService, __setExtensionRouteServiceForTests } = await import("../../src/server/extension-routes.ts");
const { __resetJwtAuthConfig } = await import("../../src/test-hooks.ts");
__resetJwtAuthConfig();
const { createServerInstance } = await import("../../src/server/index.ts");
const backend = { async listSessionFacts() { return [{ name: "review", alive: true, identity: { wolfpackSessionId: scope } }]; } } as any;

function fixture(options: { id?: string; name?: string; version?: string; schemaVersion?: number; schema?: unknown; skillText?: string } = {}) {
  const source = mkdtempSync(join(scratch, "source-"));
  mkdirSync(join(source, "dist"));
  mkdirSync(join(source, "schemas"));
  const skills = options.skillText === undefined ? [] : ["skills/runtime-review-skill"];
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: options.name ?? "review-extension", version: options.version ?? "1.0.0",
    wolfpack: { manifestVersion: 1, apiVersion: 1, id: options.id ?? "review",
      ui: "dist/ui.js", skills,
      documents: [{ id: "context", schemaVersion: options.schemaVersion ?? 1, schema: "schemas/context.json" }] },
  }));
  writeFileSync(join(source, "dist/ui.js"), "export default () => {};\n");
  writeFileSync(join(source, "schemas/context.json"), JSON.stringify(options.schema ?? { type: "object", properties: { goal: { type: "string" } }, required: ["goal"], additionalProperties: false }));
  if (options.skillText !== undefined) {
    mkdirSync(join(source, "skills/runtime-review-skill"), { recursive: true });
    writeFileSync(join(source, "skills/runtime-review-skill/SKILL.md"), `---\nname: runtime-review-skill\ndescription: Harmless isolated review fixture\n---\n${options.skillText}\n`);
  }
  return source;
}
function runtime() { return new ExtensionRuntime({ root: mkdtempSync(join(scratch, "runtime-")) }); }
function install(r: InstanceType<typeof ExtensionRuntime>, source: string, skillsRoot?: string) {
  return r.install({ source, trustBrowserCode: true, ...(skillsRoot ? { skillsRoot } : {}) });
}
async function caught(action: () => Promise<unknown>) { try { await action(); return undefined; } catch (error) { return error; } }
function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iat: now, exp: now + 300 })).toString("base64url");
  return `${head}.${body}.${createHmac("sha256", process.env.WOLFPACK_JWT_SECRET!).update(`${head}.${body}`).digest("base64url")}`;
}
const routeRuntime = runtime();
await install(routeRuntime, fixture());
__setExtensionRouteServiceForTests(new ExtensionRouteService({ runtime: routeRuntime, backend }));
const { server } = createServerInstance();
let base: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  __setExtensionRouteServiceForTests(undefined);
  rmSync(scratch, { recursive: true, force: true });
});
const intended = "/api/extensions/documents/review/context";
const alias = "/" + "x".repeat("/api/extensions/documents/".length - 1) + "review/context";
function operation(schemaVersion = 1) { return { sessionId: scope, document: { goal: "harmless private context" }, ifRevision: 0, requestId: randomUUID(), schemaVersion }; }

test("control: intended document route requires JWT and legitimate publication succeeds", async () => {
  expect((await fetch(`${base}${intended}?session=${scope}`)).status).toBe(401);
  const response = await fetch(`${base}${intended}`, { method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" }, body: JSON.stringify(operation()) });
  expect(response.status).toBe(200);
});
test("non-API alias cannot read an authenticated extension document", async () => {
  const response = await fetch(`${base}${alias}?session=${scope}`);
  const body = await response.text();
  expect({ status: response.status, body }).not.toMatchObject({ status: 200 });
});
test("non-API alias cannot publish without JWT", async () => {
  const response = await fetch(`${base}${alias}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...operation(), ifRevision: 1 }) });
  const body = await response.text();
  expect({ status: response.status, body }).not.toMatchObject({ status: 200 });
});
test("catalog identities equal the owning Wolfpack installation across two packages", async () => {
  expect(getInstallationId()).toBe(hostId);
  const r = runtime();
  await install(r, fixture({ id: "one", name: "one" }));
  await install(r, fixture({ id: "two", name: "two" }));
  expect(r.catalog().installations.map((entry) => entry.installationId)).toEqual([hostId, hostId]);
});
test.each(["dist/ui.js", "schemas/context.json"])("missing declared %s rejects installation without activation", async (path) => {
  const r = runtime();
  const source = fixture();
  rmSync(join(source, path));
  expect(await caught(() => install(r, source))).toBeDefined();
  expect(r.catalog().installations).toEqual([]);
});
test("same-version incompatible schema content cannot replace the active package", async () => {
  const r = runtime();
  await install(r, fixture());
  const next = fixture({ version: "1.1.0", schema: { type: "object", required: ["goal"], properties: { goal: { type: "number" } }, additionalProperties: false } });
  expect(await caught(() => install(r, next))).toBeDefined();
  expect(r.get("review").package.version).toBe("1.0.0");
});
test("a different package cannot silently assume an existing extension ID", async () => {
  const r = runtime();
  await install(r, fixture({ name: "first-owner" }));
  expect(await caught(() => install(r, fixture({ name: "different-owner", version: "2.0.0" })))).toBeDefined();
  expect(r.get("review").package.name).toBe("first-owner");
});
test("rejected schema update leaves already deployed owned skill unchanged", async () => {
  const r = runtime();
  const skillsRoot = mkdtempSync(join(scratch, "skills-"));
  await install(r, fixture({ skillText: "OLD SKILL" }), skillsRoot);
  const owned = join(skillsRoot, "runtime-review-skill/SKILL.md");
  const before = readFileSync(owned, "utf8");
  const failure = await caught(() => install(r, fixture({ version: "2.0.0", schemaVersion: 2, skillText: "NEW SKILL" }), skillsRoot));
  expect(failure).toBeDefined();
  expect(r.get("review").package.version).toBe("1.0.0");
  expect(readFileSync(owned, "utf8")).toBe(before);
});
test("registry commit failure during purge does not destroy the active snapshot", async () => {
  const r = runtime();
  const installed = await install(r, fixture());
  let failure: unknown;
  failRegistryWrite = true;
  try { r.purge("review"); } catch (error) { failure = error; }
  finally { failRegistryWrite = false; }
  expect(failure).toBeDefined();
  expect(r.get("review").package.version).toBe("1.0.0");
  expect(existsSync(join(installed.installation.snapshot, "package.json"))).toBe(true);
});
test("successful npm installation cleans owned acquisition and extraction intermediates", async () => {
  const r = runtime();
  const source = fixture();
  const tar = await import("tar");
  const archive = join(scratch, "fixture.tgz");
  await tar.c({ file: archive, cwd: source, prefix: "package", gzip: true }, ["package.json", "dist", "schemas"]);
  const bytes = readFileSync(archive);
  const { createHash } = await import("node:crypto");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/fixture.tgz") return new Response(bytes);
    return Response.json({ name: "review-extension", version: "1.0.0", dist: { tarball: `${registry.url.origin}/fixture.tgz`, integrity } });
  } });
  try {
    const installed = await r.install({ source: "npm:review-extension@1.0.0", registryUrl: registry.url.origin, trustBrowserCode: true });
    expect(installed.installation.package.name).toBe("review-extension");
    expect(readdirSync(join(r.root, "acquisition"))).toEqual([]);
    expect(readdirSync(join(r.root, "snapshots"))).toEqual([installed.installation.package.digest]);
  } finally { await registry.stop(true); }
});
test("corrupt registry cannot make purge delete a directory outside owned snapshots", () => {
  const r = runtime();
  const unrelated = fixture();
  writeFileSync(join(r.root, "registry.json"), JSON.stringify({ version: 1, installations: [{
    installationId: randomUUID(), extensionId: "review", enabled: true,
    package: { name: "review-extension", version: "1.0.0", digest: "a".repeat(64) },
    snapshot: unrelated,
  }] }));
  let failure: unknown;
  try { r.purge("review"); } catch (error) { failure = error; }
  expect({ rejected: failure !== undefined, unrelatedIntact: existsSync(join(unrelated, "package.json")) }).toEqual({ rejected: true, unrelatedIntact: true });
});
test("public CLI honors its advertised explicit skills-root removal option", () => {
  const home = mkdtempSync(join(scratch, "cli-home-"));
  const skillsRoot = mkdtempSync(join(scratch, "cli-skills-"));
  const source = fixture({ skillText: "CLI SKILL" });
  const cli = (args: string[]) => Bun.spawnSync([process.execPath, new URL("../../src/cli/index.ts", import.meta.url).pathname, ...args], {
    cwd: home, env: { ...process.env, HOME: home, WOLFPACK_PI_SKILLS_ROOT: skillsRoot }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const installed = cli(["extensions", "install", source, "--trust-browser-code", "--skills", "pi"]);
  expect({ exit: installed.exitCode, stderr: installed.stderr.toString() }).toMatchObject({ exit: 0 });
  expect(existsSync(join(skillsRoot, "runtime-review-skill/SKILL.md"))).toBe(true);
  const removed = cli(["extensions", "remove", "review", "--skills-root", skillsRoot]);
  expect({ exit: removed.exitCode, stderr: removed.stderr.toString() }).toMatchObject({ exit: 0 });
  expect(existsSync(join(skillsRoot, "runtime-review-skill/SKILL.md"))).toBe(false);
});
test("new publication must match the installed declaration schemaVersion", async () => {
  const latest = await fetch(`${base}${intended}?session=${scope}`, { headers: { Authorization: `Bearer ${token()}` } });
  const current = await latest.json() as { revision: number };
  const response = await fetch(`${base}${intended}`, { method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...operation(999), ifRevision: current.revision }) });
  const body = await response.text();
  expect({ status: response.status, body }).not.toMatchObject({ status: 200 });
});
