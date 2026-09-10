const { execFileSync } = require("node:child_process");
const {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} = require("node:fs");
const { createHash } = require("node:crypto");
const { homedir, platform } = require("node:os");
const { basename, dirname, isAbsolute, join, resolve } = require("node:path");

const PREPARATION_FORMAT_VERSION = 1;
const CLAIM_WAIT_MS = 5000;
const CLAIM_POLL_MS = 25;
const GENERATION_STATE = { ABSENT: "absent", INCOMPLETE: "incomplete", READY: "ready" };

class PlatformPairError extends Error {
  constructor(code, message, cause) {
    const errno = typeof cause?.code === "string" ? ` (${cause.code})` : "";
    super(`${message}${errno}`, { cause });
    this.code = code;
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertRegularFile(path, code, message) {
  try {
    if (!lstatSync(path).isFile()) throw new Error("not a regular file");
  } catch (error) {
    throw new PlatformPairError(code, message, error);
  }
}

function assertOwnedDirectory(path, code, privateDirectory = true) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe directory");
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) throw new Error("not owned by current user");
    if (privateDirectory && (stat.mode & 0o077) !== 0) throw new Error("directory is not private");
  } catch (error) {
    if (error instanceof PlatformPairError) throw error;
    throw new PlatformPairError(code, `wolfpack: unsafe private staging directory: ${path}`, error);
  }
}

function ensureCacheDirectory(path, code, privateDirectory) {
  try {
    lstatSync(path);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw new PlatformPairError(code, `wolfpack: cannot inspect cache directory: ${path}`, error);
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (mkdirError) {
      if (!mkdirError || mkdirError.code !== "EEXIST") throw new PlatformPairError(code, `wolfpack: cannot create cache directory: ${path}`, mkdirError);
    }
  }
  assertOwnedDirectory(path, code, privateDirectory);
  if (!privateDirectory && (lstatSync(path).mode & 0o022) !== 0) {
    throw new PlatformPairError(code, `wolfpack: unsafe writable cache directory: ${path}`);
  }
}

function canonicalCacheBase(configured) {
  if (!isAbsolute(configured)) throw new PlatformPairError("unsafe-cache-base", `wolfpack: cache base must be absolute: ${configured}`);
  const normalized = resolve(configured);
  let parent;
  try {
    parent = realpathSync(dirname(normalized));
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    for (let ancestor = parent; ; ancestor = dirname(ancestor)) {
      const stat = lstatSync(ancestor);
      // Root/current-user ancestors and sticky shared temp directories cannot
      // be renamed by a different unprivileged user. Reject other writers.
      if (!stat.isDirectory() || (uid !== undefined && stat.uid !== 0 && stat.uid !== uid)
        || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) {
        throw new PlatformPairError("unsafe-cache-base", `wolfpack: unsafe cache ancestor: ${ancestor}`);
      }
      if (ancestor === dirname(ancestor)) break;
    }
  } catch (error) {
    if (error instanceof PlatformPairError) throw error;
    throw new PlatformPairError("unsafe-cache-base", `wolfpack: cannot inspect cache parent: ${dirname(normalized)}`, error);
  }
  return join(parent, basename(normalized));
}

