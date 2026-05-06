#!/usr/bin/env node
/**
 * postinstall — copies platform binaries from the optional dependency to bin/.
 *
 * Two binaries ship per platform package:
 *   - wolfpack         (the bun-compiled server + CLI)
 *   - wolfpack-broker  (the rust PTY broker daemon)
 *
 * Both are placed next to bin/run.cjs so:
 *   1. run.cjs uses the fast local path for `wolfpack`
 *   2. service.ts:brokerProgramPath() finds wolfpack-broker via its
 *      "co-located with the running wolfpack binary" search rule
 *
 * If the platform package isn't installed (e.g. bunx skips
 * optionalDependencies), this exits cleanly and run.cjs handles resolution
 * at runtime; the broker won't be locatable in that case until the user
 * reinstalls properly, but `wolfpack service install` will print a clear
 * "could not locate wolfpack-broker" error rather than failing silently.
 */
const { platform, arch } = require("node:os");
const { copyFileSync, chmodSync, existsSync } = require("node:fs");
const { join, dirname } = require("node:path");

const key = `${platform()}-${arch()}`;
const pkg = `wolfpack-bridge-${key}`;

// resolve platform-specific optional package
let pkgRoot;
try {
  pkgRoot = dirname(require.resolve(`${pkg}/package.json`));
} catch {
  console.log(`wolfpack: platform package ${pkg} not found, skipping postinstall`);
  console.log("wolfpack: binaries will be resolved at runtime");
  process.exit(0);
}

function copyBinary(name) {
  const src = join(pkgRoot, name);
  const dest = join(__dirname, name);
  if (!existsSync(src)) {
    console.log(`wolfpack: ${name} not found in ${pkg}, skipping`);
    return false;
  }
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  return true;
}

const gotMain = copyBinary("wolfpack");
const gotBroker = copyBinary("wolfpack-broker");
if (gotMain && gotBroker) {
  console.log(`wolfpack: installed ${key} binaries (wolfpack + wolfpack-broker)`);
} else if (gotMain) {
  console.log(`wolfpack: installed ${key} wolfpack binary; broker missing (rebuild platform package)`);
}
