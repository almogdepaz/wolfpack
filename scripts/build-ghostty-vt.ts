#!/usr/bin/env bun
/**
 * Prebuild pinned libghostty-vt static archives for broker Cargo builds.
 *
 * This script is intentionally outside Cargo: release CI builds the archive
 * into a project-mounted target directory before `cargo build` runs, avoiding
 * network/toolchain work in build.rs and preventing dylib selection on Darwin.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const BROKER = join(ROOT, "broker");
const CACHE = join(ROOT, ".cache", "ghostty-vt");
const OUT_ROOT = join(BROKER, "native", "ghostty-vt");
export const GHOSTTY_LOCK_PATH = join(ROOT, "ghostty-vt.lock.json");

export type GhosttyLock = {
  schemaVersion: 1;
  revision: string;
  sourceUrl: string;
  sourceSha256: string;
  zigVersion: string;
  buildInputs: {
    emitLibVt: boolean;
    emitXcframework: boolean;
    simd: boolean;
    optimize: string;
  };
  patches: readonly { path: string; sha256: string }[];
  targets: Record<string, { zigTarget: string }>;
};

export type GhosttyBundleManifest = {
  schemaVersion: 1;
  target: string;
  lockSha256: string;
  lock: GhosttyLock;
  archive: { path: "lib/libghostty-vt.a"; sha256: string };
  headers: { path: "include"; digest: string };
  symbols: { noHostMemsetOverride: true };
};

function run(cmd: string, args: string[], cwd = ROOT): string {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256(path: string): string {
  return sha256Bytes(readFileSync(path));
}

export function readGhosttyLock(path = GHOSTTY_LOCK_PATH): GhosttyLock {
  const lock = JSON.parse(readFileSync(path, "utf8")) as GhosttyLock;
  if (lock.schemaVersion !== 1) throw new Error(`unsupported Ghostty lock schema ${lock.schemaVersion}`);
  for (const patch of lock.patches) {
    const patchPath = join(ROOT, patch.path);
    const observed = sha256(patchPath);
    if (observed !== patch.sha256) {
      throw new Error(`Ghostty patch sha256 mismatch for ${patch.path}: expected ${patch.sha256}, got ${observed}`);
    }
  }
  return lock;
}

export function ghosttyLockSha256(path = GHOSTTY_LOCK_PATH): string {
  return sha256(path);
}

export const GHOSTTY_PATCHES = readGhosttyLock().patches.map((patch) => join(ROOT, patch.path)) as readonly string[];

function ensureSource(lock = readGhosttyLock()): string {
  mkdirSync(CACHE, { recursive: true });
  const archive = join(CACHE, basename(lock.sourceUrl));
  if (!existsSync(archive)) {
    run("curl", ["-fL", "--retry", "3", "-o", archive, lock.sourceUrl]);
  }
  const observed = run("shasum", ["-a", "256", archive]).split(/\s+/)[0];
  if (observed !== lock.sourceSha256) {
    throw new Error(`libghostty-vt source sha256 mismatch: expected ${lock.sourceSha256}, got ${observed}`);
  }

  const lockHash = ghosttyLockSha256();
  const sourceDir = join(CACHE, `source-${lock.revision}-${lockHash.slice(0, 16)}`);
  // Never trust a previously extracted tree: every invocation starts from the
  // authenticated archive and reapplies the authenticated patch set.
  rmSync(sourceDir, { recursive: true, force: true });
  const tmp = join(CACHE, `.extracting-${process.pid}-${Date.now()}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  run("tar", ["-xzf", archive, "-C", tmp]);

  const extracted = readdirSync(tmp)
    .filter((entry) => entry.startsWith("libghostty-vt-") && !entry.endsWith(".tar.gz"))
    .map((entry) => join(tmp, entry))[0];
  if (!extracted) throw new Error("extracted libghostty-vt source directory not found");
  applyPatches(extracted, lock);
  writeFileSync(readyFor(extracted), `${JSON.stringify({ lockSha256: lockHash, revision: lock.revision })}\n`);
  renameSync(extracted, sourceDir);
  rmSync(tmp, { recursive: true, force: true });
  return sourceDir;
}

function readyFor(sourceDir: string): string {
  return join(sourceDir, ".wolfpack-source-ready.json");
}

export function ghosttyPatchArgs(patchPath: string): string[] {
  return ["-p1", "--fuzz=0", "-i", patchPath];
}

function applyPatches(sourceDir: string, lock: GhosttyLock) {
  for (const patch of lock.patches) {
    const patchPath = join(ROOT, patch.path);
    run("patch", ghosttyPatchArgs(patchPath), sourceDir);
  }
}

export function ghosttyBuildArgs(cargoTriple: string, prefix: string, lock = readGhosttyLock()): string[] {
  const meta = lock.targets[cargoTriple];
  if (!meta) throw new Error(`unsupported target ${cargoTriple}`);
  return [
    "build",
    `-Demit-lib-vt=${lock.buildInputs.emitLibVt}`,
    `-Demit-xcframework=${lock.buildInputs.emitXcframework}`,
    `-Dsimd=${lock.buildInputs.simd}`,
    `-Doptimize=${lock.buildInputs.optimize}`,
    `-Dtarget=${meta.zigTarget}`,
    "-p",
    prefix,
  ];
}

function digestDirectory(root: string): string {
  const files: string[] = [];
  function visit(dir: string) {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      if (stat.isFile()) files.push(path);
    }
  }
  visit(root);
  files.sort((a, b) => {
    const relA = relative(root, a).split(sep).join("/");
    const relB = relative(root, b).split(sep).join("/");
    return relA < relB ? -1 : relA > relB ? 1 : 0;
  });

  const digest = createHash("sha256");
  for (const file of files) {
    const rel = relative(root, file).split(sep).join("/");
    digest.update(rel);
    digest.update("\0");
    digest.update(sha256(file));
    digest.update("\0");
  }
  return digest.digest("hex");
}

export function ghosttyArchiveHasHostMemsetOverride(nmOutput: string): boolean {
  return nmOutput.split("\n").some((line) => line.includes("quirks_memset"));
}

export function assertNoHostMemsetOverride(archive: string): void {
  const symbols = run("nm", ["-a", archive]);
  if (ghosttyArchiveHasHostMemsetOverride(symbols)) {
    throw new Error(`Ghostty archive exports/injects quirks_memset host override: ${archive}`);
  }
}

export function createBundleManifest(target: string, bundleDir: string, lock = readGhosttyLock()): GhosttyBundleManifest {
  const archive = join(bundleDir, "lib", "libghostty-vt.a");
  return {
    schemaVersion: 1,
    target,
    lockSha256: ghosttyLockSha256(),
    lock,
    archive: {
      path: "lib/libghostty-vt.a",
      sha256: sha256(archive),
    },
    headers: {
      path: "include",
      digest: digestDirectory(join(bundleDir, "include")),
    },
    symbols: { noHostMemsetOverride: true },
  };
}

export function verifyBundleManifest(target: string, bundleDir: string, lock = readGhosttyLock()): void {
  const manifestPath = join(bundleDir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`missing Ghostty bundle manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as GhosttyBundleManifest;
  if (manifest.schemaVersion !== 1) throw new Error(`unsupported Ghostty bundle manifest schema ${manifest.schemaVersion}`);
  if (manifest.target !== target) throw new Error(`Ghostty bundle target mismatch: expected ${target}, got ${manifest.target}`);
  const expectedLockSha = ghosttyLockSha256();
  if (manifest.lockSha256 !== expectedLockSha) {
    throw new Error(`Ghostty bundle lock sha256 mismatch: expected ${expectedLockSha}, got ${manifest.lockSha256}`);
  }
  if (JSON.stringify(manifest.lock) !== JSON.stringify(lock)) throw new Error("Ghostty bundle lock content is stale");
  if (manifest.symbols?.noHostMemsetOverride !== true) throw new Error("Ghostty bundle symbol policy is stale");
  const archive = join(bundleDir, manifest.archive.path);
  if (sha256(archive) !== manifest.archive.sha256) throw new Error("Ghostty static archive sha256 mismatch");
  const includeDir = join(bundleDir, manifest.headers.path);
  if (digestDirectory(includeDir) !== manifest.headers.digest) throw new Error("Ghostty header tree digest mismatch");
}

function buildTarget(cargoTriple: string, sourceDir: string, lock: GhosttyLock) {
  const prefix = join(CACHE, "build", cargoTriple, "prefix");
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(prefix, { recursive: true });

  run("zig", ghosttyBuildArgs(cargoTriple, prefix, lock), sourceDir);

  const targetOut = join(OUT_ROOT, cargoTriple);
  rmSync(targetOut, { recursive: true, force: true });
  mkdirSync(join(targetOut, "lib"), { recursive: true });
  mkdirSync(join(targetOut, "include"), { recursive: true });

  copyFileSync(join(prefix, "lib", "libghostty-vt.a"), join(targetOut, "lib", "libghostty-vt.a"));
  run("cp", ["-R", join(prefix, "include") + "/", join(targetOut, "include") + "/"]);
  assertNoHostMemsetOverride(join(targetOut, "lib", "libghostty-vt.a"));
  const manifest = createBundleManifest(cargoTriple, targetOut, lock);
  writeFileSync(join(targetOut, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  verifyBundleManifest(cargoTriple, targetOut, lock);
  console.log(`staged ${cargoTriple} → ${targetOut}`);
}

if (import.meta.main) {
  const lock = readGhosttyLock();
  const requested = Bun.argv.includes("--all")
    ? Object.keys(lock.targets)
    : Bun.argv.flatMap((arg, idx, argv) => arg === "--target" ? [argv[idx + 1]] : []).filter(Boolean);

  if (requested.length === 0) {
    console.error(`usage: bun run scripts/build-ghostty-vt.ts --target <cargo-triple> [--target <cargo-triple>...] | --all`);
    process.exit(2);
  }

  const sourceDir = ensureSource(lock);
  for (const target of requested) buildTarget(target, sourceDir, lock);
}
