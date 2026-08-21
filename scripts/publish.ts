#!/usr/bin/env bun
/**
 * Publish script — publishes all 5 npm packages (4 platform + 1 main).
 *
 * Platform packages are published FIRST since the main package references
 * them as optionalDependencies.
 *
 * Run: bun run scripts/publish.ts
 * Prerequisite: WOLFPACK_BUILD_MODE=package-all bun run scripts/build.ts
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validatePublicationArtifacts } from "./publish-policy";

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

function commandStderr(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error)) return "";
  const stderr = (error as { readonly stderr: unknown }).stderr;
  if (typeof stderr === "string") return stderr;
  return Buffer.isBuffer(stderr) ? stderr.toString() : "";
}

validatePublicationArtifacts(ROOT);

const mainPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
console.log(`publishing wolfpack-bridge v${mainPkg.version}${dryRun ? " (dry run)" : ""}\n`);

// publish platform packages first
console.log("=== publishing platform packages ===");
for (const pkg of PLATFORM_PACKAGES) {
  const pkgDir = join(NPM_DIR, pkg);
  console.log(`\n  ${pkg}`);
  try {
    execSync(`npm publish ${publishArgs}`, { cwd: pkgDir, stdio: "inherit" });
  } catch (error: unknown) {
    const stderr = commandStderr(error);
    if (stderr.includes("EPUBLISHCONFLICT") || stderr.includes("cannot publish over") || stderr.includes("previously published versions")) {
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
} catch (_error: unknown) {
  console.error("failed to publish wolfpack-bridge");
  process.exit(1);
}

console.log(`\n=== done — wolfpack-bridge@${mainPkg.version} published ===`);
