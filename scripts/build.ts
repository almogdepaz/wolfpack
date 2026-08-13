#!/usr/bin/env bun
/**
 * Build script — generates embedded assets, compiles wolfpack for all 4
 * platform targets, then generates per-platform npm package dirs.
 *
 * Run: bun run scripts/build.ts
 * Output:
 *   dist/wolfpack-{platform} binaries
 *   dist/npm/wolfpack-bridge-{os}-{cpu}/ package dirs
 */
import { execSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { arch, platform } from "node:os";

const ROOT = join(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const NPM_DIR = join(DIST, "npm");
const BROKER_DIR = join(DIST, "broker");
const ENTRY = join(ROOT, "src", "cli", "index.ts");
const THIRD_PARTY_NOTICES = join(ROOT, "THIRD_PARTY_NOTICES");

const TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
] as const;

// platform package metadata: bun target → { os, cpu, packageName, cargoTriple }
const PLATFORM_META: Record<string, { os: string; cpu: string; name: string; cargoTriple: string }> = {
  "bun-linux-x64":     { os: "linux",  cpu: "x64",   name: "wolfpack-bridge-linux-x64",   cargoTriple: "x86_64-unknown-linux-gnu" },
  "bun-linux-arm64":   { os: "linux",  cpu: "arm64", name: "wolfpack-bridge-linux-arm64", cargoTriple: "aarch64-unknown-linux-gnu" },
  "bun-darwin-x64":    { os: "darwin", cpu: "x64",   name: "wolfpack-bridge-darwin-x64",  cargoTriple: "x86_64-apple-darwin" },
  "bun-darwin-arm64":  { os: "darwin", cpu: "arm64", name: "wolfpack-bridge-darwin-arm64", cargoTriple: "aarch64-apple-darwin" },
};

/** Map host platform/arch to a bun-target key, for the dev-mode fallback
 *  that uses a host-arch-only cargo build to satisfy all 4 platform pkgs. */
function hostBunTarget(): typeof TARGETS[number] | null {
  const p = platform();
  const a = arch();
  if (p === "linux"  && a === "x64")   return "bun-linux-x64";
  if (p === "linux"  && a === "arm64") return "bun-linux-arm64";
  if (p === "darwin" && a === "x64")   return "bun-darwin-x64";
  if (p === "darwin" && a === "arm64") return "bun-darwin-arm64";
  return null;
}

function run(cmd: string) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
}

// read version from main package.json
const mainPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const version: string = mainPkg.version;
const BUILD_SERVER_ONLY = process.env.WOLFPACK_BUILD_SERVER_ONLY === "1";

// sync optionalDependencies versions in main package.json
let pkgDirty = false;
if (mainPkg.optionalDependencies) {
  for (const dep of Object.keys(mainPkg.optionalDependencies)) {
    if (mainPkg.optionalDependencies[dep] !== version) {
      mainPkg.optionalDependencies[dep] = version;
      pkgDirty = true;
    }
  }
}
if (pkgDirty) {
  writeFileSync(join(ROOT, "package.json"), JSON.stringify(mainPkg, null, 2) + "\n");
  console.log(`synced optionalDependencies to version ${version}`);
}

// step 1: generate embedded assets
console.log("=== generating embedded assets ===");
run("bun run scripts/gen-assets.ts");

// step 2: ensure dist/ exists
mkdirSync(DIST, { recursive: true });

