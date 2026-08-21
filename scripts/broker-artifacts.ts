#!/usr/bin/env bun
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BROKER_TARGETS = {
  "bun-linux-x64": {
    architecture: "x64",
    binaryFormat: "elf",
    cargoTarget: "x86_64-unknown-linux-gnu",
    cpu: "x64",
    os: "linux",
    packageName: "wolfpack-bridge-linux-x64",
  },
  "bun-linux-arm64": {
    architecture: "arm64",
    binaryFormat: "elf",
    cargoTarget: "aarch64-unknown-linux-gnu",
    cpu: "arm64",
    os: "linux",
    packageName: "wolfpack-bridge-linux-arm64",
  },
  "bun-darwin-x64": {
    architecture: "x64",
    binaryFormat: "macho",
    cargoTarget: "x86_64-apple-darwin",
    cpu: "x64",
    os: "darwin",
    packageName: "wolfpack-bridge-darwin-x64",
  },
  "bun-darwin-arm64": {
    architecture: "arm64",
    binaryFormat: "macho",
    cargoTarget: "aarch64-apple-darwin",
    cpu: "arm64",
    os: "darwin",
    packageName: "wolfpack-bridge-darwin-arm64",
  },
} as const;

export type BrokerTarget = keyof typeof BROKER_TARGETS;
export type BrokerArtifactMode = "local" | "release";

type BinaryFormat = "elf" | "macho";
type BinaryArchitecture = "x64" | "arm64";

const BINARY_MAGIC_OFFSET = 0;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const ELF_CLASS_OFFSET = 4;
const ELF_64_BIT_CLASS = 2;
const ELF_BYTE_ORDER_OFFSET = 5;
const ELF_LITTLE_ENDIAN = 1;
const ELF_BIG_ENDIAN = 2;
const ELF_MACHINE_OFFSET = 18;
const ELF_MACHINE_FIELD_END = 20;
const ELF_ARCHITECTURE_BY_MACHINE: Readonly<Record<number, BinaryArchitecture>> = {
  0x3e: "x64",
  0xb7: "arm64",
};
const MACHO_CPU_TYPE_OFFSET = 4;
const MACHO_CPU_TYPE_FIELD_END = 8;
const MACHO_64_BIT_LITTLE_ENDIAN_MAGIC = 0xcffaedfe;
const MACHO_64_BIT_BIG_ENDIAN_MAGIC = 0xfeedfacf;
const MACHO_ARCHITECTURE_BY_CPU_TYPE: Readonly<Record<number, BinaryArchitecture>> = {
  0x01000007: "x64",
  0x0100000c: "arm64",
};
const GIT_DIFF_CLEAN_EXIT_STATUS = 0;
const GIT_DIFF_DIRTY_EXIT_STATUS = 1;

interface BinaryIdentity {
  readonly architecture: BinaryArchitecture;
  readonly format: BinaryFormat;
}

export interface BrokerArtifactMetadata {
  readonly schemaVersion: 1;
  readonly artifact: "wolfpack-broker";
  readonly mode: BrokerArtifactMode;
  readonly target: BrokerTarget;
  readonly cargoTarget: string;
  readonly brokerVersion: string;
  readonly sourceRevision: string;
  readonly sha256: string;
}

interface CreateBrokerArtifactMetadataOptions {
  readonly binaryPath: string;
  readonly mode: BrokerArtifactMode;
  readonly target: BrokerTarget;
  readonly brokerVersion: string;
  readonly sourceRevision: string;
}

