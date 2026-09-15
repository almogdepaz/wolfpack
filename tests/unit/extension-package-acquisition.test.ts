import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchExactNpmPackage } from "../../src/extensions/package-security.ts";

type Options = {
  registryUrl?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  maxMetadataBytes?: number;
  maxArchiveBytes?: number;
  operations?: { write?: (fd: number, bytes: Uint8Array) => number; removeTree?: (path: string) => void };
};
const acquire = (root: string, options: Options) => Promise.resolve().then(() => (fetchExactNpmPackage as unknown as (specifier: string, root: string, options: Options) => Promise<{ tarball: string; integrity: string }>)("npm:example@1.2.3", root, options));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "wolfpack-acquisition-")); roots.push(root); return root; }
const registryUrl = "http://127.0.0.1:19876/";
const bytes = Buffer.from("bounded tarball fixture");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
function metadata(dist: unknown = { tarball: `${registryUrl}example.tgz`, integrity }) { return Response.json({ name: "example", version: "1.2.3", dist }); }
function transport(archive: () => Response = () => new Response(bytes)): Options["fetch"] {
  return async (url) => url.endsWith("/example/1.2.3") ? metadata() : archive();
}
const never = () => new Promise<never>(() => {});
async function tick() { await new Promise((resolve) => setTimeout(resolve, 0)); }

