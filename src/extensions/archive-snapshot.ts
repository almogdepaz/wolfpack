import { createHash, timingSafeEqual } from "node:crypto";
import { Readable, type TransformOptions } from "node:stream";
import { createGunzip, type ZlibOptions } from "node:zlib";
import * as tar from "tar";
import { readBoundedRegularFile } from "./bounded-file.ts";
import { isPlainJsonObject } from "./bounded-json.ts";
import { assertPortablePackagePath } from "./portable-path.ts";
import { ExtensionPackageError } from "./package-error.ts";

export const PACKAGE_ARCHIVE_LIMITS = {
  maxArchiveBytes: 32 * 1024 * 1024,
  maxUnpackedBytes: 128 * 1024 * 1024,
  maxExpandedBytes: 128 * 1024 * 1024,
  maxFiles: 4_000,
  maxEntries: 8_000,
  maxMetaEntryBytes: 16 * 1024,
  maxMetadataBytes: 64 * 1024,
  maxInspectionMs: 5_000,
} as const;
type Limits = { readonly [K in keyof typeof PACKAGE_ARCHIVE_LIMITS]: number };
export interface ArchiveReadOptions {
  readonly integrity?: string;
  readonly limits?: Partial<Limits>;
}
export interface InspectedArchive { readonly files: number; readonly unpackedBytes: number; }
export interface ArchiveEntrySnapshot {
  readonly path: string;
  readonly type: "File" | "Directory";
  readonly size: number;
  readonly content?: Buffer<ArrayBuffer>;
  readonly digest?: string;
}
export interface ArchiveSnapshot {
  readonly summary: InspectedArchive;
  readonly entries: readonly ArchiveEntrySnapshot[];
  readonly limits: Limits;
}
const CHUNK_BYTES = 16 * 1024;
const unsafe = (message: string) => new ExtensionPackageError("UNSAFE_ARCHIVE", message);

function resolveLimits(options: ArchiveReadOptions): Limits {
  if (!isPlainJsonObject(options) || (options.limits !== undefined && !isPlainJsonObject(options.limits))) throw unsafe("invalid archive options");
  const result = { ...PACKAGE_ARCHIVE_LIMITS } as { -readonly [K in keyof Limits]: number };
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (!Object.hasOwn(result, key)) throw unsafe("unknown archive limit");
    const name = key as keyof Limits;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > PACKAGE_ARCHIVE_LIMITS[name]) throw unsafe("archive limits may only reduce positive hard bounds");
    result[name] = value;
  }
  return Object.freeze(result);
}

export function verifyArchiveBytes(bytes: Uint8Array, integrity: string): void {
  const match = typeof integrity === "string" && integrity.length <= 100 ? /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity) : null;
  if (!match) throw new ExtensionPackageError("INTEGRITY_MISMATCH", "package integrity must be canonical sha512 or sha256 SRI");
  const expected = Buffer.from(match[2]!, "base64");
  const actual = createHash(match[1]).update(bytes).digest();
  if (expected.toString("base64") !== match[2] || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ExtensionPackageError("INTEGRITY_MISMATCH", "package snapshot does not match canonical registry integrity");
  }
}
export function readArchiveBytes(path: string, maximumBytes = PACKAGE_ARCHIVE_LIMITS.maxArchiveBytes): Buffer<ArrayBuffer> {
  try { return readBoundedRegularFile(path, maximumBytes); }
  catch { throw unsafe("package archive must be a bounded regular no-follow file"); }
}

/** A second fresh instance is used before filesystem extraction. */
export class ArchiveEntryPolicy {
  files = 0;
  unpackedBytes = 0;
  entries = 0;
  private readonly paths = new Map<string, { path: string; type: "File" | "Directory"; explicit: boolean }>();
  constructor(private readonly limits: Limits) {}
  add(rawPath: string, type: string, size: number, linkpath = ""): string {
    if (++this.entries > this.limits.maxEntries) throw unsafe("archive exceeds entry count limit");
    if (type !== "File" && type !== "Directory") throw unsafe("archive contains a non-regular entry");
    if (!Number.isSafeInteger(size) || size < 0 || (type === "Directory" && size !== 0) || linkpath) throw unsafe("archive entry has invalid size or link metadata");
    if (typeof rawPath !== "string") throw unsafe("archive entry lacks a path");
    const path = type === "Directory" && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
    if (path !== "package" && !path.startsWith("package/")) throw unsafe("archive entries must remain under package/");
    if (path === "package") {
      if (type !== "Directory") throw unsafe("package root must be a directory");
    } else assertPortablePackagePath(path.slice("package/".length));
    const parts = path.split("/");
    for (let length = 1; length <= parts.length; length++) {
      const current = parts.slice(0, length).join("/");
      const key = current.toLowerCase();
      const leaf = length === parts.length;
      const nextType = leaf ? type : "Directory";
      const old = this.paths.get(key);
      if (old && (old.path !== current || old.type !== nextType || (leaf && old.explicit))) throw unsafe("archive contains aliases, duplicates or file/directory conflicts");
      this.paths.set(key, { path: current, type: nextType, explicit: leaf || old?.explicit === true });
      if (this.paths.size > this.limits.maxEntries) throw unsafe("archive exceeds directory inventory limit");
    }
    if (type === "File") {
      this.files++;
      this.unpackedBytes += size;
      if (this.files > this.limits.maxFiles || this.unpackedBytes > Math.min(this.limits.maxUnpackedBytes, this.limits.maxExpandedBytes)) throw unsafe("archive exceeds file or payload byte limit");
    }
    return path;
  }
  metadata(): void { if (++this.entries > this.limits.maxEntries) throw unsafe("archive exceeds metadata/entry count limit"); }
}

