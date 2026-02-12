#!/usr/bin/env node
/**
 * postinstall — copies the correct platform binary from dist/ to bin/wolfpack
 * This runs after `npm install` or `bunx wolfpack-bridge`.
 */
const { platform, arch } = require("node:os");
const { copyFileSync, chmodSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const PLATFORM_MAP = {
  "darwin-arm64": "wolfpack-darwin-arm64",
  "darwin-x64": "wolfpack-darwin-x64",
  "linux-arm64": "wolfpack-linux-arm64",
  "linux-x64": "wolfpack-linux-x64",
};

const key = `${platform()}-${arch()}`;
const binary = PLATFORM_MAP[key];

if (!binary) {
  console.error(`wolfpack: unsupported platform ${key}`);
  process.exit(1);
}

const src = join(__dirname, "..", "dist", binary);
const dest = join(__dirname, "wolfpack");

if (!existsSync(src)) {
  console.error(`wolfpack: binary not found at ${src}`);
  console.error("Run `bun run scripts/build.ts` first to compile platform binaries.");
  process.exit(1);
}

copyFileSync(src, dest);
chmodSync(dest, 0o755);
console.log(`wolfpack: installed ${binary} for ${key}`);
