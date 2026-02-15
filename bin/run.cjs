#!/usr/bin/env node
/**
 * bin entry — executes the platform-specific compiled binary.
 *
 * Resolution order:
 * 1. Fast path: bin/wolfpack exists (postinstall ran) — use it directly
 * 2. Slow path: require.resolve the platform-specific optional package
 * 3. Error: neither available
 */
const { execFileSync } = require("node:child_process");
const { join, dirname } = require("node:path");
const { existsSync } = require("node:fs");
const { platform, arch } = require("node:os");

function findBinary() {
  // fast path: postinstall already copied binary here
  const local = join(__dirname, "wolfpack");
  if (existsSync(local)) return local;

  // slow path: resolve from platform-specific optional package
  const pkg = `wolfpack-bridge-${platform()}-${arch()}`;
  try {
    const pkgJson = require.resolve(`${pkg}/package.json`);
    const binary = join(dirname(pkgJson), "wolfpack");
    if (existsSync(binary)) return binary;
  } catch {}

  return null;
}

const binary = findBinary();

if (!binary) {
  const key = `${platform()}-${arch()}`;
  console.error(`wolfpack: no binary found for ${key}`);
  console.error(`Expected platform package: wolfpack-bridge-${key}`);
  console.error("Try reinstalling: npm install wolfpack-bridge");
  process.exit(1);
}

try {
  execFileSync(binary, process.argv.slice(2), { stdio: "inherit" });
} catch (e) {
  process.exit(e.status || 1);
}
