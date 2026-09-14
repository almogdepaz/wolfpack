#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePublicationArtifacts } from "./publish-policy";
import { assertExactVersionOutput } from "./release-version-policy";

const root = join(import.meta.dirname, "..");
const { productVersion, brokerVersion } = validatePublicationArtifacts(root);
const target = process.argv[2] || `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const cli = join(root, "dist", `wolfpack-${target}`);
const releasedBroker = join(root, "dist", `wolfpack-broker-${target}`);
const stagedBroker = join(root, "dist", "broker", `bun-${target}`, "wolfpack-broker");
const broker = existsSync(releasedBroker) ? releasedBroker : stagedBroker;
for (const path of [cli, broker]) {
  if (!existsSync(path)) throw new Error(`missing release artifact: ${path}`);
}
function run(command: string[], options: { cwd?: string; env?: Record<string, string> } = {}): string {
  const result = Bun.spawnSync(command, { cwd: options.cwd || root, env: { ...process.env, ...options.env }, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

function packedArchive(output: string, subject: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`${subject} npm pack did not return JSON`, { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== "object" || parsed[0] === null) {
    throw new Error(`${subject} npm pack returned an invalid result`);
  }
  const filename = (parsed[0] as { readonly filename?: unknown }).filename;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error(`${subject} npm pack result has no filename`);
  }
  return filename;
}

function installedPlatformPackage(home: string, target: string, productVersion: string): string {
  const packageName = `wolfpack-bridge-${target}`;
  const packageRoot = join(home, "node_modules", packageName);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(`installed platform package ${packageName} is unreadable`, { cause: error });
  }
  if (
    typeof manifest !== "object" || manifest === null || Array.isArray(manifest)
    || (manifest as { readonly name?: unknown }).name !== packageName
    || (manifest as { readonly version?: unknown }).version !== productVersion
  ) {
    throw new Error(`installed platform package ${packageName} does not match ${productVersion}`);
  }
  return packageRoot;
}

function assertInstalledPayload(input: string, installed: string, label: string): void {
  if (!readFileSync(input).equals(readFileSync(installed))) {
    throw new Error(`${label} bytes differ after installation`);
  }
  const inputMode = statSync(input).mode & 0o100;
  const installedMode = statSync(installed).mode & 0o100;
  if (inputMode !== 0o100 || installedMode !== inputMode) {
    throw new Error(`${label} owner-executable mode differs after installation`);
  }
}
assertExactVersionOutput(run([cli, "--version"]), `${productVersion}\n`, "CLI");
assertExactVersionOutput(
  run([broker, "--version"]),
  `wolfpack-broker ${brokerVersion}\n`,
  "broker",
);
if (!run([cli, "--help"]).includes("Usage:")) throw new Error("CLI help smoke returned no usage");

const platformPackage = join(root, "dist", "npm", `wolfpack-bridge-${target}`);
if (!existsSync(join(platformPackage, "package.json"))) throw new Error(`missing platform package: ${platformPackage}`);
const home = mkdtempSync(join(tmpdir(), "wolfpack-package-smoke-"));
try {
  const packs = join(home, "packs");
  run(["mkdir", "-p", packs]);
  const platformTar = packedArchive(
    run(["npm", "pack", platformPackage, "--pack-destination", packs, "--json"]),
    "platform package",
  );
  const mainTar = packedArchive(
    run(["npm", "pack", root, "--pack-destination", packs, "--json"]),
    "main package",
  );
  const platformPackageName = `wolfpack-bridge-${target}`;
  writeFileSync(join(home, "package.json"), `${JSON.stringify({
    name: "wolfpack-release-smoke",
    private: true,
    dependencies: {
      "wolfpack-bridge": `file:${join(packs, mainTar)}`,
      [platformPackageName]: `file:${join(packs, platformTar)}`,
    },
  })}\n`);
  run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: home, env: { HOME: home } });
  const installedPlatform = installedPlatformPackage(home, target, productVersion);
  const installedServer = join(installedPlatform, "wolfpack");
  const installedBroker = join(installedPlatform, "wolfpack-broker");
  assertInstalledPayload(join(platformPackage, "wolfpack"), installedServer, "installed server");
  assertInstalledPayload(join(platformPackage, "wolfpack-broker"), installedBroker, "installed broker");
  assertExactVersionOutput(
    run([installedServer, "--version"], { cwd: home, env: { HOME: home } }),
    `${productVersion}\n`,
    "installed platform server",
  );
  assertExactVersionOutput(
    run([installedBroker, "--version"], { cwd: home, env: { HOME: home } }),
    `wolfpack-broker ${brokerVersion}\n`,
    "installed platform broker",
  );
  if (target.startsWith("darwin-")) {
    run(["codesign", "--verify", "--strict", installedServer], { cwd: home, env: { HOME: home } });
    run(["codesign", "--verify", "--strict", installedBroker], { cwd: home, env: { HOME: home } });
  }
  const installed = join(home, "node_modules", ".bin", "wolfpack");
  assertExactVersionOutput(
    run([installed, "--version"], { cwd: home, env: { HOME: home } }),
    `${productVersion}\n`,
    "installed package CLI",
  );
  if (!run([installed, "--help"], { cwd: home, env: { HOME: home } }).includes("Usage:")) {
    throw new Error("installed package help smoke failed");
  }
  console.log(`release artifact and package smoke passed for ${target}`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
