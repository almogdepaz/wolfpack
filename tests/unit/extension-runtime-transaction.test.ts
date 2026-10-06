import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { ExtensionRuntime } from "../../src/extensions/runtime.ts";

const hostId = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
function root() { const value = mkdtempSync(join(tmpdir(), "wolfpack-extension-transaction-")); roots.push(value); return value; }
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

function fixture(parent: string, version = "1.0.0", id = "fixture", name = "fixture-extension") {
  const source = mkdtempSync(join(parent, "source-"));
  mkdirSync(join(source, "dist"));
  writeFileSync(join(source, "package.json"), JSON.stringify({ name, version, wolfpack: { manifestVersion: 1, apiVersion: 1, id, ui: "dist/ui.js", skills: [], documents: [] } }));
  writeFileSync(join(source, "dist", "ui.js"), "export default () => {};\n");
  return source;
}
function stages(runtime: ExtensionRuntime) { return readdirSync(join(runtime.root, "snapshots")).filter((name) => name.startsWith(".stage-")); }

async function installNpm(runtime: ExtensionRuntime, requested: string, actual: { name: string; version: string; id: string }, skillsRoot: string) {
  const source = fixture(root(), actual.version, actual.id, actual.name);
  const archive = join(root(), "package.tgz");
  await tar.c({ file: archive, cwd: source, prefix: "package", gzip: true }, ["package.json", "dist"]);
  const bytes = await Bun.file(archive).arrayBuffer();
  const integrity = `sha512-${createHash("sha512").update(Buffer.from(bytes)).digest("base64")}`;
  let registry!: ReturnType<typeof Bun.serve>;
  registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/package.tgz") return new Response(bytes);
    const [name, version] = requested.slice(4).lastIndexOf("@") > 0
      ? [requested.slice(4, requested.lastIndexOf("@")), requested.slice(requested.lastIndexOf("@") + 1)]
      : ["", ""];
    return Response.json({ name, version, dist: { tarball: `${registry.url.origin}/package.tgz`, integrity } });
  } });
  try { return await runtime.install({ source: requested, registryUrl: registry.url.origin, trustBrowserCode: true, skillsRoot }); }
  finally { await registry.stop(true); }
}

describe("extension snapshot transactions", () => {
  test("BUSY leaves current, previous, removed-retained snapshots and no operation stage untouched", async () => {
    const base = root(); const runtime = new ExtensionRuntime({ root: join(base, "runtime"), installationId: hostId });
    const v1 = fixture(base, "1.0.0"); const first = await runtime.install({ source: v1, trustBrowserCode: true });
    const v2 = fixture(base, "1.0.1"); const second = await runtime.install({ source: v2, trustBrowserCode: true });
    const busyInstall = async (source: string) => {
      mkdirSync(join(runtime.root, ".registry-lock"));
      try { await expect(runtime.install({ source, trustBrowserCode: true })).rejects.toMatchObject({ code: "BUSY" }); }
      finally { rmSync(join(runtime.root, ".registry-lock"), { recursive: true, force: true }); }
    };
    await busyInstall(v2);
    expect(runtime.asset("fixture", second.installation.package.digest, "dist/ui.js").bytes.byteLength).toBeGreaterThan(0);
    expect({ current: existsSync(second.installation.snapshot), previous: existsSync(first.installation.snapshot), stages: stages(runtime) }).toEqual({ current: true, previous: true, stages: [] });
    // v1 is the active installation's retained previous digest, not merely a removed record.
    await busyInstall(v1);
    expect(runtime.catalog().installations).toHaveLength(1);
    expect(runtime.rollback("fixture").package.version).toBe("1.0.0");
    expect(runtime.asset("fixture", first.installation.package.digest, "dist/ui.js").bytes.byteLength).toBeGreaterThan(0);
    expect(runtime.rollback("fixture").package.version).toBe("1.0.1");
    runtime.remove("fixture");
    await busyInstall(v1);
    expect(runtime.catalog().installations).toEqual([]);
    expect({ current: existsSync(second.installation.snapshot), previous: existsSync(first.installation.snapshot), stages: stages(runtime) }).toEqual({ current: true, previous: true, stages: [] });
  });

  test("overlapping same-digest installs retain the winning snapshot when the first publication fails", async () => {
    const base = root(); const runtime = new ExtensionRuntime({ root: join(base, "runtime"), installationId: hostId }); const source = fixture(base);
    const seam = runtime as any, save = seam.save.bind(runtime); const primary = new Error("first transaction fails before commit"); let calls = 0;
    seam.save = (value: unknown) => { if (++calls === 1) throw primary; save(value); };
    const outcomes = await Promise.allSettled([runtime.install({ source, trustBrowserCode: true }), runtime.install({ source, trustBrowserCode: true })]);
    expect(outcomes.map(outcome => outcome.status)).toEqual(["rejected", "fulfilled"]);
    expect((outcomes[0] as PromiseRejectedResult).reason).toBe(primary);
    const installed = (outcomes[1] as PromiseFulfilledResult<any>).value.installation;
    expect(readdirSync(join(runtime.root, "snapshots"))).toEqual([installed.package.digest]);
    expect(stages(runtime)).toEqual([]);
    expect(runtime.asset("fixture", installed.package.digest, "dist/ui.js").bytes.byteLength).toBeGreaterThan(0);
  });

  test("save failure preserves the original error and uses the authoritative registry to distinguish pre-, post-, and unknown commit state", async () => {
    const installWith = async (mode: "pre" | "post" | "unknown") => {
      const base = root(); const runtime = new ExtensionRuntime({ root: join(base, `runtime-${mode}`), installationId: hostId }); const source = fixture(base); const seam = runtime as any, save = seam.save.bind(runtime); const primary = new Error(`${mode} save failure`);
      seam.save = (value: unknown) => { if (mode !== "pre") save(value); if (mode === "unknown") writeFileSync(join(runtime.root, "registry.json"), "not json"); throw primary; };
      await expect(runtime.install({ source, trustBrowserCode: true })).rejects.toBe(primary);
      return { runtime, primary };
    };
    const pre = await installWith("pre");
    expect(readdirSync(join(pre.runtime.root, "snapshots"))).toEqual([]);
    expect(pre.runtime.catalog().installations).toEqual([]);
    const post = await installWith("post");
    expect(post.runtime.catalog().installations).toHaveLength(1);
    const postEntry = post.runtime.catalog().installations[0]!;
    expect(post.runtime.asset(postEntry.extensionId, postEntry.package.digest, "dist/ui.js").bytes.byteLength).toBeGreaterThan(0);
    const unknown = await installWith("unknown");
    expect(readdirSync(join(unknown.runtime.root, "snapshots"))).toHaveLength(1);
    expect(() => unknown.runtime.catalog()).toThrow("coherent owned registry");
  });

  test("cleanup diagnostics cannot replace frozen or already decorated errors", () => {
    const runtime = new ExtensionRuntime({ root: join(root(), "runtime"), installationId: hostId }); const retain = (runtime as any).retainCleanupFailure.bind(runtime);
    const frozen = Object.freeze(new Error("original")); expect(() => retain(frozen, new Error("cleanup"))).not.toThrow();
    const decorated = new Error("original"); Object.defineProperty(decorated, "cleanupFailure", { value: new Error("first"), configurable: false });
    expect(() => retain(decorated, new Error("second"))).not.toThrow();
  });
});

