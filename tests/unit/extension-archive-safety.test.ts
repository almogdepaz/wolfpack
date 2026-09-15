import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import * as security from "../../src/extensions/package-security.ts";

interface Options {
  integrity?: string;
  limits?: Record<string, number>;
  operations?: { writeFile?: (path: string, bytes: Uint8Array) => void; removeTree?: (path: string) => void };
}
const inspect = security.inspectNpmTarball as (path: string, options?: Options) => Promise<security.InspectedArchive>;
const extract = security.extractVerifiedNpmTarball as (path: string, destination: string, options?: Options) => Promise<string>;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "wolfpack-archive-safety-")); roots.push(root); return root; }
function entry(path: string, body = "", type: tar.Header["type"] = "File", overrides: { size?: number; mode?: number; linkpath?: string } = {}) {
  const bytes = Buffer.from(body);
  const header = new tar.Header({ path, type, size: bytes.length, mode: 0o7777, ...overrides });
  const needsPax = header.encode();
  const extended = needsPax ? new tar.Pax({ path }).encode() : Buffer.alloc(0);
  return Buffer.concat([extended, header.block!, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
function archive(root: string, entries: Buffer[], gzip = false, padding = 1024) {
  const path = join(root, "input.tar");
  const bytes = Buffer.concat([...entries, Buffer.alloc(padding)]);
  writeFileSync(path, gzip ? gzipSync(bytes) : bytes);
  return path;
}
const sri = (path: string) => `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
async function failure(action: Promise<unknown>) {
  try { await action; return undefined; } catch (error) { return error; }
}

describe("portable bounded immutable archives", () => {
  test.each([
    "package/CON.txt", "package/ref./x", "package/ref/COM1", "package/file.",
    "package/ref//x", "package/./x", "package/ref/../x", "package/a\\b",
    "package/é.md", "package/a b", "package/refs/" + "x".repeat(129),
    "package/" + "a/".repeat(9) + "x",
  ])("rejects nonportable paths: %s", async (path) => {
    const root = fixture();
    await expect(inspect(archive(root, [entry(path)]))).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    expect(existsSync(join(root, "out"))).toBe(false);
  });
  test.each([
    ["package/Refs/a", "package/refs/b"],
    ["package/item", "package/item/child"],
    ["package/item/child", "package/item"],
    ["package/a", "package/A"],
  ].map((paths) => ({ paths })))("rejects path/component aliases and file-directory conflicts: %j", async ({ paths }) => {
    const root = fixture();
    await expect(inspect(archive(root, paths.map((path) => entry(path))))).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });
  test.each(["SymbolicLink", "Link", "CharacterDevice", "FIFO"] as const)("refuses %s entries", async (type) => {
    const root = fixture();
    await expect(inspect(archive(root, [entry("package/item", "", type, { linkpath: "../../outside" })]))).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });
  test("refuses payload-bearing directories instead of ignoring their bodies", async () => {
    const root = fixture();
    await expect(inspect(archive(root, [entry("package/dir/", "hidden", "Directory")]))).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });
  test("accepts ordinary PAX metadata and explicit/implicit directory ordering", async () => {
    const root = fixture(); const source = join(root, "source");
    mkdirSync(join(source, "package", "refs"), { recursive: true });
    writeFileSync(join(source, "package", "refs", "notes.md"), "content");
    const path = join(root, "npm.tgz"); await tar.c({ cwd: source, gzip: true, file: path }, ["package"]);
    expect(await inspect(path)).toMatchObject({ files: 1, unpackedBytes: 7 });
    expect(await inspect(archive(root, [entry("package/refs/a", "a"), entry("package/refs/", "", "Directory")]))).toMatchObject({ files: 1 });
  });
  test("refuses oversized metadata rather than silently ignoring it", async () => {
    const root = fixture();
    await expect(inspect(archive(root, [entry("PaxHeader", "x".repeat(32 * 1024), "ExtendedHeader"), entry("package/a")]))).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });
  test("reads a no-follow regular-file snapshot with typed failures", async () => {
    const root = fixture(); const path = archive(root, [entry("package/a")]);
    const link = join(root, "link.tar"); symlinkSync(path, link);
    await expect(inspect(link)).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    await expect(inspect(join(root, "absent"))).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });
  test("stops decompression on entry quota instead of draining trailing expansion", async () => {
    const root = fixture();
    const path = archive(root, [entry("package/a"), entry("package/b"), entry("package/c")], true, 2 * 1024 * 1024);
    const error = await failure(inspect(path, { limits: { maxFiles: 1 } }));
    expect(error).toMatchObject({ code: "UNSAFE_ARCHIVE" });
    const details = (error as { inspection: { expandedBytes: number; entries: number } }).inspection;
    expect(details.expandedBytes).toBeLessThanOrEqual(32 * 1024);
    expect(details.entries).toBe(2);
  });
  test("stops expansion even when the tar parser has already seen EOF", async () => {
    const root = fixture(); const path = archive(root, [entry("package/a")], true, 2 * 1024 * 1024);
    const error = await failure(inspect(path, { limits: { maxExpandedBytes: 1024 } }));
    expect(error).toMatchObject({ code: "UNSAFE_ARCHIVE" });
    expect((error as { inspection: { expandedBytes: number } }).inspection.expandedBytes).toBeLessThanOrEqual(32 * 1024);
  });
  test("does not let nested gzip evade the external expansion counter", async () => {
    const root = fixture(); const path = archive(root, [entry("package/a")], true);
    writeFileSync(path, gzipSync(readFileSync(path)));
    await expect(inspect(path)).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });
  test.each([NaN, Infinity, -1, 0, security.PACKAGE_ARCHIVE_LIMITS.maxArchiveBytes + 1])("rejects invalid/enlarged limits: %s", async (maxArchiveBytes) => {
    const root = fixture(); const path = archive(root, [entry("package/a")]);
    await expect(inspect(path, { limits: { maxArchiveBytes } })).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });
  test("enforces declared payload and total entry budgets", async () => {
    const root = fixture();
    await expect(inspect(archive(root, [entry("package/a", "four")]), { limits: { maxUnpackedBytes: 3 } })).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    await expect(inspect(archive(root, [entry("package/a/", "", "Directory"), entry("package/b/", "", "Directory")]), { limits: { maxEntries: 1 } })).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });
  test("rejects truncated content and invalid compressed input", async () => {
    const root = fixture();
    await expect(inspect(archive(root, [entry("package/a", "", "File", { size: 4096 })], false, 0))).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    const path = archive(root, [entry("package/a")], true); const bytes = readFileSync(path); bytes[bytes.length - 5] = bytes[bytes.length - 5]! ^ 1; writeFileSync(path, bytes);
    await expect(inspect(path)).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });
  test("uses the exact verified snapshot even if the pathname is replaced during inspection", async () => {
    const root = fixture(); const path = archive(root, [entry("package/a", "original")], true);
    const pending = extract(path, join(root, "out"), { integrity: sri(path) });
    archive(root, [entry("package/a", "replacement")], true);
    const result = await pending;
    expect(readFileSync(join(result, "a"), "utf8")).toBe("original");
  });
  test("binds extraction to supplied registry SRI before any stage writes", async () => {
    const root = fixture(); const path = archive(root, [entry("package/a", "first")]); const integrity = sri(path);
    archive(root, [entry("package/a", "other")]);
    await expect(extract(path, join(root, "out"), { integrity })).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
    expect(existsSync(join(root, "out"))).toBe(false);
  });
  test("rejects noncanonical SRI encoding even if its decoded bytes match", () => {
    const root = fixture(); const path = archive(root, [entry("package/a")]);
    const encoded = createHash("sha256").update(readFileSync(path)).digest("base64");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const alias = encoded.slice(0, -2) + alphabet[alphabet.indexOf(encoded.at(-2)!) + 1] + "=";
    expect(() => security.verifyNpmIntegrity(path, `sha256-${alias}`)).toThrow(security.ExtensionPackageError);
  });
  test("extracts private regular bytes without honoring archive permissions", async () => {
    const root = fixture(); const path = archive(root, [entry("package/refs/a", "private")], true);
    const result = await extract(path, join(root, "out"));
    expect(readFileSync(join(result, "refs", "a"), "utf8")).toBe("private");
    expect(lstatSync(join(result, "refs", "a")).mode & 0o7777).toBe(0o600);
    expect(lstatSync(join(result, "refs")).mode & 0o777).toBe(0o700);
  });
  test("rejects a symlink extraction parent without changing its target", async () => {
    const root = fixture(); const outside = join(root, "outside"); mkdirSync(outside); symlinkSync(outside, join(root, "out"));
    await expect(extract(archive(root, [entry("package/a")]), join(root, "out"))).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    expect(readdirSync(outside)).toEqual([]);
  });
  test("cleans a partial private stage after an injected write failure", async () => {
    const root = fixture(); const out = join(root, "out"); mkdirSync(out); writeFileSync(join(out, "sentinel"), "user"); let writes = 0;
    await expect(extract(archive(root, [entry("package/a"), entry("package/b")]), out, { operations: { writeFile(path, bytes) {
      writes++; if (writes === 2) throw new Error("injected write failure"); writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
    } } })).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    expect(writes).toBe(2); expect(readdirSync(out)).toEqual(["sentinel"]);
  });
  test("refuses a writer that silently persists different bytes", async () => {
    const root = fixture(); const out = join(root, "out");
    await expect(extract(archive(root, [entry("package/a", "safe")]), out, { operations: {
      writeFile(path) { writeFileSync(path, "evil", { flag: "wx", mode: 0o600 }); },
    } })).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    expect(readdirSync(out)).toEqual([]);
  });
  test("does not claim cleanup if a remover silently leaves the private stage", async () => {
    const root = fixture();
    const error = await failure(extract(archive(root, [entry("package/a")]), join(root, "out"), { operations: {
      writeFile() { throw new Error("write failed"); }, removeTree() {},
    } }));
    expect(error).toMatchObject({ code: "UNSAFE_ARCHIVE" });
    const directory = (error as { cleanupDirectory: string }).cleanupDirectory;
    expect(typeof directory).toBe("string"); expect(existsSync(directory)).toBe(true);
  });
  test("reports a retained stage when failure cleanup cannot finish", async () => {
    const root = fixture();
    const error = await failure(extract(archive(root, [entry("package/a")]), join(root, "out"), { operations: {
      writeFile() { throw new Error("write failed"); }, removeTree() { throw new Error("cleanup failed"); },
    } }));
    expect(error).toMatchObject({ code: "UNSAFE_ARCHIVE" });
    const directory = (error as { cleanupDirectory: string }).cleanupDirectory;
    expect(typeof directory).toBe("string"); expect(existsSync(directory)).toBe(true);
  });
});
