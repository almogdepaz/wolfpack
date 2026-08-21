#!/usr/bin/env bun
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
  const platformTar = run(["npm", "pack", platformPackage, "--pack-destination", packs, "--silent"]).trim().split("\n").at(-1)!;
  const mainTar = run(["npm", "pack", root, "--pack-destination", packs, "--silent"]).trim().split("\n").at(-1)!;
  run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", join(packs, mainTar), join(packs, platformTar)], { cwd: home, env: { HOME: home } });
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
