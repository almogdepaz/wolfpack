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
const { chmodSync, existsSync } = require("node:fs");
const { platform, arch } = require("node:os");

function makeExecutable(path) {
  try {
    chmodSync(path, 0o755);
    return true;
  } catch (error) {
    console.error(`wolfpack: could not make ${path} executable`);
    console.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}

function findBinary() {
  // fast path: postinstall already copied binary here
  const local = join(__dirname, "wolfpack");
  if (existsSync(local)) return makeExecutable(local) ? local : null;

  // slow path: resolve from platform-specific optional package. Bun blocks
  // dependency postinstall scripts by default, so prepare both extracted
  // binaries here before the compiled CLI can stage them at stable paths.
  const pkg = `wolfpack-bridge-${platform()}-${arch()}`;
  try {
    const pkgRoot = dirname(require.resolve(`${pkg}/package.json`));
    const binary = join(pkgRoot, "wolfpack");
    const broker = join(pkgRoot, "wolfpack-broker");
    if (!existsSync(binary) || !makeExecutable(binary)) return null;
    if (existsSync(broker) && !makeExecutable(broker)) return null;
    return binary;
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
  if (typeof e.status !== "number") {
    console.error(`wolfpack: failed to execute ${binary}`);
    console.error(e instanceof Error ? e.message : String(e));
  }
  process.exit(typeof e.status === "number" ? e.status : 1);
}
