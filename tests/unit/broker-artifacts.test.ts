import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertReleaseSourceClean,
  createBrokerArtifactMetadata,
  validateBrokerArtifact,
  writeBrokerArtifactMetadata,
} from "../../scripts/broker-artifacts";

let root = "";

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), "wolfpack-broker-artifact-"));
  return root;
}

function elf64(machine: number): Buffer {
  const binary = Buffer.alloc(64);
  binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  binary.writeUInt16LE(machine, 18);
  return binary;
}

function macho64(cpuType: number): Buffer {
  const binary = Buffer.alloc(32);
  binary.set([0xcf, 0xfa, 0xed, 0xfe]);
  binary.writeUInt32LE(cpuType, 4);
  return binary;
}

describe("broker artifact provenance", () => {
  test("validates target from binary headers and hash-bound build metadata", () => {
    const fixture = makeRoot();
    const binary = join(fixture, "wolfpack-broker");
    const metadata = join(fixture, "broker-artifact.json");
    writeFileSync(binary, macho64(0x0100000c));

    writeBrokerArtifactMetadata(metadata, createBrokerArtifactMetadata({
      binaryPath: binary,
      mode: "release",
      target: "bun-darwin-arm64",
      brokerVersion: "1.6.20",
      sourceRevision: "a".repeat(40),
    }));

    expect(validateBrokerArtifact({
      binaryPath: binary,
      metadataPath: metadata,
      expectedMode: "release",
      expectedTarget: "bun-darwin-arm64",
      expectedBrokerVersion: "1.6.20",
      expectedSourceRevision: "a".repeat(40),
    }).target).toBe("bun-darwin-arm64");
  });

  test("rejects a broker whose structured header has the wrong architecture", () => {
    const fixture = makeRoot();
    const binary = join(fixture, "wolfpack-broker");
    writeFileSync(binary, elf64(62));

    expect(() => createBrokerArtifactMetadata({
      binaryPath: binary,
      mode: "release",
      target: "bun-linux-arm64",
      brokerVersion: "1.6.20",
      sourceRevision: "b".repeat(40),
    })).toThrow("binary target");
  });

  test("rejects artifacts from a different source revision or broker version", () => {
    const fixture = makeRoot();
    const binary = join(fixture, "wolfpack-broker");
    const metadata = join(fixture, "broker-artifact.json");
    writeFileSync(binary, elf64(62));
    writeBrokerArtifactMetadata(metadata, createBrokerArtifactMetadata({
      binaryPath: binary,
      mode: "release",
      target: "bun-linux-x64",
      brokerVersion: "1.6.20",
      sourceRevision: "d".repeat(40),
    }));

    expect(() => validateBrokerArtifact({
      binaryPath: binary,
      metadataPath: metadata,
      expectedMode: "release",
      expectedTarget: "bun-linux-x64",
      expectedBrokerVersion: "1.6.21",
      expectedSourceRevision: "d".repeat(40),
    })).toThrow("version");
    expect(() => validateBrokerArtifact({
      binaryPath: binary,
      metadataPath: metadata,
      expectedMode: "release",
      expectedTarget: "bun-linux-x64",
      expectedBrokerVersion: "1.6.20",
      expectedSourceRevision: "e".repeat(40),
    })).toThrow("source revision");
  });

  test("release provenance rejects tracked changes but ignores untracked outputs", () => {
    const fixture = makeRoot();
    const brokerDirectory = join(fixture, "broker");
    const sourcePath = join(brokerDirectory, "source.rs");
    const binary = join(fixture, "wolfpack-broker");
    const releaseMetadata = join(fixture, "release-artifact.json");
    const localMetadata = join(fixture, "local-artifact.json");
    mkdirSync(brokerDirectory, { recursive: true });
    writeFileSync(join(brokerDirectory, "Cargo.toml"), "[package]\nname = \"wolfpack-broker\"\nversion = \"0.0.1\"\n");
    writeFileSync(sourcePath, "fn main() {}\n");
    writeFileSync(binary, elf64(62));
    execFileSync("git", ["init", "-q"], { cwd: fixture });
    execFileSync("git", ["add", "broker"], { cwd: fixture });
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: fixture });

    const script = join(process.cwd(), "scripts", "broker-artifacts.ts");
    const commonArgs = [
      `--root=${fixture}`,
      `--binary=${binary}`,
      "--target=bun-linux-x64",
    ];
    execFileSync(process.execPath, [script, "stage", ...commonArgs, `--metadata=${releaseMetadata}`, "--mode=release"]);
    writeFileSync(join(fixture, "untracked-output"), "allowed\n");
    expect(() => assertReleaseSourceClean(fixture)).not.toThrow();

    writeFileSync(sourcePath, "fn main() { println!(\"dirty\"); }\n");
    expect(() => assertReleaseSourceClean(fixture)).toThrow("tracked source");
    expect(() => execFileSync(process.execPath, [
      script,
      "stage",
      ...commonArgs,
      `--metadata=${join(fixture, "dirty-release-artifact.json")}`,
      "--mode=release",
    ])).toThrow("tracked source");
    expect(() => execFileSync(process.execPath, [
      script,
      "validate",
      ...commonArgs,
      `--metadata=${releaseMetadata}`,
      "--mode=release",
    ])).toThrow("tracked source");
    expect(() => execFileSync(process.execPath, [
      script,
      "stage",
      ...commonArgs,
      `--metadata=${localMetadata}`,
      "--mode=local",
    ])).not.toThrow();
  });

  test("rejects local provenance and post-staging binary replacement", () => {
    const fixture = makeRoot();
    const binary = join(fixture, "wolfpack-broker");
    const metadata = join(fixture, "broker-artifact.json");
    writeFileSync(binary, elf64(183));
    writeBrokerArtifactMetadata(metadata, createBrokerArtifactMetadata({
      binaryPath: binary,
      mode: "local",
      target: "bun-linux-arm64",
      brokerVersion: "1.6.20",
      sourceRevision: "c".repeat(40),
    }));

    expect(() => validateBrokerArtifact({
      binaryPath: binary,
      metadataPath: metadata,
      expectedMode: "release",
      expectedTarget: "bun-linux-arm64",
      expectedBrokerVersion: "1.6.20",
      expectedSourceRevision: "c".repeat(40),
    })).toThrow("mode");

    writeFileSync(binary, Buffer.concat([elf64(183), Buffer.from("replacement")]));
    expect(() => validateBrokerArtifact({
      binaryPath: binary,
      metadataPath: metadata,
      expectedMode: "local",
      expectedTarget: "bun-linux-arm64",
      expectedBrokerVersion: "1.6.20",
      expectedSourceRevision: "c".repeat(40),
    })).toThrow("sha256");
  });
});
