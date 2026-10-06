import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isPlainJsonObject } from "./bounded-json.ts";
import { PACKAGE_ARCHIVE_LIMITS } from "./archive-snapshot.ts";
import { ExtensionPackageError } from "./package-error.ts";

export const PACKAGE_ACQUISITION_LIMITS = {
  timeoutMs: 30_000,
  maxMetadataBytes: 256 * 1024,
  maxArchiveBytes: PACKAGE_ARCHIVE_LIMITS.maxArchiveBytes,
} as const;
export interface NpmPackResult { readonly tarball: string; readonly integrity: string; }
export interface PackageAcquisitionOptions {
  /** Anonymous registry root; HTTPS, or loopback HTTP for isolated local fixtures. */
  readonly registryUrl?: string;
  readonly timeoutMs?: number;
  readonly maxMetadataBytes?: number;
  readonly maxArchiveBytes?: number;
  /** Trusted host/test transport and synchronous I/O, never package callbacks. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly operations?: {
    readonly write?: (fd: number, bytes: Uint8Array) => number;
    readonly removeTree?: (path: string) => void;
  };
}
const failed = (message: string) => new ExtensionPackageError("NPM_FETCH_FAILED", message);
const timedOut = () => new ExtensionPackageError("NPM_FETCH_TIMEOUT", "package acquisition deadline exceeded");
function reduced(value: unknown, maximum: number): number {
  if (value === undefined) return maximum;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw failed("acquisition limits may only reduce positive hard bounds");
  return value;
}
function registryRoot(value: string): URL {
  try {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    return url;
  } catch { throw failed("registry must be an anonymous HTTPS origin, or explicit loopback HTTP fixture"); }
}
function cancel(stream: ReadableStream<Uint8Array> | null): void {
  try { void stream?.cancel().catch(() => {}); } catch { /* best-effort, never wait for a hostile transport */ }
}
function privateStage(parent: string): string {
  try {
    if (typeof parent !== "string" || !isAbsolute(parent)) throw new Error();
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
    return mkdtempSync(join(parent, ".npm-download-"));
  } catch { throw failed("acquisition requires an existing owner-private 0700 non-symlink staging directory"); }
}
function assertRemoved(path: string): void {
  try { lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("stage remains");
}

/**
 * Internal transport for an already parsed exact npm identity. No subprocess,
 * npmrc, cache, package manager, or lifecycle script is involved. The only disk
 * acquisition is one capped file in a fresh private child of the supplied root.
 */
export async function acquireRegistryPackage(
  identity: { readonly name: string; readonly version: string },
  stagingDirectory: string,
  options: PackageAcquisitionOptions = {},
): Promise<NpmPackResult> {
  if (!isPlainJsonObject(options as unknown)) throw failed("invalid package acquisition options");
  const timeoutMs = reduced(options.timeoutMs, PACKAGE_ACQUISITION_LIMITS.timeoutMs);
  const metadataLimit = reduced(options.maxMetadataBytes, PACKAGE_ACQUISITION_LIMITS.maxMetadataBytes);
  const archiveLimit = reduced(options.maxArchiveBytes, PACKAGE_ACQUISITION_LIMITS.maxArchiveBytes);
  const registry = registryRoot(options.registryUrl ?? "https://registry.npmjs.org/");
  const fetcher = options.fetch ?? ((url: string, init: RequestInit) => globalThis.fetch(url, init));
  const write = options.operations?.write ?? ((fd: number, bytes: Uint8Array) => writeSync(fd, bytes));
  const remove = options.operations?.removeTree ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const stage = privateStage(stagingDirectory);
  const controller = new AbortController();
  const expiresAt = performance.now() + timeoutMs;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  void deadline.catch(() => {});
  const timer = setTimeout(() => { rejectDeadline(timedOut()); controller.abort(); }, timeoutMs);
  // Every await uses this same deadline. Also check elapsed time around sync I/O.
  function checkDeadline() { if (controller.signal.aborted || performance.now() >= expiresAt) throw timedOut(); }
  async function within<T>(promise: Promise<T>): Promise<T> {
    void promise.catch(() => {});
    checkDeadline();
    const value = await Promise.race([promise, deadline]);
    checkDeadline();
    return value;
  }
  async function request(url: URL): Promise<Response> {
    const pending = Promise.resolve().then(() => {
      checkDeadline();
      return fetcher(url.href, { signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store" });
    }).then((response) => {
      if (controller.signal.aborted || performance.now() >= expiresAt) cancel(response.body);
      return response;
    });
    const response = await within(pending);
    if (!response.ok || response.redirected) { cancel(response.body); throw failed("registry request failed or redirected"); }
    return response;
  }
  async function consume(response: Response, limit: number, accept: (bytes: Uint8Array) => void): Promise<number> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    try {
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > limit)) throw failed("registry response exceeds byte limit");
      if (!response.body) throw failed("registry response has no body");
      reader = response.body.getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await within(reader.read());
        if (done) { complete = true; return total; }
        if (!(value instanceof Uint8Array) || value.byteLength > limit - total) throw failed("registry response exceeds byte limit");
        // Refuse BEFORE writing the chunk, not after filling staging disk.
        accept(value);
        total += value.byteLength;
      }
    } finally {
      if (!complete) {
        if (reader) { try { void reader.cancel().catch(() => {}); } catch {} }
        else cancel(response.body);
      }
      try { reader?.releaseLock(); } catch {}
    }
  }
  let fd: number | undefined;
  try {
    const metadataUrl = new URL(`${encodeURIComponent(identity.name)}/${encodeURIComponent(identity.version)}`, registry);
    const metadataResponse = await request(metadataUrl);
    const buffer = Buffer.alloc(metadataLimit);
    let length = 0;
    await consume(metadataResponse, metadataLimit, (chunk) => { buffer.set(chunk, length); length += chunk.length; });
    const metadata: unknown = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (!isPlainJsonObject(metadata) || metadata.name !== identity.name || metadata.version !== identity.version || !isPlainJsonObject(metadata.dist)) throw failed("registry metadata does not match the requested exact package");
    const integrity = metadata.dist.integrity;
    const match = typeof integrity === "string" && integrity.length <= 100 ? /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity) : null;
    if (!match) throw new ExtensionPackageError("INTEGRITY_MISMATCH", "registry must supply sha512 or sha256 SRI");
    const expected = Buffer.from(match[2]!, "base64");
    if (expected.toString("base64") !== match[2] || expected.length !== (match[1] === "sha512" ? 64 : 32)) throw new ExtensionPackageError("INTEGRITY_MISMATCH", "registry SRI is not canonical");
    if (typeof metadata.dist.tarball !== "string" || metadata.dist.tarball.length > 2048) throw failed("registry tarball URL is invalid");
    const tarballUrl = new URL(metadata.dist.tarball);
    if (tarballUrl.origin !== registry.origin || tarballUrl.username || tarballUrl.password || tarballUrl.search || tarballUrl.hash) throw failed("tarball must remain on the anonymous registry origin");
    const tarball = join(stage, "package.tgz");
    fd = openSync(tarball, "wx", 0o600);
    const hash = createHash(match[1]);
    await consume(await request(tarballUrl), archiveLimit, (chunk) => {
      let offset = 0;
      while (offset < chunk.byteLength) {
        checkDeadline();
        const count = write(fd!, chunk.subarray(offset));
        if (!Number.isSafeInteger(count) || count <= 0 || count > chunk.byteLength - offset) throw failed("package file write failed");
        offset += count;
      }
      hash.update(chunk);
    });
    if (hash.digest("base64") !== match[2]) throw new ExtensionPackageError("INTEGRITY_MISMATCH", "downloaded package does not match registry integrity");
    checkDeadline(); fsyncSync(fd); closeSync(fd); fd = undefined; checkDeadline();
    return { tarball, integrity: integrity as string };
  } catch (error) {
    controller.abort();
    if (fd !== undefined) { try { closeSync(fd); } catch {} fd = undefined; }
    try { remove(stage); assertRemoved(stage); }
    catch { throw new ExtensionPackageError("NPM_FETCH_FAILED", "acquisition failed; private stage requires cleanup", { cleanupDirectory: stage }); }
    if (error instanceof ExtensionPackageError) throw error;
    throw failed("registry package acquisition failed");
  } finally {
    clearTimeout(timer); controller.abort();
  }
}
