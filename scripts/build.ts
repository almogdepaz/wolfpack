#!/usr/bin/env bun
/**
 * Build script — generates embedded assets then compiles wolfpack
 * for all 4 platform targets.
 *
 * Run: bun run scripts/build.ts
 * Output: dist/wolfpack-{platform} binaries
 */
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const ENTRY = join(ROOT, "cli.ts");

const TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
] as const;

function run(cmd: string) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
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

console.log("\n=== build complete ===");
console.log(`binaries in ${DIST}/`);
