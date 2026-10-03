#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

function packedArchives(output: string, platformName: string): { platform: string; main: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error("release packages npm pack did not return JSON", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some(entry => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new Error("npm pack returned an invalid result");
  }
  // Match by identity, not npm's output order; each exact package must occur once.
  const results = parsed;
  const archiveFor = (name: string): string => {
    const entries = results.filter(entry => entry.name === name && entry.version === productVersion);
    if (entries.length !== 1) throw new Error(`npm pack did not return exactly one ${name}@${productVersion}`);
    const filename: unknown = entries[0].filename;
    if (typeof filename !== "string" || !filename.endsWith(".tgz") || basename(filename) !== filename || filename.includes("\\")) {
      throw new Error(`npm pack returned an invalid archive filename for ${name}`);
    }
    return filename;
  };
  const platform = archiveFor(platformName);
  const main = archiveFor("wolfpack-bridge");
  if (platform === main) throw new Error("npm pack returned duplicate archive filenames");
  return { platform, main };
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
// These read-only probes are independent. Settle every child (including failures)
// before packing; installed payload, signature and public-alias checks stay ordered.
const initialChecks = await Promise.allSettled([
  [cli, "--version"], [broker, "--version"], [cli, "--help"],
].map(async command => {
  const child = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${stderr}`);
    return stdout;
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
}));
function checked(result: PromiseSettledResult<string>): string {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}
assertExactVersionOutput(checked(initialChecks[0]!), `${productVersion}\n`, "CLI");
assertExactVersionOutput(checked(initialChecks[1]!), `wolfpack-broker ${brokerVersion}\n`, "broker");
if (!checked(initialChecks[2]!).includes("Usage:")) throw new Error("CLI help smoke returned no usage");

const platformPackageName = `wolfpack-bridge-${target}`;
const platformPackage = join(root, "dist", "npm", platformPackageName);
if (!existsSync(join(platformPackage, "package.json"))) throw new Error(`missing platform package: ${platformPackage}`);
const home = mkdtempSync(join(tmpdir(), "wolfpack-package-smoke-"));
try {
  const packs = join(home, "packs");
  mkdirSync(packs);
  // npm supports multiple package paths. Pack both real archives in one process
  // instead of paying a second npm startup/configuration cost on every smoke.
  const { platform: platformTar, main: mainTar } = packedArchives(
    run(["npm", "pack", platformPackage, root, "--pack-destination", packs, "--json"]),
    platformPackageName,
  );
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
