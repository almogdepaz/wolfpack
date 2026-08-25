import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROKER_TARGETS,
  createBrokerArtifactMetadata,
  readSourceRevision,
  writeBrokerArtifactMetadata,
  type BrokerArtifactMode,
  type BrokerTarget,
} from "../../scripts/broker-artifacts";
import { validatePublicationArtifacts } from "../../scripts/publish-policy";

let root = "";

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function brokerBinary(target: BrokerTarget): Buffer {
  const binary = Buffer.alloc(64);
  if (BROKER_TARGETS[target].binaryFormat === "elf") {
    binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    binary.writeUInt16LE(BROKER_TARGETS[target].architecture === "x64" ? 62 : 183, 18);
  } else {
    binary.set([0xcf, 0xfa, 0xed, 0xfe]);
    binary.writeUInt32LE(BROKER_TARGETS[target].architecture === "x64" ? 0x01000007 : 0x0100000c, 4);
  }
  return binary;
}

function preparePublication(mode: BrokerArtifactMode = "release"): string {
  root = mkdtempSync(join(tmpdir(), "wolfpack-publish-policy-"));
  mkdirSync(join(root, "broker"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    version: "1.0.0",
    optionalDependencies: Object.fromEntries(
      Object.values(BROKER_TARGETS).map(target => [target.packageName, "1.0.0"]),
    ),
  }));
  writeFileSync(join(root, "broker", "Cargo.toml"), "[package]\nname = \"wolfpack-broker\"\nversion = \"1.0.0\"\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: root });
  const revision = readSourceRevision(root);

  for (const target of Object.keys(BROKER_TARGETS) as BrokerTarget[]) {
    const targetMetadata = BROKER_TARGETS[target];
    const packageDir = join(root, "dist", "npm", targetMetadata.packageName);
    const binary = join(packageDir, "wolfpack-broker");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({
      name: targetMetadata.packageName,
      version: "1.0.0",
      os: [targetMetadata.os],
      cpu: [targetMetadata.cpu],
    }));
    writeFileSync(join(packageDir, "wolfpack"), "cli\n");
    writeFileSync(binary, brokerBinary(target));
    writeBrokerArtifactMetadata(
      join(packageDir, "broker-artifact.json"),
      createBrokerArtifactMetadata({
        binaryPath: binary,
        mode,
        target,
        brokerVersion: "1.0.0",
        sourceRevision: revision,
      }),
    );
  }
  return root;
}

describe("publish broker policy", () => {
  test("accepts complete release packages with matching target and provenance", () => {
    const fixture = preparePublication();

    expect(() => validatePublicationArtifacts(fixture)).not.toThrow();
  });

  test("rejects packages when tracked broker source changed after staging", () => {
    const fixture = preparePublication();
    appendFileSync(join(fixture, "broker", "Cargo.toml"), "# dirty broker source\n");

    expect(() => validatePublicationArtifacts(fixture)).toThrow("tracked source");
  });

  test("rejects local-mode broker packages", () => {
    const fixture = preparePublication("local");

    expect(() => validatePublicationArtifacts(fixture)).toThrow("mode");
  });

  test("rejects a broker staged under the wrong package target", () => {
    const fixture = preparePublication();
    const armPackage = join(fixture, "dist", "npm", "wolfpack-bridge-linux-arm64");
    const x64Package = join(fixture, "dist", "npm", "wolfpack-bridge-linux-x64");
    writeFileSync(join(armPackage, "wolfpack-broker"), brokerBinary("bun-linux-x64"));
    writeFileSync(
      join(armPackage, "broker-artifact.json"),
      readFileSync(join(x64Package, "broker-artifact.json")),
    );

    expect(() => validatePublicationArtifacts(fixture)).toThrow("target");
  });
});
