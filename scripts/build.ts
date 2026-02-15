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
import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { arch, platform } from "node:os";

const ROOT = join(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const NPM_DIR = join(DIST, "npm");
const ENTRY = join(ROOT, "cli.ts");

const TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
] as const;

// platform package metadata: bun target → { os, cpu, packageName }
const PLATFORM_META: Record<string, { os: string; cpu: string; name: string }> = {
  "bun-linux-x64":     { os: "linux",  cpu: "x64",   name: "wolfpack-bridge-linux-x64" },
  "bun-linux-arm64":   { os: "linux",  cpu: "arm64", name: "wolfpack-bridge-linux-arm64" },
  "bun-darwin-x64":    { os: "darwin", cpu: "x64",   name: "wolfpack-bridge-darwin-x64" },
  "bun-darwin-arm64":  { os: "darwin", cpu: "arm64", name: "wolfpack-bridge-darwin-arm64" },
};

function run(cmd: string) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
}

// read version from main package.json
const mainPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const version: string = mainPkg.version;

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

// step 3: compile for each target
console.log("\n=== compiling binaries ===");
for (const target of TARGETS) {
  const name = `wolfpack-${target.replace("bun-", "")}`;
  const outfile = join(DIST, name);
  run(`bun build --compile --target=${target} ${ENTRY} --outfile ${outfile}`);
}

// step 4: generate per-platform npm package dirs
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
    files: ["wolfpack"],
    license: "MIT",
    repository: {
      type: "git",
      url: "https://github.com/almogdepaz/wolfpack",
    },
  };
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(platformPkg, null, 2) + "\n");

  // copy binary
  const src = join(DIST, binaryName);
  const dest = join(pkgDir, "wolfpack");
  copyFileSync(src, dest);

  console.log(`  ${meta.name}/`);
}

// step 5: copy current platform binary to bin/ for local dev
const currentBin = join(DIST, `wolfpack-${platform()}-${arch()}`);
const binTarget = join(ROOT, "bin", "wolfpack");
copyFileSync(currentBin, binTarget);
console.log(`\ncopied ${currentBin} → bin/wolfpack`);

console.log("\n=== build complete ===");
console.log(`binaries in ${DIST}/`);
console.log(`platform packages in ${NPM_DIR}/`);
