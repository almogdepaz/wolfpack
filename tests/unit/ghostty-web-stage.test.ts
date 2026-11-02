import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGhosttyWebCore, withGhosttyWebStage } from "../../scripts/ghostty-web-stage.ts";

const root = join(import.meta.dirname, "../..");
const installed = join(root, "node_modules/ghostty-web");
const patchPath = join(root, "patches/ghostty-web-render-suspension.patch");
const lockPath = join(root, "patches/ghostty-web-render-suspension.json");
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
interface FixtureLock { patchSha256: string; outputs: Record<string, string>; }
function fixture() {
  const parent = mkdtempSync("/tmp/wp-ghostty-stage-test-"); roots.push(parent);
  const packageRoot = join(parent, "package");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  for (const file of ["package.json", "LICENSE", "dist/index.d.ts", "dist/ghostty-web.js", "dist/__vite-browser-external-2447137e.js"]) copyFileSync(join(installed, file), join(packageRoot, file));
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as FixtureLock;
  const modifiedLock = join(parent, "lock.json"), modifiedPatch = join(parent, "render.patch");
  const options = { packageRoot, lockPath: modifiedLock, patchPath: modifiedPatch, stageParent: parent };
  const save = (patch = readFileSync(patchPath, "utf8")) => { lock.patchSha256 = hash(patch); writeFileSync(modifiedPatch, patch); writeFileSync(modifiedLock, JSON.stringify(lock)); };
  save();
  const expectClean = () => expect(readdirSync(parent).filter(file => file.startsWith("wolfpack-ghostty-web-"))).toEqual([]);
  return { parent, packageRoot, lock, options, save, expectClean };
}

test("private stages preserve the installed distribution, license, and matching supported API types", async () => {
  const before = ["dist/ghostty-web.js", "dist/ghostty-web.umd.cjs", "dist/index.d.ts"].map(file => hash(readFileSync(join(installed, file))));
  let directory = "";
  await withGhosttyWebStage(async stage => {
    directory = stage.directory;
    expect(stage.version).toBe("0.4.0");
    expect(stage.license).toContain("Copyright (c) 2025 Coder");
    const types = readFileSync(stage.typesPath, "utf8");
    const globals = readFileSync(join(root, "public/types-globals.d.ts"), "utf8");
    for (const signature of ["suspendRendering(): void;", "resumeRendering(): void;", "readonly renderingSuspended: boolean;"]) {
      expect(types).toContain(signature); expect(globals).toContain(signature);
    }
  });
  expect(existsSync(directory)).toBe(false);
  expect(["dist/ghostty-web.js", "dist/ghostty-web.umd.cjs", "dist/index.d.ts"].map(file => hash(readFileSync(join(installed, file))))).toEqual(before);
});

test("clean stages produce deterministic browser core bytes and are removed after build", async () => {
  const first = await withGhosttyWebStage(buildGhosttyWebCore);
  const second = await withGhosttyWebStage(buildGhosttyWebCore);
  expect(second).toBe(first);
  expect(first).toContain("MIT License");
  expect(first).toContain("suspendRendering");
});

test("a failed stage consumer releases only its owned temporary directory", async () => {
  const f = fixture();
  await expect(withGhosttyWebStage(async () => { throw new Error("injected consumer/build failure"); }, f.options)).rejects.toThrow("injected consumer");
  f.expectClean(); expect(existsSync(f.packageRoot)).toBe(true);
});

test("version and installed-byte drift fail before the stage can become trust", async () => {
  const f = fixture();
  const pkg = JSON.parse(readFileSync(join(f.packageRoot, "package.json"), "utf8"));
  writeFileSync(join(f.packageRoot, "package.json"), JSON.stringify({ ...pkg, version: "0.4.1" }));
  await expect(withGhosttyWebStage(async () => undefined, f.options)).rejects.toThrow("requires installed ghostty-web@0.4.0");
  writeFileSync(join(f.packageRoot, "package.json"), JSON.stringify(pkg));
  const path = join(f.packageRoot, "dist/ghostty-web.js"), bytes = readFileSync(path);
  bytes[0] = bytes[0] === 32 ? 33 : 32; writeFileSync(path, bytes);
  await expect(withGhosttyWebStage(async () => undefined, f.options)).rejects.toThrow("input drift");
  f.expectClean();
});

test("changed patch bytes and unexpected output digests fail closed", async () => {
  const f = fixture();
  writeFileSync(f.options.patchPath, readFileSync(patchPath, "utf8") + "\n");
  await expect(withGhosttyWebStage(async () => undefined, f.options)).rejects.toThrow("patch digest drift");
  f.lock.outputs["dist/ghostty-web.js"] = "0".repeat(64); f.save();
  await expect(withGhosttyWebStage(async () => undefined, f.options)).rejects.toThrow("output drift");
  f.expectClean();
});

for (const kind of ["offset", "fuzz"] as const) test(`unified hunks requiring ${kind} are never accepted`, async () => {
  const f = fixture();
  let patch = readFileSync(patchPath, "utf8");
  patch = kind === "offset" ? patch.replace("@@ -1339,6 +1339,7 @@", "@@ -1338,6 +1338,7 @@")
    : patch.replace(" const RENDER_COLOR_CACHE_LIMIT = 256;", " const RENDER_COLOR_CACHE_LIMIT = 257;");
  f.save(patch);
  await expect(withGhosttyWebStage(async () => undefined, f.options)).rejects.toThrow("no fuzz/offset");
  f.expectClean();
});