interface ValidateBrokerArtifactOptions {
  readonly binaryPath: string;
  readonly metadataPath: string;
  readonly expectedMode: BrokerArtifactMode;
  readonly expectedTarget: BrokerTarget;
  readonly expectedBrokerVersion: string;
  readonly expectedSourceRevision: string;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inspectElf(binary: Buffer): BinaryIdentity {
  if (binary.length < ELF_MACHINE_FIELD_END || binary[ELF_CLASS_OFFSET] !== ELF_64_BIT_CLASS) {
    throw new Error("broker binary is not a supported 64-bit ELF executable");
  }
  const byteOrder = binary[ELF_BYTE_ORDER_OFFSET];
  const machine = byteOrder === ELF_LITTLE_ENDIAN
    ? binary.readUInt16LE(ELF_MACHINE_OFFSET)
    : byteOrder === ELF_BIG_ENDIAN
      ? binary.readUInt16BE(ELF_MACHINE_OFFSET)
      : undefined;
  const architecture = machine === undefined ? undefined : ELF_ARCHITECTURE_BY_MACHINE[machine];
  if (architecture) return { architecture, format: "elf" };
  throw new Error(`broker ELF machine is unsupported: ${machine ?? "unknown"}`);
}

function inspectMacho(binary: Buffer): BinaryIdentity {
  if (binary.length < MACHO_CPU_TYPE_FIELD_END) throw new Error("broker Mach-O header is truncated");
  const magic = binary.readUInt32BE(BINARY_MAGIC_OFFSET);
  const cpuType = magic === MACHO_64_BIT_LITTLE_ENDIAN_MAGIC
    ? binary.readUInt32LE(MACHO_CPU_TYPE_OFFSET)
    : magic === MACHO_64_BIT_BIG_ENDIAN_MAGIC
      ? binary.readUInt32BE(MACHO_CPU_TYPE_OFFSET)
      : undefined;
  const architecture = cpuType === undefined ? undefined : MACHO_ARCHITECTURE_BY_CPU_TYPE[cpuType];
  if (architecture) return { architecture, format: "macho" };
  throw new Error(`broker Mach-O cpu type is unsupported: ${cpuType ?? "unknown"}`);
}

function inspectBrokerBinary(path: string): BinaryIdentity {
  const binary = readFileSync(path);
  if (
    binary.length >= ELF_MAGIC.length
    && binary.subarray(BINARY_MAGIC_OFFSET, BINARY_MAGIC_OFFSET + ELF_MAGIC.length).equals(ELF_MAGIC)
  ) {
    return inspectElf(binary);
  }
  return inspectMacho(binary);
}

function assertBinaryTarget(binaryPath: string, target: BrokerTarget): void {
  const identity = inspectBrokerBinary(binaryPath);
  const expected = BROKER_TARGETS[target];
  if (identity.format !== expected.binaryFormat || identity.architecture !== expected.architecture) {
    throw new Error(
      `broker binary target ${identity.format}-${identity.architecture} does not match ${target}`,
    );
  }
}

function isBrokerTarget(value: unknown): value is BrokerTarget {
  return typeof value === "string" && Object.hasOwn(BROKER_TARGETS, value);
}

function isBrokerArtifactMode(value: unknown): value is BrokerArtifactMode {
  return value === "local" || value === "release";
}

function parseMetadata(path: string): BrokerArtifactMetadata {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null) {
    throw new Error(`invalid broker artifact metadata: ${path}`);
  }
  const metadata = value as Record<string, unknown>;
  if (
    metadata.schemaVersion !== 1
    || metadata.artifact !== "wolfpack-broker"
    || !isBrokerArtifactMode(metadata.mode)
    || !isBrokerTarget(metadata.target)
    || typeof metadata.cargoTarget !== "string"
    || typeof metadata.brokerVersion !== "string"
    || typeof metadata.sourceRevision !== "string"
    || typeof metadata.sha256 !== "string"
  ) {
    throw new Error(`invalid broker artifact metadata: ${path}`);
  }
  return {
    schemaVersion: 1,
    artifact: "wolfpack-broker",
    mode: metadata.mode,
    target: metadata.target,
    cargoTarget: metadata.cargoTarget,
    brokerVersion: metadata.brokerVersion,
    sourceRevision: metadata.sourceRevision,
    sha256: metadata.sha256,
  };
}

export function createBrokerArtifactMetadata(
  options: CreateBrokerArtifactMetadataOptions,
): BrokerArtifactMetadata {
  assertBinaryTarget(options.binaryPath, options.target);
  if (!options.brokerVersion || !options.sourceRevision) {
    throw new Error("broker artifact version and source revision are required");
  }
  return {
    schemaVersion: 1,
    artifact: "wolfpack-broker",
    mode: options.mode,
    target: options.target,
    cargoTarget: BROKER_TARGETS[options.target].cargoTarget,
    brokerVersion: options.brokerVersion,
    sourceRevision: options.sourceRevision,
    sha256: sha256File(options.binaryPath),
  };
}