function cacheRoot() {
  const base = canonicalCacheBase(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"));
  ensureCacheDirectory(base, "unsafe-cache-base", false);
  const namespace = join(base, "wolfpack-bridge");
  ensureCacheDirectory(namespace, "unsafe-cache-namespace", true);
  const root = join(namespace, "platform-pairs");
  ensureCacheDirectory(root, "unsafe-cache-root", true);
  return root;
}

function pairIdentity(packageName, version, target, serverHash, brokerHash) {
  const source = JSON.stringify({
    format: PREPARATION_FORMAT_VERSION,
    packageName,
    version,
    target,
    serverHash,
    brokerHash,
  });
  return createHash("sha256").update(source).digest("hex");
}

function readGeneration(path, identity, expectedSource) {
  let generation;
  try {
    generation = lstatSync(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return { state: GENERATION_STATE.ABSENT };
    throw new PlatformPairError("invalid-generation", `wolfpack: cannot inspect staged generation: ${path}`, error);
  }
  if (!generation.isDirectory() || generation.isSymbolicLink()) {
    throw new PlatformPairError("invalid-generation", `wolfpack: staged generation is invalid: ${path}`);
  }
  assertOwnedDirectory(path, "unsafe-generation");
  const metadataPath = join(path, "pair.json");
  let metadataFile;
  try {
    metadataFile = lstatSync(metadataPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return { state: GENERATION_STATE.INCOMPLETE };
    throw new PlatformPairError("invalid-generation", `wolfpack: cannot inspect staged metadata: ${metadataPath}`, error);
  }
  if (!metadataFile.isFile()) throw new PlatformPairError("invalid-generation", `wolfpack: staged generation is invalid: ${path}`);
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
  } catch {
    throw new PlatformPairError("invalid-generation", `wolfpack: staged generation is invalid: ${path}`);
  }
  if (
    !metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || metadata.identity !== identity || metadata.format !== PREPARATION_FORMAT_VERSION
    || metadata.source?.packageName !== expectedSource.packageName || metadata.source?.version !== expectedSource.version
    || metadata.source?.target !== expectedSource.target || metadata.source?.serverHash !== expectedSource.serverHash
    || metadata.source?.brokerHash !== expectedSource.brokerHash || typeof metadata.prepared?.serverHash !== "string"
    || typeof metadata.prepared?.brokerHash !== "string"
  ) throw new PlatformPairError("invalid-generation", `wolfpack: staged generation is invalid: ${path}`);
  const server = join(path, "wolfpack");
  const broker = join(path, "wolfpack-broker");
  assertRegularFile(server, "invalid-generation", `wolfpack: staged generation is invalid: ${path}`);
  assertRegularFile(broker, "invalid-generation", `wolfpack: staged generation is invalid: ${path}`);
  if ((lstatSync(server).mode & 0o100) === 0 || (lstatSync(broker).mode & 0o100) === 0) {
    throw new PlatformPairError("invalid-generation", `wolfpack: staged generation is not executable: ${path}`);
  }
  if (sha256(server) !== metadata.prepared.serverHash || sha256(broker) !== metadata.prepared.brokerHash) {
    throw new PlatformPairError("invalid-generation", `wolfpack: staged generation is invalid: ${path}`);
  }
  return { state: GENERATION_STATE.READY, server };
}

function prepareMacOSBinary(path) {
  if (platform() !== "darwin") return;
  try {
    execFileSync("xattr", ["-cr", path], { stdio: "ignore" });
    execFileSync("codesign", ["--sign", "-", "--force", path], { stdio: "ignore" });
  } catch (error) {
    throw new PlatformPairError("macos-preparation-failed", `wolfpack: could not prepare staged binary ${path}: ${error.message}`, error);
  }
}

function resolveSourcePair(mainPackageRoot, target) {
  const mainManifest = JSON.parse(readFileSync(join(mainPackageRoot, "package.json"), "utf-8"));
  const packageName = `wolfpack-bridge-${target}`;
  const declaredVersion = mainManifest.optionalDependencies?.[packageName];
  if (typeof declaredVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(declaredVersion)) {
    throw new PlatformPairError("platform-package-missing", `wolfpack: no exact optional dependency declared for ${packageName}`);
  }
  let packageRoot;
  try {
    packageRoot = dirname(require.resolve(`${packageName}/package.json`, { paths: [mainPackageRoot] }));
  } catch {
    throw new PlatformPairError("platform-package-missing", `wolfpack: missing optional platform package ${packageName}; rerun this package command with optional dependencies enabled.`);
  }
  let platformManifest;
  try {
    platformManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8"));
  } catch {
    throw new PlatformPairError("platform-package-missing", `wolfpack: unreadable platform package manifest for ${packageName}`);
  }
  if (platformManifest.name !== packageName || platformManifest.version !== declaredVersion) {
    throw new PlatformPairError("platform-package-version-mismatch", `wolfpack: platform package ${packageName} does not match declared version ${declaredVersion}`);
  }
  const server = join(packageRoot, "wolfpack");
  const broker = join(packageRoot, "wolfpack-broker");
  assertRegularFile(server, "incomplete-platform-pair", `wolfpack: incomplete platform package ${packageName}; missing wolfpack`);
  assertRegularFile(broker, "incomplete-platform-pair", `wolfpack: incomplete platform package ${packageName}; missing wolfpack-broker`);
  return { packageName, declaredVersion, server, broker, serverHash: sha256(server), brokerHash: sha256(broker) };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForClaimedGeneration(generation, identity, expectedSource) {
  const deadline = Date.now() + CLAIM_WAIT_MS;
  while (Date.now() < deadline) {
    const observed = readGeneration(generation, identity, expectedSource);
    if (observed.state === GENERATION_STATE.READY) return observed.server;
    if (observed.state === GENERATION_STATE.ABSENT) break;
    sleep(CLAIM_POLL_MS);
  }
  throw new PlatformPairError("invalid-generation", `wolfpack: staged generation is invalid: ${generation}; completion was not observed. A writer may still be active. Inspect this path; move it aside and retry only after confirming no launcher is using it.`);
}

function claimGeneration(generation) {
  try {
    mkdirSync(generation, { mode: 0o700 });
    assertOwnedDirectory(generation, "unsafe-generation");
    return true;
  } catch (error) {
    if (error && error.code === "EEXIST") return false;
    if (error instanceof PlatformPairError) throw error;
    throw new PlatformPairError("publication-failed", `wolfpack: could not claim staged generation ${generation}: ${error.message}`, error);
  }
}

function stagePlatformPair(mainPackageRoot, target) {
  const source = resolveSourcePair(mainPackageRoot, target);
  const expectedSource = { packageName: source.packageName, version: source.declaredVersion, target, serverHash: source.serverHash, brokerHash: source.brokerHash };
  const identity = pairIdentity(expectedSource.packageName, expectedSource.version, expectedSource.target, expectedSource.serverHash, expectedSource.brokerHash);
  const root = cacheRoot();
  const generation = join(root, identity);
  const warm = readGeneration(generation, identity, expectedSource);
  if (warm.state === GENERATION_STATE.READY) return warm.server;
  // mkdir is the exclusive claim. Only its winner may write; pair.json is the
  // completion marker. Absence of that marker never proves a writer is alive.
  if (warm.state === GENERATION_STATE.INCOMPLETE || !claimGeneration(generation)) {
    return waitForClaimedGeneration(generation, identity, expectedSource);
  }

  try {
    const stagedServer = join(generation, "wolfpack");
    const stagedBroker = join(generation, "wolfpack-broker");
    copyFileSync(source.server, stagedServer);
    copyFileSync(source.broker, stagedBroker);
    if (sha256(stagedServer) !== source.serverHash || sha256(stagedBroker) !== source.brokerHash) throw new PlatformPairError("source-changed", "wolfpack: platform files changed while being staged; retry this command.");
    chmodSync(stagedServer, 0o755);
    chmodSync(stagedBroker, 0o755);
    prepareMacOSBinary(stagedServer);
    prepareMacOSBinary(stagedBroker);
    const metadata = { format: PREPARATION_FORMAT_VERSION, identity, source: expectedSource, prepared: { serverHash: sha256(stagedServer), brokerHash: sha256(stagedBroker) } };
    const completion = join(generation, ".pair.json");
    writeFileSync(completion, `${JSON.stringify(metadata)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(completion, join(generation, "pair.json"));
    const published = readGeneration(generation, identity, expectedSource);
    if (published.state !== GENERATION_STATE.READY) throw new PlatformPairError("invalid-generation", `wolfpack: staged generation is invalid: ${generation}`);
    return published.server;
  } catch (error) {
    if (error instanceof PlatformPairError) throw error;
    throw new PlatformPairError("staging-failed", `wolfpack: could not stage platform pair at ${generation}: ${error.message}`, error);
  }
}

module.exports = { PlatformPairError, stagePlatformPair };
