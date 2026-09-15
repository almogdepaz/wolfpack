import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isCanonicalPackageVersion } from "./package-version.ts";
import { readBoundedRegularFile } from "./bounded-file.ts";
import { ArchiveEntryPolicy, readArchiveBytes, snapshotArchive, verifyArchiveBytes, type ArchiveReadOptions, type InspectedArchive } from "./archive-snapshot.ts";
import { ExtensionPackageError } from "./package-error.ts";
export { ExtensionPackageError } from "./package-error.ts";
export { PACKAGE_ARCHIVE_LIMITS, type ArchiveReadOptions, type InspectedArchive } from "./archive-snapshot.ts";

/** Exact versions only: tags and ranges make activation non-reproducible. */
export function parseExactNpmSpecifier(specifier: string): { readonly name: string; readonly version: string } {
  const match = typeof specifier === "string" && specifier.length <= 480
    ? /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(.+)$/.exec(specifier)
    : null;
  if (!match || match[1]!.length > 214 || !isCanonicalPackageVersion(match[2])) {
    throw new ExtensionPackageError("INVALID_NPM_SPECIFIER", "npm extension sources must use npm:<package>@<canonical-exact-semver>");
  }
  return { name: match[1]!, version: match[2]! };
}

/** Structural inspection only unless the caller also supplies expected registry SRI. */
export async function inspectNpmTarball(path: string, options: ArchiveReadOptions = {}): Promise<InspectedArchive> {
  return (await snapshotArchive(path, options)).summary;
}

export function verifyNpmIntegrity(path: string, integrity: string): void {
  verifyArchiveBytes(readArchiveBytes(path), integrity);
}

export interface ArchiveExtractOptions extends ArchiveReadOptions {
  /** Trusted synchronous host/test I/O, never package or HTTP-provided callbacks. */
  readonly operations?: {
    readonly writeFile?: (path: string, bytes: Uint8Array) => void;
    readonly removeTree?: (path: string) => void;
  };
}
function writePrivateArchiveFile(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
}

/**
 * Maintained tar.Parser decodes a single private snapshot into bounded regular
 * file bytes. Extraction rechecks that inventory, writes only those exact bytes
 * with exclusive private files, and never reopens the archive pathname. Registry
 * callers MUST forward NpmPackResult.integrity here; omission is for local input.
 */
export async function extractVerifiedNpmTarball(archive: string, destinationParent: string, options: ArchiveExtractOptions = {}): Promise<string> {
  const snapshot = await snapshotArchive(archive, options, true);
  const policy = new ArchiveEntryPolicy(snapshot.limits);
  for (const entry of snapshot.entries) {
    policy.add(entry.path, entry.type, entry.size);
    if (entry.type === "File" && (!entry.content || entry.content.length !== entry.size || createHash("sha256").update(entry.content).digest("hex") !== entry.digest)) {
      throw new ExtensionPackageError("UNSAFE_ARCHIVE", "extraction inventory differs from inspected bytes");
    }
  }
  let stage: string;
  try {
    if (typeof destinationParent !== "string" || !isAbsolute(destinationParent)) throw new Error("absolute parent required");
    mkdirSync(destinationParent, { recursive: true, mode: 0o700 });
    if (!lstatSync(destinationParent).isDirectory()) throw new Error("non-symlink directory required");
    stage = mkdtempSync(join(destinationParent, ".extension-stage-"));
  } catch { throw new ExtensionPackageError("UNSAFE_ARCHIVE", "could not create a private stage under a non-symlink extraction parent"); }
  try {
    const write = options.operations?.writeFile ?? writePrivateArchiveFile;
    for (const entry of snapshot.entries) {
      const path = join(stage, entry.path);
      if (entry.type === "Directory") mkdirSync(path, { recursive: true, mode: 0o700 });
      else {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        write(path, entry.content!);
        const actual = readBoundedRegularFile(path, entry.size);
        const stat = lstatSync(path);
        if (actual.length !== entry.size || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || createHash("sha256").update(actual).digest("hex") !== entry.digest) {
          throw new ExtensionPackageError("UNSAFE_ARCHIVE", "extracted file differs from the private inspected inventory");
        }
      }
    }
    return join(stage, "package");
  } catch {
    try {
      (options.operations?.removeTree ?? ((path: string) => rmSync(path, { recursive: true, force: true })))(stage);
      try { lstatSync(stage); throw new Error("private stage remains"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    } catch { throw new ExtensionPackageError("UNSAFE_ARCHIVE", "extraction failed and private staging cleanup requires attention", { cleanupDirectory: stage }); }
    throw new ExtensionPackageError("UNSAFE_ARCHIVE", "extraction failed; partial private stage removed");
  }
}

export interface NpmPackResult { readonly tarball: string; readonly integrity: string; }
/**
 * Npm is an explicit compiled-install prerequisite. `npm pack --ignore-scripts`
 * fetches an exact registry tarball without evaluating package lifecycle code;
 * callers still inspect/integrity-check before activation.
 */
export function fetchExactNpmPackage(specifier: string, stagingDirectory: string, execFile: typeof execFileSync = execFileSync): NpmPackResult {
  parseExactNpmSpecifier(specifier);
  try { execFile("npm", ["--version"], { stdio: "pipe" }); }
  catch { throw new ExtensionPackageError("NPM_UNAVAILABLE", "npm is required for npm extension installs; install a supported Node/npm runtime or use a local snapshot"); }
  try {
    const stdout = String(execFile("npm", ["pack", specifier, "--ignore-scripts", "--json", "--pack-destination", stagingDirectory], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    const output: unknown = JSON.parse(stdout);
    if (!Array.isArray(output) || output.length !== 1 || typeof output[0]?.filename !== "string") throw new Error("npm pack returned an invalid result");
    const entry = output[0] as { filename: string; integrity?: unknown };
    const tarball = resolve(stagingDirectory, basename(entry.filename));
    if (!tarball.startsWith(`${resolve(stagingDirectory)}/`)) throw new Error("npm pack returned an escaping filename");
    if (typeof entry.integrity !== "string") throw new ExtensionPackageError("INTEGRITY_MISMATCH", "npm registry response omitted required integrity");
    verifyNpmIntegrity(tarball, entry.integrity);
    return { tarball, integrity: entry.integrity };
  } catch (error) {
    if (error instanceof ExtensionPackageError) throw error;
    throw new ExtensionPackageError("NPM_FETCH_FAILED", "npm pack failed to produce a valid bounded package result");
  }
}

/** Test-only helper for isolated callers that want a private npm staging root. */
export function createNpmStagingDirectory(): string { return mkdtempSync(join(tmpdir(), "wolfpack-extension-npm-")); }
