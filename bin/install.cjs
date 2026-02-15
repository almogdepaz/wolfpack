#!/usr/bin/env node
/**
 * postinstall — copies platform binary from the optional dependency to bin/wolfpack.
 *
 * This is an optimization so run.cjs can use the fast path. If the platform
 * package isn't installed (e.g. bunx skips optionalDependencies), this exits
 * cleanly — run.cjs handles resolution at runtime.
 */
const { platform, arch } = require("node:os");
const { copyFileSync, chmodSync, existsSync } = require("node:fs");
const { join, dirname } = require("node:path");

const key = `${platform()}-${arch()}`;
const pkg = `wolfpack-bridge-${key}`;
const dest = join(__dirname, "wolfpack");

// resolve binary from platform-specific optional package
let src;
try {
  const pkgJson = require.resolve(`${pkg}/package.json`);
  src = join(dirname(pkgJson), "wolfpack");
} catch {
  console.log(`wolfpack: platform package ${pkg} not found, skipping postinstall`);
  console.log("wolfpack: binary will be resolved at runtime");
  process.exit(0);
}

if (!existsSync(src)) {
  console.log(`wolfpack: binary not found in ${pkg}, skipping postinstall`);
  process.exit(0);
}

copyFileSync(src, dest);
chmodSync(dest, 0o755);
console.log(`wolfpack: installed ${key} binary`);
