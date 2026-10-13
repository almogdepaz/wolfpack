import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync as createTemp, mkdirSync, writeFileSync, lstatSync, symlinkSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseExtensionPackageManifest } from "../../src/extensions/manifest.ts";

const roots: string[] = [];
function mkdtempSync(prefix: string) { const root = createTemp(prefix); roots.push(root); return root; }
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const installationId = "11111111-1111-4111-8111-111111111111";
const key = { installationId, extensionId: "stage" };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
test("manifest blob declaration is optional and strictly bounded", () => {
  const base = { name: "stage", version: "1.0.0", wolfpack: { manifestVersion: 1, apiVersion: 1, id: "stage", documents: [], skills: [] } };
  expect(parseExtensionPackageManifest(base).wolfpack.blobs).toBeUndefined();
  for (const maxBlobBytes of [1, 65536, 1048576]) expect(parseExtensionPackageManifest({ ...base, wolfpack: { ...base.wolfpack, blobs: { maxBlobBytes } } }).wolfpack.blobs).toEqual({ maxBlobBytes });
  for (const maxBlobBytes of [0, -1, 1.5, 1048577, "64"]) expect(() => parseExtensionPackageManifest({ ...base, wolfpack: { ...base.wolfpack, blobs: { maxBlobBytes } } })).toThrow();
});
test("blob store verifies content, is idempotent, private, and deletes", async () => {
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blobs-")), store = new ExtensionBlobStore({ root });
  const bytes = Buffer.from([0, 255, 1]), sha = digest(bytes);
  expect(store.put(key, sha, bytes, 64).created).toBe(true);
  expect(store.put(key, sha, bytes, 64).created).toBe(false);
  expect(store.read(key, sha)).toEqual(bytes);
  expect(lstatSync(join(root, "blobs", installationId, "stage", `${sha}.bin`)).mode & 0o777).toBe(0o600);
  expect(() => store.put(key, "a".repeat(64), bytes, 64)).toThrow("digest");
  expect(() => store.put(key, sha, bytes, 2)).toThrow("limit");
  expect(store.delete(key, sha)).toBe(true); expect(store.delete(key, sha)).toBe(false); expect(store.read(key, sha)).toBeNull();
});
test("GET recovers a stale writer temporary beside a valid blob", async () => {
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blob-temp-get-")), store = new ExtensionBlobStore({ root }), bytes = Buffer.from([8]), sha = digest(bytes);
  store.put(key, sha, bytes, 64);
  const temp = join(root, "blobs", installationId, "stage", `${sha}.bin.tmp-123-abcdef`), sentinel = join(root, "sentinel");
  writeFileSync(temp, "partial"); writeFileSync(sentinel, "outside");
  expect(store.read(key, sha)).toEqual(bytes); expect(fs.existsSync(temp)).toBe(false); expect(fs.readFileSync(sentinel, "utf8")).toBe("outside");
});
test("PUT independently recovers stale writer temporaries without charging count or byte quota", async () => {
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blob-temp-put-")), store = new ExtensionBlobStore({ root });
  for (let n = 0; n < 63; n++) { const bytes = Buffer.from([n]); store.put(key, digest(bytes), bytes, 64); }
  const bytes = Buffer.from([99]), sha = digest(bytes), temp = join(root, "blobs", installationId, "stage", `${sha}.bin.tmp-456-012abc`);
  writeFileSync(temp, Buffer.alloc(16 * 1024 * 1024 + 1));
  expect(store.put(key, sha, bytes, 64).created).toBe(true); expect(fs.existsSync(temp)).toBe(false); expect(store.read(key, sha)).toEqual(bytes);
});
test.each(["symlink", "directory"] as const)("tmp-shaped %s stays corrupt and untouched", async kind => {
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blob-temp-unsafe-")), store = new ExtensionBlobStore({ root }), bytes = Buffer.from([8]), sha = digest(bytes);
  store.put(key, sha, bytes, 64);
  const temp = join(root, "blobs", installationId, "stage", `${sha}.bin.tmp-123-abcdef`), target = join(root, "sentinel");
  writeFileSync(target, "outside"); if (kind === "symlink") symlinkSync(target, temp); else mkdirSync(temp);
  expect(() => store.read(key, sha)).toThrow(expect.objectContaining({ code: "STORE_CORRUPT" }));
  expect(() => store.put(key, sha, bytes, 64)).toThrow(expect.objectContaining({ code: "STORE_CORRUPT" }));
  expect(lstatSync(temp).isSymbolicLink()).toBe(kind === "symlink"); expect(fs.readFileSync(target, "utf8")).toBe("outside");
});
test.each([
  `${"A".repeat(64)}.bin.tmp-123-abcdef`, `${"a".repeat(63)}.bin.tmp-123-abcdef`,
  `${"a".repeat(64)}.bin.tmp-pid-abcdef`, `${"a".repeat(64)}.bin.tmp-123-ABCDEF`,
  `${"a".repeat(64)}.bin.tmp-123-`, `${"a".repeat(64)}.bin.tmp-123-abcdef.extra`, "foreign",
])("near-match temporary or foreign name remains refused: %s", async name => {
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blob-temp-foreign-")), store = new ExtensionBlobStore({ root }), bytes = Buffer.from([8]), sha = digest(bytes);
  store.put(key, sha, bytes, 64); const path = join(root, "blobs", installationId, "stage", name); writeFileSync(path, "foreign");
  expect(() => store.read(key, sha)).toThrow(expect.objectContaining({ code: "STORE_CORRUPT" }));
  expect(() => store.put(key, sha, bytes, 64)).toThrow(expect.objectContaining({ code: "STORE_CORRUPT" }));
  expect(fs.readFileSync(path, "utf8")).toBe("foreign");
});
test("runtime catalog and removal/purge own blob lifetime", async () => {
  const { ExtensionRuntime } = await import("../../src/extensions/runtime.ts");
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blob-runtime-")), source = join(root, "source"); mkdirSync(source);
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "stage", version: "1.0.0", wolfpack: { manifestVersion: 1, apiVersion: 1, id: "stage", skills: [], documents: [], blobs: { maxBlobBytes: 64 } } }));
  const runtime = new ExtensionRuntime({ root: join(root, "runtime"), installationId }), store = new ExtensionBlobStore({ root: runtime.root });
  await runtime.install({ source, trustBrowserCode: true }); expect(runtime.catalog().installations[0]?.blobs).toEqual({ maxBlobBytes: 64 });
  const bytes = Buffer.from([0]), sha = digest(bytes); store.put(key, sha, bytes, 64); runtime.remove("stage"); expect(store.read(key, sha)).toEqual(bytes);
  await runtime.install({ source, trustBrowserCode: true }); expect(store.read(key, sha)).toEqual(bytes); expect(store.put(key, sha, bytes, 64).created).toBe(false);
  writeFileSync(join(runtime.root, "blobs", installationId, "stage", ".tmp-crash"), "partial");
  writeFileSync(join(runtime.root, "blobs", installationId, "stage", "stray"), "stray");
  runtime.purge("stage"); expect(store.read(key, sha)).toBeNull(); expect(runtime.catalog().installations).toEqual([]);
});
test("purge tolerates crash temporaries and stray entries", async () => {
  const { ExtensionRuntime } = await import("../../src/extensions/runtime.ts");
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blob-stray-")), source = join(root, "source"); mkdirSync(source);
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "stage", version: "1.0.0", wolfpack: { manifestVersion: 1, apiVersion: 1, id: "stage", skills: [], documents: [] } }));
  const runtime = new ExtensionRuntime({ root: join(root, "runtime"), installationId }); await runtime.install({ source, trustBrowserCode: true });
  const store = new ExtensionBlobStore({ root: runtime.root }), bytes = Buffer.from([4]); store.put(key, digest(bytes), bytes, 64);
  const dir = join(runtime.root, "blobs", installationId, "stage"); writeFileSync(join(dir, ".tmp-crash"), "bad"); mkdirSync(join(dir, "stray"));
  runtime.purge("stage"); expect(fs.existsSync(dir)).toBe(false); expect(runtime.catalog().installations).toEqual([]);
});
test("purge commits registry removal even when blob cleanup needs recovery", async () => {
  const { ExtensionRuntime } = await import("../../src/extensions/runtime.ts");
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blob-purge-")), source = join(root, "source"); mkdirSync(source);
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "stage", version: "1.0.0", wolfpack: { manifestVersion: 1, apiVersion: 1, id: "stage", skills: [], documents: [] } }));
  const runtime = new ExtensionRuntime({ root: join(root, "runtime"), installationId }); await runtime.install({ source, trustBrowserCode: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "stage", version: "1.0.1", wolfpack: { manifestVersion: 1, apiVersion: 1, id: "stage", skills: [], documents: [] } }));
  const { installation } = await runtime.install({ source, trustBrowserCode: true });
  const snapshots = [installation.snapshot, installation.previous!.snapshot];
  expect(snapshots[0]).not.toBe(snapshots[1]); for (const path of snapshots) expect(fs.existsSync(path)).toBe(true);
  const failure = new Error("disk failure"), cleanup = spyOn(ExtensionBlobStore.prototype, "remove").mockImplementation(() => { throw failure; }), diagnostic = spyOn(console, "warn").mockImplementation(() => {});
  try { runtime.purge("stage"); expect(runtime.catalog().installations).toEqual([]); expect(diagnostic).toHaveBeenCalled(); expect(diagnostic.mock.calls.flat()).toContain(failure); for (const path of snapshots) expect(fs.existsSync(path)).toBe(false); } finally { cleanup.mockRestore(); diagnostic.mockRestore(); }
});
test("corrupt blobs can be deleted without reading their contents", async () => {
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blob-delete-")), store = new ExtensionBlobStore({ root }), bytes = Buffer.from([5]), sha = digest(bytes);
  store.put(key, sha, bytes, 64); writeFileSync(join(root, "blobs", installationId, "stage", `${sha}.bin`), "bad"); expect(store.delete(key, sha)).toBe(true); expect(store.read(key, sha)).toBeNull();
});
test("blob writes fsync the actual private file before rename and directory after", async () => {
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blobs-durable-")), store = new ExtensionBlobStore({ root });
  const bytes = Buffer.from([7]), sha = digest(bytes), path = join(root, "blobs", installationId, "stage", `${sha}.bin`);
  const sync = fs.fsyncSync, events: string[] = [];
  const probe = spyOn(fs, "fsyncSync").mockImplementation(fd => {
    const stat = fs.fstatSync(fd);
    if (stat.isFile()) { expect(fs.existsSync(path)).toBe(false); expect(stat.mode & 0o777).toBe(0o600); events.push("file"); }
    else { expect(fs.readFileSync(path)).toEqual(bytes); events.push("directory"); }
    sync(fd);
  });
  try { store.put(key, sha, bytes, 64); expect(events).toEqual(["file", "directory"]); } finally { probe.mockRestore(); }
});
test.each(["file", "directory"] as const)("blob write reports %s fsync failure instead of acknowledging durability", async phase => {
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blobs-sync-failure-")), store = new ExtensionBlobStore({ root }), bytes = Buffer.from([2]), sha = digest(bytes);
  const sync = fs.fsyncSync;
  const failure = Object.assign(new Error("fsync failed"), { code: "EIO" });
  const probe = spyOn(fs, "fsyncSync").mockImplementation(fd => { if (fs.fstatSync(fd).isDirectory() === (phase === "directory")) throw failure; sync(fd); });
  try {
    let caught: unknown; try { store.put(key, sha, bytes, 64); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "STORE_UNAVAILABLE", cause: { code: "EIO" } }); expect((caught as Error).cause).toBe(failure);
  } finally { probe.mockRestore(); }
  expect(fs.readdirSync(join(root, "blobs", installationId, "stage")).some(name => name.includes(".tmp-"))).toBe(false);
});
test("blob write preserves the original ENOSPC write failure", async () => {
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blob-enospc-")), store = new ExtensionBlobStore({ root }), bytes = Buffer.from([9]);
  const failure = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  const probe = spyOn(fs, "writeFileSync").mockImplementation(() => { throw failure; });
  try {
    let caught: unknown; try { store.put(key, digest(bytes), bytes, 64); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "STORE_UNAVAILABLE", cause: { code: "ENOSPC" } }); expect((caught as Error).cause).toBe(failure);
  } finally { probe.mockRestore(); }
  expect(fs.readdirSync(join(root, "blobs", installationId, "stage"))).toEqual([]);
});
test.each(["unavailable", "restored"] as const)("new-store durability retry at full quota requires directory sync: %s", async state => {
  const restored = state === "restored";
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blob-sync-retry-")), store = new ExtensionBlobStore({ root });
  for (let n = 0; n < 63; n++) { const other = Buffer.from([n]); store.put(key, digest(other), other, 64); }
  const bytes = Buffer.from("durability retry"), sha = digest(bytes), dir = join(root, "blobs", installationId, "stage"), path = join(dir, `${sha}.bin`);
  const sync = fs.fsyncSync; let failDirectory = true, fileAttempts = 0, directoryAttempts = 0;
  const probe = spyOn(fs, "fsyncSync").mockImplementation(fd => {
    const stat = fs.fstatSync(fd);
    if (stat.isDirectory()) { directoryAttempts++; expect(fs.readFileSync(path)).toEqual(bytes); if (failDirectory) throw new Error("directory fsync unavailable"); }
    else { fileAttempts++; expect(stat.isFile()).toBe(true); expect(stat.mode & 0o777).toBe(0o600); }
    sync(fd);
  });
  try {
    expect(() => store.put(key, sha, bytes, 64)).toThrow("persisted"); expect(fs.readFileSync(path)).toEqual(bytes); expect(fs.readdirSync(dir)).toHaveLength(64);
    failDirectory = !restored;
    const retry = new ExtensionBlobStore({ root });
    if (restored) expect(retry.put(key, sha, bytes, 64)).toMatchObject({ created: false, bytes: bytes.length });
    else expect(() => retry.put(key, sha, bytes, 64)).toThrow("persisted");
    expect(fileAttempts).toBe(2); expect(directoryAttempts).toBe(2); expect(retry.read(key, sha)).toEqual(bytes);
    expect(fs.readdirSync(dir)).toHaveLength(64); expect(fs.readdirSync(dir).some(name => name.includes(".tmp-"))).toBe(false);
  } finally { probe.mockRestore(); }
});
test("corrupt regular blobs stay unreadable but can be repaired or deleted", async () => {
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blobs-repair-")), store = new ExtensionBlobStore({ root });
  const bytes = Buffer.from([7, 8]), sha = digest(bytes), path = join(root, "blobs", installationId, "stage", `${sha}.bin`);
  store.put(key, sha, bytes, 64);
  for (let n = 0; n < 63; n++) { const other = Buffer.from([n]); store.put(key, digest(other), other, 64); }
  writeFileSync(path, "bad");
  expect(() => store.read(key, sha)).toThrow("digest");
  expect(store.put(key, sha, bytes, 64).created).toBe(true); expect(store.read(key, sha)).toEqual(bytes);
  writeFileSync(path, "bad"); expect(store.delete(key, sha)).toBe(true); expect(store.read(key, sha)).toBeNull();
});
test("re-put repairs an oversized corrupt regular file without buffering it", async () => {
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blob-oversize-repair-")), store = new ExtensionBlobStore({ root }), bytes = Buffer.from([5]), sha = digest(bytes);
  store.put(key, sha, bytes, 64); writeFileSync(join(root, "blobs", installationId, "stage", `${sha}.bin`), Buffer.alloc(1048577));
  expect(() => store.read(key, sha)).toThrow(); expect(store.put(key, sha, bytes, 64).created).toBe(true); expect(store.read(key, sha)).toEqual(bytes);
});
test("digest file symlinks are refused without touching their target", async () => {
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blobs-link-")), store = new ExtensionBlobStore({ root });
  const bytes = Buffer.from([7]), sha = digest(bytes), path = join(root, "blobs", installationId, "stage", `${sha}.bin`), target = join(root, "target");
  store.put(key, sha, bytes, 64); rmSync(path); writeFileSync(target, bytes); symlinkSync(target, path);
  expect(() => store.read(key, sha)).toThrow(); expect(() => store.put(key, sha, bytes, 64)).toThrow(); expect(() => store.delete(key, sha)).toThrow(); expect(fs.readFileSync(target)).toEqual(bytes);
});
test("blob byte quota, owner isolation and links fail closed", async () => {
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blobs-")), store = new ExtensionBlobStore({ root });
  for (let n = 0; n < 16; n++) { const bytes = Buffer.alloc(1048576, n); store.put(key, digest(bytes), bytes, 1048576); }
  const bytes = Buffer.from([99]); expect(() => store.put(key, digest(bytes), bytes, 1048576)).toThrow("quota");
  expect(store.put({ ...key, extensionId: "other" }, digest(bytes), bytes, 64).created).toBe(true);
  expect(store.read(key, digest(bytes))).toBeNull();
  const linksRoot = mkdtempSync(join(tmpdir(), "blobs-links-")); symlinkSync(root, join(linksRoot, "blobs"));
  expect(() => new ExtensionBlobStore({ root: linksRoot }).read(key, digest(bytes))).toThrow("directory");
  expect(() => new ExtensionBlobStore({ root: linksRoot }).remove(key)).toThrow("directory");
});
test("blob quota never evicts and unexpected entries fail closed", async () => {
  const { ExtensionBlobStore } = await import("../../src/extensions/blob-store.ts");
  const root = mkdtempSync(join(tmpdir(), "blobs-")), store = new ExtensionBlobStore({ root });
  for (let n = 0; n < 64; n++) { const bytes = Buffer.from([n]); store.put(key, digest(bytes), bytes, 64); }
  const bytes = Buffer.from([64]); expect(() => store.put(key, digest(bytes), bytes, 64)).toThrow("quota");
  const dir = join(root, "blobs", installationId, "stage"); mkdirSync(join(dir, "unexpected"));
  expect(() => store.put(key, digest(bytes), bytes, 64)).toThrow("unexpected");
});