describe("exact npm manifest identity", () => {
  test("cleans a copied private stage and later acquisition resources when extraction cleanup fails", async () => {
    const base = root(); const runtime = new ExtensionRuntime({ root: join(base, "runtime"), installationId: hostId }); const skills = join(base, "skills"); mkdirSync(skills);
    const seam = runtime as any, cleanup = seam.cleanupTree.bind(runtime); const primary = new Error("injected extraction cleanup failure");
    seam.cleanupTree = (path: string, message: string) => { if (path.includes(".extension-stage-")) throw primary; cleanup(path, message); };
    await expect(installNpm(runtime, "npm:expected@1.0.0", { name: "expected", version: "1.0.0", id: "expected" }, skills)).rejects.toBe(primary);
    expect(stages(runtime)).toEqual([]);
    expect(readdirSync(join(runtime.root, "acquisition"))).toEqual([]);
  });

  test("rejects name, version, and scoped-name mismatches without changing the registry, skills, or private stages", async () => {
    const base = root(); const runtime = new ExtensionRuntime({ root: join(base, "runtime"), installationId: hostId }); const skills = join(base, "skills"); mkdirSync(skills); writeFileSync(join(skills, "sentinel"), "unchanged");
    const valid = await installNpm(runtime, "npm:@scope/expected@1.0.0", { name: "@scope/expected", version: "1.0.0", id: "expected" }, skills);
    const catalog = runtime.catalog(); const snapshots = readdirSync(join(runtime.root, "snapshots"));
    for (const mismatch of [
      ["npm:expected@1.0.0", { name: "other", version: "1.0.0", id: "other" }],
      ["npm:expected@1.0.0", { name: "expected", version: "2.0.0", id: "other" }],
      ["npm:@scope/expected@1.0.0", { name: "@scope/other", version: "1.0.0", id: "other" }],
    ] as const) await expect(installNpm(runtime, mismatch[0], mismatch[1], skills)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(runtime.catalog()).toEqual(catalog);
    expect(valid.installation.package).toMatchObject({ name: "@scope/expected", version: "1.0.0" });
    expect({ snapshots: readdirSync(join(runtime.root, "snapshots")), stages: stages(runtime), acquisition: readdirSync(join(runtime.root, "acquisition")), skills: readdirSync(skills) }).toEqual({ snapshots, stages: [], acquisition: [], skills: ["sentinel"] });
  });
});
