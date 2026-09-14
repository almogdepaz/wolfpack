#!/usr/bin/env node
/**
 * bin entry — executes the platform-specific compiled binary.
 *
 * Resolve the exact optional platform pair and execute its server directly.
 * Local bin/wolfpack is deliberately ignored; development runs its built
 * executable directly. No package lifecycle script is required.
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
const { lstatSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { platform, arch } = require("node:os");

class PlatformPairError extends Error {
  constructor(code, message, cause) {
    const errno = typeof cause?.code === "string" ? ` (${cause.code})` : "";
    super(`${message}${errno}`, { cause });
    this.code = code;
  }
}

function readManifest(path, unreadableMessage, invalidMessage) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new PlatformPairError("platform-package-manifest-unreadable", unreadableMessage, error);
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new PlatformPairError("platform-package-manifest-invalid", invalidMessage);
  }
  return manifest;
}

function assertExecutablePayload(path, packageName, payload) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new PlatformPairError("incomplete-platform-pair", `wolfpack: incomplete platform package ${packageName}; missing ${payload}`, error);
    }
    throw new PlatformPairError("platform-payload-inspection-failed", `wolfpack: could not inspect ${payload} in platform package ${packageName}`, error);
  }
  if (!stat.isFile()) {
    throw new PlatformPairError("non-regular-platform-pair", `wolfpack: platform package ${packageName} has non-regular ${payload}`);
  }
  if ((stat.mode & 0o100) === 0) {
    throw new PlatformPairError("non-executable-platform-pair", `wolfpack: platform package ${packageName} has non-executable ${payload}`);
  }
}

function findBinary() {
  const target = `${platform()}-${arch()}`;
  const mainPackageRoot = dirname(__dirname);
  const packageName = `wolfpack-bridge-${target}`;
  try {
    const mainManifest = readManifest(
      join(mainPackageRoot, "package.json"),
      "wolfpack: unreadable main package manifest",
      "wolfpack: invalid main package manifest",
    );
    const declaredVersion = mainManifest.optionalDependencies?.[packageName];
    if (
      typeof mainManifest.version !== "string"
      || typeof declaredVersion !== "string"
      || declaredVersion !== mainManifest.version
    ) {
      throw new PlatformPairError("platform-package-missing", `wolfpack: no exact optional dependency declared for ${packageName}`);
    }
    let packageRoot;
    try {
      packageRoot = dirname(require.resolve(`${packageName}/package.json`, { paths: [mainPackageRoot] }));
    } catch (error) {
      throw new PlatformPairError("platform-package-missing", `wolfpack: missing optional platform package ${packageName}; rerun this package command with optional dependencies enabled.`, error);
    }
    const platformManifest = readManifest(
      join(packageRoot, "package.json"),
      `wolfpack: unreadable platform package manifest for ${packageName}`,
      `wolfpack: invalid platform package manifest for ${packageName}`,
    );
    if (platformManifest.name !== packageName || platformManifest.version !== declaredVersion) {
      throw new PlatformPairError("platform-package-version-mismatch", `wolfpack: platform package ${packageName} does not match declared version ${declaredVersion}`);
    }
    const server = join(packageRoot, "wolfpack");
    assertExecutablePayload(server, packageName, "wolfpack");
    assertExecutablePayload(join(packageRoot, "wolfpack-broker"), packageName, "wolfpack-broker");
    return server;
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