export function writeBrokerArtifactMetadata(
  path: string,
  metadata: BrokerArtifactMetadata,
): void {
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`);
}

export function validateBrokerArtifact(
  options: ValidateBrokerArtifactOptions,
): BrokerArtifactMetadata {
  const metadata = parseMetadata(options.metadataPath);
  if (metadata.mode !== options.expectedMode) {
    throw new Error(`broker artifact mode ${metadata.mode} does not match ${options.expectedMode}`);
  }
  if (metadata.target !== options.expectedTarget) {
    throw new Error(`broker artifact target ${metadata.target} does not match ${options.expectedTarget}`);
  }
  const target = BROKER_TARGETS[options.expectedTarget];
  if (metadata.cargoTarget !== target.cargoTarget) {
    throw new Error(`broker artifact cargo target does not match ${target.cargoTarget}`);
  }
  if (metadata.brokerVersion !== options.expectedBrokerVersion) {
    throw new Error(`broker artifact version ${metadata.brokerVersion} does not match ${options.expectedBrokerVersion}`);
  }
  if (metadata.sourceRevision !== options.expectedSourceRevision) {
    throw new Error("broker artifact source revision does not match the current checkout");
  }
  assertBinaryTarget(options.binaryPath, options.expectedTarget);
  if (metadata.sha256 !== sha256File(options.binaryPath)) {
    throw new Error(`broker artifact sha256 does not match ${options.binaryPath}`);
  }
  return metadata;
}

export function assertReleaseSourceClean(root: string): void {
  const result = spawnSync(
    "git",
    ["diff", "--quiet", "--ignore-submodules=untracked", "HEAD", "--"],
    { cwd: root, stdio: "ignore" },
  );
  if (result.error) throw new Error("failed to inspect tracked source state", { cause: result.error });
  if (result.status === GIT_DIFF_CLEAN_EXIT_STATUS) return;
  if (result.status === GIT_DIFF_DIRTY_EXIT_STATUS) {
    throw new Error("release provenance requires clean tracked source");
  }
  throw new Error(`failed to inspect tracked source state (git exited ${result.status ?? "without status"})`);
}

export function readSourceRevision(root: string): string {
  return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

export function readBrokerVersion(root: string): string {
  const parsed: unknown = Bun.TOML.parse(readFileSync(join(root, "broker", "Cargo.toml"), "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("invalid broker/Cargo.toml");
  const packageSection = (parsed as Record<string, unknown>).package;
  if (typeof packageSection !== "object" || packageSection === null) {
    throw new Error("broker/Cargo.toml is missing [package]");
  }
  const version = (packageSection as Record<string, unknown>).version;
  if (typeof version !== "string" || !version) throw new Error("broker/Cargo.toml package version is invalid");
  return version;
}

function parseOptions(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (const argument of args) {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3) throw new Error(`invalid argument: ${argument}`);
    options[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return options;
}

function requiredOption(options: Record<string, string>, name: string): string {
  const value = options[name];
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function runCli(): void {
  const command = process.argv[2];
  const options = parseOptions(process.argv.slice(3));
  const root = options.root || join(import.meta.dirname, "..");
  const binaryPath = requiredOption(options, "binary");
  const metadataPath = requiredOption(options, "metadata");
  const targetValue = requiredOption(options, "target");
  const modeValue = requiredOption(options, "mode");
  if (!isBrokerTarget(targetValue)) throw new Error(`unsupported broker target: ${targetValue}`);
  if (!isBrokerArtifactMode(modeValue)) throw new Error(`unsupported broker artifact mode: ${modeValue}`);
  if (modeValue === "release") assertReleaseSourceClean(root);
  const brokerVersion = readBrokerVersion(root);
  const sourceRevision = readSourceRevision(root);

  if (command === "stage") {
    writeBrokerArtifactMetadata(metadataPath, createBrokerArtifactMetadata({
      binaryPath,
      mode: modeValue,
      target: targetValue,
      brokerVersion,
      sourceRevision,
    }));
    return;
  }
  if (command === "validate") {
    validateBrokerArtifact({
      binaryPath,
      metadataPath,
      expectedMode: modeValue,
      expectedTarget: targetValue,
      expectedBrokerVersion: brokerVersion,
      expectedSourceRevision: sourceRevision,
    });
    return;
  }
  throw new Error(`expected stage or validate command, got: ${command ?? "none"}`);
}

if (import.meta.main) {
  try {
    runCli();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
