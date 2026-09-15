import { execFileSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as tar from "tar";
import { valid as validSemver } from "semver";

export const PACKAGE_ARCHIVE_LIMITS = {
  maxArchiveBytes: 32 * 1024 * 1024,
  maxUnpackedBytes: 128 * 1024 * 1024,
  maxFiles: 4_000,
} as const;

export class ExtensionPackageError extends Error {
  constructor(readonly code: "INVALID_NPM_SPECIFIER" | "NPM_UNAVAILABLE" | "NPM_FETCH_FAILED" | "INTEGRITY_MISMATCH" | "UNSAFE_ARCHIVE", message: string) {
    super(message);
    this.name = "ExtensionPackageError";
  }
}

/** Exact versions only: tags and ranges make activation non-reproducible. */
export function parseExactNpmSpecifier(specifier: string): { readonly name: string; readonly version: string } {
  const match = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(.+)$/.exec(specifier);
  if (!match || !validSemver(match[2]!)) throw new ExtensionPackageError("INVALID_NPM_SPECIFIER", "npm extension sources must use npm:<package>@<exact-semver>");
  return { name: match[1]!, version: match[2]! };
}

function safeArchivePath(path: string): boolean {
  const parts = path.split("/");
  return path === "package/" || (path.startsWith("package/") && !path.includes("\\") && !path.includes("\0")
    && !parts.slice(0, -1).some((part) => part === "" || part === "." || part === "..")
    && ![".", ".."].includes(parts.at(-1) ?? ""));
}

export interface InspectedArchive { readonly files: number; readonly unpackedBytes: number; }

/** Inspects every tar entry before extraction. Links, devices and paths outside package/ are refused. */
export async function inspectNpmTarball(path: string): Promise<InspectedArchive> {
  if (statSync(path).size > PACKAGE_ARCHIVE_LIMITS.maxArchiveBytes) throw new ExtensionPackageError("UNSAFE_ARCHIVE", "package archive exceeds compressed byte limit");
  let files = 0; let unpackedBytes = 0;
  const paths = new Set<string>(); let unsafe: ExtensionPackageError | undefined;
  try {
    await tar.t({ file: path, strict: true, onReadEntry(entry) {
      if (unsafe) return;
      const canonical = entry.path.normalize("NFC").toLocaleLowerCase("en-US");
      if (!safeArchivePath(entry.path) || paths.has(canonical) || (entry.type !== "File" && entry.type !== "Directory")) { unsafe = new ExtensionPackageError("UNSAFE_ARCHIVE", `unsafe or duplicate archive entry: ${entry.path}`); return; }
      paths.add(canonical);
      if (entry.type === "File") { files++; unpackedBytes += entry.size; }
      if (files > PACKAGE_ARCHIVE_LIMITS.maxFiles || unpackedBytes > PACKAGE_ARCHIVE_LIMITS.maxUnpackedBytes) unsafe = new ExtensionPackageError("UNSAFE_ARCHIVE", "package archive exceeds extraction quota");
    } });
    if (unsafe) throw unsafe;
  } catch (error) {
    if (error instanceof ExtensionPackageError) throw error;
    throw new ExtensionPackageError("UNSAFE_ARCHIVE", `package archive could not be read safely: ${(error as Error).message}`);
  }
  return { files, unpackedBytes };
}

export function verifyNpmIntegrity(path: string, integrity: string): void {
  const match = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match) throw new ExtensionPackageError("INTEGRITY_MISMATCH", "package integrity must be sha512 or sha256 SRI");
  const actual = createHash(match[1]).update(readFileSync(path)).digest();
  const expected = Buffer.from(match[2]!, "base64");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ExtensionPackageError("INTEGRITY_MISMATCH", "downloaded package does not match registry integrity");
}

/** Extract only a previously inspected archive into a private fresh staging directory. */
export async function extractVerifiedNpmTarball(archive: string, destinationParent: string): Promise<string> {
  await inspectNpmTarball(archive);
  const inspectedDigest = createHash("sha512").update(readFileSync(archive)).digest("hex");
  mkdirSync(destinationParent, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(destinationParent, ".extension-stage-"));
  try {
    if (createHash("sha512").update(readFileSync(archive)).digest("hex") !== inspectedDigest) throw new ExtensionPackageError("UNSAFE_ARCHIVE", "archive changed after inspection");
    await tar.x({ file: archive, cwd: stage, strict: true, preservePaths: false, preserveOwner: false, noChmod: true, unlink: false });
    const packageDirectory = join(stage, "package");
    const root = realpathSync(stage); const extracted = realpathSync(packageDirectory);
    if (relative(root, extracted).startsWith("..")) throw new ExtensionPackageError("UNSAFE_ARCHIVE", "archive extraction escaped staging root");
    return packageDirectory;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (error instanceof ExtensionPackageError) throw error;
    throw new ExtensionPackageError("UNSAFE_ARCHIVE", `package extraction failed: ${(error as Error).message}`);
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
  } catch (error) { throw new ExtensionPackageError("NPM_FETCH_FAILED", `npm pack failed: ${(error as Error).message}`); }
}

/** Test-only helper for isolated callers that want a private npm staging root. */
export function createNpmStagingDirectory(): string { return mkdtempSync(join(tmpdir(), "wolfpack-extension-npm-")); }