/**
 * Capture bytes before the first await. Decompress outside tar's auto-unzip path
 * so bytes after EOF, metadata, padding and nested compression cannot evade the
 * expanded-byte cap. Maintained tar.Parser alone decodes headers/PAX/file data.
 * No archive pathname is reopened after this snapshot, including for extraction.
 */
export async function snapshotArchive(path: string, options: ArchiveReadOptions = {}, collect = false): Promise<ArchiveSnapshot> {
  const limits = resolveLimits(options);
  const bytes = readArchiveBytes(path, limits.maxArchiveBytes);
  if (options.integrity !== undefined) verifyArchiveBytes(bytes, options.integrity);
  const policy = new ArchiveEntryPolicy(limits);
  const entries: ArchiveEntrySnapshot[] = [];
  const pending = new WeakMap<tar.ReadEntry, { path: string; type: "File" | "Directory"; size: number }>();
  let expandedBytes = 0;
  let metadataBytes = 0;
  let failure: ExtensionPackageError | undefined;
  let finished!: () => void;
  const completion = new Promise<void>((resolve) => { finished = resolve; });
  function* chunks() { for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) yield bytes.subarray(offset, offset + CHUNK_BYTES); }
  const source = Readable.from(chunks(), { objectMode: false, highWaterMark: CHUNK_BYTES });
  const unzipOptions: ZlibOptions & TransformOptions = { chunkSize: CHUNK_BYTES, highWaterMark: CHUNK_BYTES };
  const expanded = bytes[0] === 0x1f && bytes[1] === 0x8b ? source.pipe(createGunzip(unzipOptions)) : source;
  const abort = (error: unknown) => {
    if (failure) return;
    failure = new ExtensionPackageError("UNSAFE_ARCHIVE", error instanceof ExtensionPackageError ? error.message : "archive parser rejected unsafe or malformed data", { inspection: { expandedBytes, entries: policy.entries } });
    parser.abort(failure);
  };
  const parser = new tar.Parser({
    strict: true,
    brotli: false,
    maxMetaEntrySize: limits.maxMetaEntryBytes,
    filter(_path, value) {
      const entry = value as tar.ReadEntry;
      try {
        const canonical = policy.add(entry.path, entry.type, entry.size, entry.linkpath);
        pending.set(entry, { path: canonical, type: entry.type as "File" | "Directory", size: entry.size });
        return true;
      } catch (error) { abort(error); return false; }
    },
    onReadEntry(entry) {
      const record = pending.get(entry);
      if (!record || failure) { entry.resume(); return; }
      const content = collect && record.type === "File" ? Buffer.alloc(record.size) : undefined;
      let length = 0;
      entry.on("end", () => {
        if (failure) return;
        if (length !== record.size) { abort(unsafe("archive payload was truncated")); return; }
        entries.push(Object.freeze({ ...record, ...(content ? { content, digest: createHash("sha256").update(content).digest("hex") } : {}) }));
      });
      entry.on("data", (chunk: Buffer) => {
        if (failure) return;
        if (length + chunk.length > record.size) { abort(unsafe("archive payload exceeds its declared size")); return; }
        content?.set(chunk, length);
        length += chunk.length;
      });
      entry.resume();
    },
  });
  parser.on("error", (error) => {
    failure ??= new ExtensionPackageError("UNSAFE_ARCHIVE", "archive parser rejected malformed data", { inspection: { expandedBytes, entries: policy.entries } });
    expanded.destroy(); source.destroy(); finished();
  });
  parser.once("end", finished);
  parser.on("ignoredEntry", () => abort(unsafe("archive contains unsupported or oversized metadata/entries")));
  parser.on("meta", (value: string) => {
    if (failure) return;
    try {
      policy.metadata(); metadataBytes += Buffer.byteLength(value, "utf8");
      if (metadataBytes > limits.maxMetadataBytes) throw unsafe("archive exceeds metadata byte limit");
    } catch (error) { abort(error); }
  });
  expanded.on("error", () => abort(unsafe("archive decompression failed")));
  const deadline = setTimeout(() => abort(unsafe("archive inspection deadline exceeded")), limits.maxInspectionMs);
  let prefix = Buffer.alloc(0);
  let checkedPrefix = false;
  try {
    for await (const value of expanded) {
      let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      expandedBytes += chunk.length;
      if (expandedBytes > limits.maxExpandedBytes) { abort(unsafe("archive exceeds expanded tar byte limit")); break; }
      if (!checkedPrefix) {
        if (prefix.length) chunk = Buffer.concat([prefix, chunk]);
        if (chunk.length < 2) { prefix = Buffer.from(chunk); continue; }
        if (chunk[0] === 0x1f && chunk[1] === 0x8b) { abort(unsafe("nested archive compression is not supported")); break; }
        checkedPrefix = true;
      }
      parser.write(chunk);
      if (failure) break;
    }
    if (!failure) {
      if (checkedPrefix) parser.end(); else parser.end(prefix);
      await completion;
    }
    if (failure) throw failure;
    if (entries.length === 0) throw unsafe("archive contains no regular package entries");
    return { summary: Object.freeze({ files: policy.files, unpackedBytes: policy.unpackedBytes }), entries: Object.freeze(entries), limits };
  } catch (error) {
    if (failure) throw failure;
    abort(error);
    throw failure;
  } finally {
    clearTimeout(deadline); expanded.destroy(); source.destroy();
  }
}
