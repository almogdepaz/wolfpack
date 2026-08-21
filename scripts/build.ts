#!/usr/bin/env bun
/**
 * Build script — generates embedded assets and compiles wolfpack for all four
 * platform targets. Broker handling requires an explicit local or package-all
 * mode unless WOLFPACK_BUILD_SERVER_ONLY=1.
 *
 * Local:       WOLFPACK_BUILD_MODE=local bun run scripts/build.ts
 * Release/CI:  WOLFPACK_BUILD_MODE=package-all bun run scripts/build.ts
 */
import { execSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import {
  BROKER_TARGETS,
  assertReleaseSourceClean,
  createBrokerArtifactMetadata,
  readBrokerVersion,
  readSourceRevision,
  validateBrokerArtifact,
  writeBrokerArtifactMetadata,
  type BrokerTarget,
} from "./broker-artifacts";

const ROOT = join(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const NPM_DIR = join(DIST, "npm");
const BROKER_DIR = join(DIST, "broker");
const LOCAL_BROKER_DIR = join(DIST, "local");
const ENTRY = join(ROOT, "src", "cli", "index.ts");
const THIRD_PARTY_NOTICES = join(ROOT, "THIRD_PARTY_NOTICES");
const TARGETS = Object.keys(BROKER_TARGETS) as BrokerTarget[];

type BuildMode = "server-only" | "local" | "package-all";

interface MainPackage {
  readonly version: string;
  optionalDependencies?: Record<string, string>;
}

function hostBunTarget(): BrokerTarget {
  const target = `bun-${platform()}-${arch()}`;
  if (!Object.hasOwn(BROKER_TARGETS, target)) {
    throw new Error(`unsupported host target: ${target}`);
  }
  return target as BrokerTarget;
}

function buildMode(): BuildMode {
  if (process.env.WOLFPACK_BUILD_SERVER_ONLY === "1") return "server-only";
  const requested = process.env.WOLFPACK_BUILD_MODE;
  if (requested === "local" || requested === "package-all") return requested;
  throw new Error("set WOLFPACK_BUILD_MODE=local or WOLFPACK_BUILD_MODE=package-all");
}

function run(command: string): void {
  console.log(`$ ${command}`);
  execSync(command, { cwd: ROOT, stdio: "inherit" });
}

const mainPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as MainPackage;
const version = mainPkg.version;
const mode = buildMode();
if (mode === "package-all") assertReleaseSourceClean(ROOT);

// Version binding is completed by audit:I-02. Preserve the existing behavior here.
let pkgDirty = false;
if (mainPkg.optionalDependencies) {
  for (const dependency of Object.keys(mainPkg.optionalDependencies)) {
    if (mainPkg.optionalDependencies[dependency] !== version) {
      mainPkg.optionalDependencies[dependency] = version;
      pkgDirty = true;
    }
  }
}
if (pkgDirty) {
  writeFileSync(join(ROOT, "package.json"), `${JSON.stringify(mainPkg, null, 2)}\n`);
  console.log(`synced optionalDependencies to version ${version}`);
}

console.log("=== generating embedded assets ===");
run("bun run scripts/gen-assets.ts");
mkdirSync(DIST, { recursive: true });

const brokerStaged = new Map<BrokerTarget, string>();
if (mode === "local") {
  console.log("\n=== building fresh host wolfpack-broker ===");
  rmSync(BROKER_DIR, { recursive: true, force: true });
  rmSync(NPM_DIR, { recursive: true, force: true });
  rmSync(LOCAL_BROKER_DIR, { recursive: true, force: true });
  rmSync(join(DIST, "wolfpack-broker"), { force: true });

  try {
    run("cargo build --release --manifest-path broker/Cargo.toml --bin wolfpack-broker");
  } catch (error: unknown) {
    console.error("broker build failed — install rust toolchain (https://rustup.rs) and retry");
    throw error;
  }

  const target = hostBunTarget();
  const targetDir = join(LOCAL_BROKER_DIR, target);
  const binaryPath = join(targetDir, "wolfpack-broker");
  const metadataPath = join(targetDir, "broker-artifact.json");
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(ROOT, "broker", "target", "release", "wolfpack-broker"), binaryPath);
  chmodSync(binaryPath, 0o755);
  const metadata = createBrokerArtifactMetadata({
    binaryPath,
    mode: "local",
    target,
    brokerVersion: readBrokerVersion(ROOT),
    sourceRevision: readSourceRevision(ROOT),
  });
  writeBrokerArtifactMetadata(metadataPath, metadata);
  brokerStaged.set(target, binaryPath);
  console.log(`  staged fresh ${target} broker at ${binaryPath}`);
} else if (mode === "package-all") {
  console.log("\n=== validating release broker artifacts ===");
  rmSync(LOCAL_BROKER_DIR, { recursive: true, force: true });
  rmSync(NPM_DIR, { recursive: true, force: true });
  rmSync(join(DIST, "wolfpack-broker"), { force: true });
  const brokerVersion = readBrokerVersion(ROOT);
  const sourceRevision = readSourceRevision(ROOT);

  for (const target of TARGETS) {
    const targetDir = join(BROKER_DIR, target);
    const binaryPath = join(targetDir, "wolfpack-broker");
    validateBrokerArtifact({
      binaryPath,
      metadataPath: join(targetDir, "broker-artifact.json"),
      expectedMode: "release",
      expectedTarget: target,
      expectedBrokerVersion: brokerVersion,
      expectedSourceRevision: sourceRevision,
    });
    brokerStaged.set(target, binaryPath);
    copyFileSync(THIRD_PARTY_NOTICES, join(targetDir, "THIRD_PARTY_NOTICES"));
    console.log(`  ${target}: verified target, version, source revision, and sha256`);
  }
  copyFileSync(THIRD_PARTY_NOTICES, join(DIST, "THIRD_PARTY_NOTICES"));
}

console.log("\n=== compiling binaries ===");
for (const target of TARGETS) {
  const name = `wolfpack-${target.replace("bun-", "")}`;
  run(`bun build --compile --target=${target} ${ENTRY} --outfile ${join(DIST, name)}`);
}

if (mode === "package-all") {
  console.log("\n=== generating platform packages ===");
  mkdirSync(NPM_DIR, { recursive: true });

  for (const target of TARGETS) {
    const targetMetadata = BROKER_TARGETS[target];
    const packageDir = join(NPM_DIR, targetMetadata.packageName);
    const brokerSource = brokerStaged.get(target);
    if (!brokerSource) throw new Error(`missing validated broker artifact for ${target}`);
    mkdirSync(packageDir, { recursive: true });

    const platformPackage = {
      name: targetMetadata.packageName,
      version,
      description: `wolfpack-bridge binary for ${targetMetadata.os}-${targetMetadata.cpu}`,
      os: [targetMetadata.os],
      cpu: [targetMetadata.cpu],
      files: ["wolfpack", "wolfpack-broker", "broker-artifact.json", "THIRD_PARTY_NOTICES"],
      homepage: "https://almogdepaz.github.io/wolfpack/",
      license: "MIT",
      repository: {
        type: "git",
        url: "https://github.com/almogdepaz/wolfpack",
      },
    };
    writeFileSync(join(packageDir, "package.json"), `${JSON.stringify(platformPackage, null, 2)}\n`);
    copyFileSync(join(DIST, `wolfpack-${target.replace("bun-", "")}`), join(packageDir, "wolfpack"));
    copyFileSync(brokerSource, join(packageDir, "wolfpack-broker"));
    copyFileSync(join(BROKER_DIR, target, "broker-artifact.json"), join(packageDir, "broker-artifact.json"));
    copyFileSync(THIRD_PARTY_NOTICES, join(packageDir, "THIRD_PARTY_NOTICES"));
    chmodSync(join(packageDir, "wolfpack-broker"), 0o755);
    console.log(`  ${targetMetadata.packageName}/  (wolfpack + verified wolfpack-broker)`);
  }
}

const currentBinary = join(DIST, `wolfpack-${platform()}-${arch()}`);
copyFileSync(currentBinary, join(ROOT, "bin", "wolfpack"));
console.log(`\ncopied ${currentBinary} → bin/wolfpack`);
console.log("\n=== build complete ===");
console.log(`binaries in ${DIST}/`);
if (mode === "local") console.log(`local broker in ${LOCAL_BROKER_DIR}/`);
if (mode === "package-all") console.log(`platform packages in ${NPM_DIR}/`);
