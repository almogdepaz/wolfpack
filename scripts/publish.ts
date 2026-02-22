#!/usr/bin/env bun
/**
 * Publish script — publishes all 5 npm packages (4 platform + 1 main).
 *
 * Platform packages are published FIRST since the main package references
 * them as optionalDependencies.
 *
 * Run: bun run scripts/publish.ts
 * Prerequisite: bun run scripts/build.ts (generates dist/npm/)
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const NPM_DIR = join(ROOT, "dist", "npm");

const PLATFORM_PACKAGES = [
  "wolfpack-bridge-darwin-arm64",
  "wolfpack-bridge-darwin-x64",
  "wolfpack-bridge-linux-arm64",
  "wolfpack-bridge-linux-x64",
];

const dryRun = process.argv.includes("--dry-run");
const publishArgs = dryRun ? "--dry-run" : "";

// verify build output exists
for (const pkg of PLATFORM_PACKAGES) {
  const pkgDir = join(NPM_DIR, pkg);
  if (!existsSync(join(pkgDir, "package.json")) || !existsSync(join(pkgDir, "wolfpack"))) {
    console.error(`missing build output: ${pkgDir}`);
    console.error("run `bun run scripts/build.ts` first");
    process.exit(1);
  }
}

const mainPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
console.log(`publishing wolfpack-bridge v${mainPkg.version}${dryRun ? " (dry run)" : ""}\n`);

// publish platform packages first
console.log("=== publishing platform packages ===");
for (const pkg of PLATFORM_PACKAGES) {
  const pkgDir = join(NPM_DIR, pkg);
  console.log(`\n  ${pkg}`);
  try {
    execSync(`npm publish ${publishArgs}`, { cwd: pkgDir, stdio: "inherit" });
  } catch (e: any) {
    const stderr = e.stderr?.toString() || "";
    if (stderr.includes("EPUBLISHCONFLICT") || stderr.includes("cannot publish over")) {
      console.log(`  already published, skipping`);
    } else {
      console.error(`  failed to publish ${pkg}`);
      process.exit(1);
    }
  }
}

// publish main package
console.log("\n=== publishing main package ===");
try {
  execSync(`npm publish ${publishArgs}`, { cwd: ROOT, stdio: "inherit" });
} catch (e: any) {
  console.error("failed to publish wolfpack-bridge");
  process.exit(1);
}

console.log(`\n=== done — wolfpack-bridge@${mainPkg.version} published ===`);
