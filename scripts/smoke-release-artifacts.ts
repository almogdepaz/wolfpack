#!/usr/bin/env bun
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const target = process.argv[2] || `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const cli = join(root, "dist", `wolfpack-${target}`);
const broker = join(root, "dist", `wolfpack-broker-${target}`);
for (const path of [cli, broker]) {
  if (!existsSync(path)) throw new Error(`missing release artifact: ${path}`);
}
function run(command: string[], options: { cwd?: string; env?: Record<string, string> } = {}): string {
  const result = Bun.spawnSync(command, { cwd: options.cwd || root, env: { ...process.env, ...options.env }, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString() + result.stderr.toString();
}
if (!run([cli, "--help"]).includes("Usage:")) throw new Error("CLI help smoke returned no usage");
if (!run([broker, "--version"]).includes("wolfpack-broker")) throw new Error("broker version smoke failed");

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
  if (!run([installed, "--help"], { cwd: home, env: { HOME: home } }).includes("Usage:")) {
    throw new Error("installed package help smoke failed");
  }
  console.log(`release artifact and package smoke passed for ${target}`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
