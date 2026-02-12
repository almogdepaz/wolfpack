#!/usr/bin/env node
/**
 * bin entry — executes the platform-specific compiled binary.
 * Installed via postinstall, this just proxies to it.
 */
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const { existsSync } = require("node:fs");

const binary = join(__dirname, "wolfpack");

if (!existsSync(binary)) {
  console.error("wolfpack: binary not found. Run `node bin/install.js` or reinstall.");
  process.exit(1);
}

try {
  execFileSync(binary, process.argv.slice(2), { stdio: "inherit" });
} catch (e) {
  process.exit(e.status || 1);
}