// step 3: stage broker binaries for each platform package.
//
// Two modes:
//
//   1. CI (release pipeline): broker binaries pre-built per-target by
//      upstream jobs (broker-darwin / broker-linux in release.yml) and
//      placed at `dist/broker/<bun-target>/wolfpack-broker`. We just verify
//      they're all present.
//
//   2. Local dev (no staged binaries): build host-arch only via `cargo
//      build --release` and reuse it for every platform pkg. Cross-arch
//      packages will technically have the wrong-arch broker, but local
//      `bun run scripts/build.ts` is for testing/dev-deploy on the host
//      — not for publishing artifacts. Tests + `deploy-local.sh` only ever
//      consume the host-arch broker, so this is safe.
const brokerStaged: Record<string, string> = {};
if (!BUILD_SERVER_ONLY) {
console.log("\n=== staging wolfpack-broker for each platform target ===");
mkdirSync(BROKER_DIR, { recursive: true });
const missingStaged: string[] = [];
for (const target of TARGETS) {
  const staged = join(BROKER_DIR, target, "wolfpack-broker");
  if (existsSync(staged)) {
    brokerStaged[target] = staged;
    console.log(`  ${target}: using pre-staged ${staged}`);
  } else {
    missingStaged.push(target);
  }
}

if (missingStaged.length === TARGETS.length) {
  // Pure dev mode: nothing pre-staged. Host-arch cargo build, fan out to all 4.
  console.log("  no pre-staged binaries found — building host-arch broker via cargo (dev mode)");
  try {
    run("cargo build --release --manifest-path broker/Cargo.toml --bin wolfpack-broker");
  } catch (e: unknown) {
    console.error("broker build failed — install rust toolchain (https://rustup.rs) and retry");
    throw e;
  }
  const hostBuilt = join(ROOT, "broker", "target", "release", "wolfpack-broker");
  for (const target of TARGETS) {
    const dir = join(BROKER_DIR, target);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, "wolfpack-broker");
    copyFileSync(hostBuilt, dest);
    chmodSync(dest, 0o755);
    brokerStaged[target] = dest;
  }
  console.log(`  fanned out ${hostBuilt} → 4 platform-target dirs (dev mode; cross-arch pkgs are not real binaries)`);
} else if (missingStaged.length > 0) {
  console.error(`broker binaries are partially staged — missing: ${missingStaged.join(", ")}`);
  console.error("either stage all 4 (release CI) or stage none (dev mode auto-builds host arch)");
  process.exit(1);
}

for (const target of TARGETS) {
  copyFileSync(THIRD_PARTY_NOTICES, join(BROKER_DIR, target, "THIRD_PARTY_NOTICES"));
}

copyFileSync(THIRD_PARTY_NOTICES, join(DIST, "THIRD_PARTY_NOTICES"));

// Stage the host-arch broker at the well-known dist/wolfpack-broker so
// scripts/deploy-local.sh keeps working.
const hostTarget = hostBunTarget();
if (hostTarget && brokerStaged[hostTarget]) {
  const hostDest = join(DIST, "wolfpack-broker");
  copyFileSync(brokerStaged[hostTarget], hostDest);
  chmodSync(hostDest, 0o755);
  console.log(`  copied ${brokerStaged[hostTarget]} → ${hostDest} (host arch — used by deploy-local.sh)`);
}
}

// step 4: compile wolfpack itself for each target
console.log("\n=== compiling binaries ===");
for (const target of TARGETS) {
  const name = `wolfpack-${target.replace("bun-", "")}`;
  const outfile = join(DIST, name);
  run(`bun build --compile --target=${target} ${ENTRY} --outfile ${outfile}`);
}

// step 4: generate per-platform npm package dirs
if (!BUILD_SERVER_ONLY) {
console.log("\n=== generating platform packages ===");
mkdirSync(NPM_DIR, { recursive: true });

for (const target of TARGETS) {
  const meta = PLATFORM_META[target];
  const binaryName = `wolfpack-${target.replace("bun-", "")}`;
  const pkgDir = join(NPM_DIR, meta.name);

  mkdirSync(pkgDir, { recursive: true });

  // write platform package.json
  const platformPkg = {
    name: meta.name,
    version,
    description: `wolfpack-bridge binary for ${meta.os}-${meta.cpu}`,
    os: [meta.os],
    cpu: [meta.cpu],
    files: ["wolfpack", "wolfpack-broker", "THIRD_PARTY_NOTICES"],
    homepage: "https://get-wolfpack.netlify.app/",
    license: "MIT",
    repository: {
      type: "git",
      url: "https://github.com/almogdepaz/wolfpack",
    },
  };
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(platformPkg, null, 2) + "\n");

  // copy wolfpack binary
  const src = join(DIST, binaryName);
  const dest = join(pkgDir, "wolfpack");
  copyFileSync(src, dest);

  // copy matching broker binary
  const brokerSrc = brokerStaged[target];
  const brokerDest = join(pkgDir, "wolfpack-broker");
  copyFileSync(brokerSrc, brokerDest);
  copyFileSync(THIRD_PARTY_NOTICES, join(pkgDir, "THIRD_PARTY_NOTICES"));
  chmodSync(brokerDest, 0o755);

  console.log(`  ${meta.name}/  (wolfpack + wolfpack-broker)`);
}
}

// step 5: copy current platform binary to bin/ for local dev
const currentBin = join(DIST, `wolfpack-${platform()}-${arch()}`);
const binTarget = join(ROOT, "bin", "wolfpack");
copyFileSync(currentBin, binTarget);
console.log(`\ncopied ${currentBin} → bin/wolfpack`);

console.log("\n=== build complete ===");
console.log(`binaries in ${DIST}/`);
if (!BUILD_SERVER_ONLY) console.log(`platform packages in ${NPM_DIR}/`);
