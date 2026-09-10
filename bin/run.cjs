#!/usr/bin/env node
/**
 * bin entry — executes the platform-specific compiled binary.
 *
 * Resolve the exact optional platform pair and execute its validated private
 * prepared copy. Local bin/wolfpack is deliberately ignored; development runs
 * its built executable directly. No package lifecycle script is required.
 */
const MINIMUM_NODE_MAJOR = 22;

if (!process.versions.bun) {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < MINIMUM_NODE_MAJOR) {
    console.error(`wolfpack: npm/npx requires Node.js ${MINIMUM_NODE_MAJOR} or later (found ${process.version})`);
    console.error("Use bunx --bun wolfpack-bridge@latest to run with Bun instead.");
    process.exit(1);
  }
}

const { execFileSync } = require("node:child_process");
const { dirname } = require("node:path");
const { platform, arch } = require("node:os");
const { PlatformPairError, stagePlatformPair } = require("./stage-platform-pair.cjs");

function findBinary() {
  const target = `${platform()}-${arch()}`;
  try {
    return stagePlatformPair(dirname(__dirname), target);
  } catch (error) {
    if (error instanceof PlatformPairError) {
      console.error(error.message);
    } else {
      console.error(`wolfpack: could not resolve platform pair for ${target}`);
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  }
}

const binary = findBinary();

try {
  execFileSync(binary, process.argv.slice(2), { stdio: "inherit" });
} catch (e) {
  if (typeof e.status !== "number") {
    console.error(`wolfpack: failed to execute ${binary}`);
    console.error(e instanceof Error ? e.message : String(e));
  }
  process.exit(typeof e.status === "number" ? e.status : 1);
}