describe("bounded registry acquisition without external npm", () => {
  test("fetches an exact SRI-verified tarball into a unique private stage", async () => {
    const root = fixture(); const requests: string[] = [];
    const result = await acquire(root, { registryUrl, fetch: async (url, init) => {
      requests.push(url); expect(init.redirect).toBe("error"); expect(init.credentials).toBe("omit"); expect(init.signal).toBeInstanceOf(AbortSignal);
      return requests.length === 1 ? metadata() : new Response(bytes);
    } });
    expect(requests).toEqual([`${registryUrl}example/1.2.3`, `${registryUrl}example.tgz`]);
    expect(readFileSync(result.tarball)).toEqual(bytes); expect(result.integrity).toBe(integrity);
    expect(lstatSync(result.tarball).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(result.tarball, "..")).mode & 0o777).toBe(0o700);
  });
  test("caps chunked disk writes before accepting the offending chunk and preserves unrelated files", async () => {
    const root = fixture(); writeFileSync(join(root, "sentinel"), "user"); let written = 0; let cancelled = false;
    const stream = () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(4));
    }, cancel() { cancelled = true; } }));
    await expect(acquire(root, { registryUrl, fetch: transport(stream), maxArchiveBytes: 5, operations: {
      write(fd, chunk) { written += chunk.byteLength; return writeSync(fd, chunk); },
    } })).rejects.toMatchObject({ code: "NPM_FETCH_FAILED" });
    expect(written).toBe(4); expect(cancelled).toBe(true); expect(readdirSync(root)).toEqual(["sentinel"]);
  });
  test("rejects oversized declared length before writing the body", async () => {
    const root = fixture(); let writes = 0;
    await expect(acquire(root, { registryUrl, fetch: transport(() => new Response(bytes, { headers: { "content-length": "999" } })), maxArchiveBytes: 32,
      operations: { write() { writes++; return 1; } },
    })).rejects.toMatchObject({ code: "NPM_FETCH_FAILED" });
    expect(writes).toBe(0); expect(readdirSync(root)).toEqual([]);
  });
  test("metadata is bounded too, before a tarball request", async () => {
    const root = fixture(); let requests = 0;
    await expect(acquire(root, { registryUrl, maxMetadataBytes: 16, fetch: async () => { requests++; return metadata(); } })).rejects.toMatchObject({ code: "NPM_FETCH_FAILED" });
    expect(requests).toBe(1); expect(readdirSync(root)).toEqual([]);
  });
  test.each(["metadata headers", "metadata body", "archive headers", "archive body"])("one deadline covers stalled %s and cleanup", async (point) => {
    const root = fixture(); let signal: AbortSignal | undefined; let cancels = 0;
    const stalled = () => new Response(new ReadableStream({ cancel() { cancels++; return never(); } }));
    await expect(acquire(root, { registryUrl, timeoutMs: 15, fetch: async (url, init) => {
      signal = init.signal!;
      if (url.endsWith("/example/1.2.3")) return point === "metadata headers" ? never() : point === "metadata body" ? stalled() : metadata();
      return point === "archive headers" ? never() : stalled();
    } })).rejects.toMatchObject({ code: "NPM_FETCH_TIMEOUT" });
    expect(signal?.aborted).toBe(true); expect(readdirSync(root)).toEqual([]);
    if (point.endsWith("body")) expect(cancels).toBe(1);
  });
  test("cancels a response arriving after the deadline without writing it", async () => {
    const root = fixture(); let finish!: (response: Response) => void; let cancelled = false;
    const pending = acquire(root, { registryUrl, timeoutMs: 15, fetch: () => new Promise((resolve) => { finish = resolve; }) });
    await expect(pending).rejects.toMatchObject({ code: "NPM_FETCH_TIMEOUT" });
    finish(new Response(new ReadableStream({ cancel() { cancelled = true; } }))); await tick();
    expect(cancelled).toBe(true); expect(readdirSync(root)).toEqual([]);
  });
  test.each([0, -1, Infinity, 30_001])("cannot enlarge or invalidate the deadline: %s", async (timeoutMs) => {
    const root = fixture(); let requests = 0;
    await expect(acquire(root, { registryUrl, timeoutMs, fetch: async () => { requests++; return metadata(); } })).rejects.toMatchObject({ code: "NPM_FETCH_FAILED" });
    expect(requests).toBe(0); expect(readdirSync(root)).toEqual([]);
  });
  test("cannot enlarge either byte cap", async () => {
    const root = fixture(); const fetch = async () => { throw new Error("must not fetch"); };
    await expect(acquire(root, { registryUrl, fetch, maxArchiveBytes: 32 * 1024 * 1024 + 1 })).rejects.toMatchObject({ code: "NPM_FETCH_FAILED" });
    await expect(acquire(root, { registryUrl, fetch, maxMetadataBytes: 256 * 1024 + 1 })).rejects.toMatchObject({ code: "NPM_FETCH_FAILED" });
    expect(readdirSync(root)).toEqual([]);
  });
  test("requires matching package identity and same-registry tarball authority", async () => {
    const root = fixture(); let requests = 0;
    const fetch = async () => { requests++; return Response.json({ name: "other", version: "1.2.3", dist: { tarball: `${registryUrl}example.tgz`, integrity } }); };
    await expect(acquire(root, { registryUrl, fetch })).rejects.toMatchObject({ code: "NPM_FETCH_FAILED" });
    await expect(acquire(root, { registryUrl, fetch: async () => { requests++; return metadata({ tarball: "https://other.invalid/a", integrity }); } })).rejects.toMatchObject({ code: "NPM_FETCH_FAILED" });
    expect(requests).toBe(2); expect(readdirSync(root)).toEqual([]);
  });
  test("missing or mismatched SRI stays actionable and cleans the stage", async () => {
    const root = fixture();
    await expect(acquire(root, { registryUrl, fetch: async () => metadata({ tarball: `${registryUrl}example.tgz` }) })).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
    await expect(acquire(root, { registryUrl, fetch: transport(() => new Response("wrong bytes")) })).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
    expect(readdirSync(root)).toEqual([]);
  });
  test("cleans partial data on stream and disk failures", async () => {
    const root = fixture();
    await expect(acquire(root, { registryUrl, fetch: transport(), operations: { write() { throw new Error("disk full"); } } })).rejects.toMatchObject({ code: "NPM_FETCH_FAILED" });
    await expect(acquire(root, { registryUrl, fetch: transport(() => new Response(new ReadableStream({ start(controller) { controller.error(new Error("disconnected")); } }))) })).rejects.toMatchObject({ code: "NPM_FETCH_FAILED" });
    expect(readdirSync(root)).toEqual([]);
  });
  test("requires an existing owner-private non-symlink staging root before network", async () => {
    const root = fixture(); let requests = 0; const fetch = async () => { requests++; return metadata(); };
    chmodSync(root, 0o755);
    await expect(acquire(root, { registryUrl, fetch })).rejects.toMatchObject({ code: "NPM_FETCH_FAILED" });
    chmodSync(root, 0o700); const link = join(fixture(), "link"); symlinkSync(root, link);
    await expect(acquire(link, { registryUrl, fetch })).rejects.toMatchObject({ code: "NPM_FETCH_FAILED" });
    expect(requests).toBe(0);
  });
  test("reports the owned directory if failed-download cleanup cannot complete", async () => {
    const root = fixture(); let error: unknown;
    try { await acquire(root, { registryUrl, fetch: transport(), operations: {
      write() { throw new Error("disk failure"); }, removeTree() { throw new Error("cleanup failure"); },
    } }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "NPM_FETCH_FAILED" });
    const directory = (error as { cleanupDirectory: string }).cleanupDirectory;
    expect(typeof directory).toBe("string"); expect(existsSync(directory)).toBe(true);
  });
});
