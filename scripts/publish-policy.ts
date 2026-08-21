import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BROKER_TARGETS,
  assertReleaseSourceClean,
  readSourceRevision,
  validateBrokerArtifact,
  type BrokerTarget,
} from "./broker-artifacts";
import { validateReleaseVersions } from "./release-version-policy";
import type { ReleaseVersions } from "./release-version-policy";

function readObject(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid package manifest: ${path}`);
  }
  return value as Record<string, unknown>;
}

function isExactStringArray(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === expected;
}

export function validatePublicationArtifacts(root: string): ReleaseVersions {
  assertReleaseSourceClean(root);
  const versions = validateReleaseVersions(root);
  const { productVersion: version, brokerVersion } = versions;
  const sourceRevision = readSourceRevision(root);
  const npmDirectory = join(root, "dist", "npm");

  for (const target of Object.keys(BROKER_TARGETS) as BrokerTarget[]) {
    const expected = BROKER_TARGETS[target];
    const packageDirectory = join(npmDirectory, expected.packageName);
    const manifestPath = join(packageDirectory, "package.json");
    const cliPath = join(packageDirectory, "wolfpack");
    const brokerPath = join(packageDirectory, "wolfpack-broker");
    const metadataPath = join(packageDirectory, "broker-artifact.json");
    for (const path of [manifestPath, cliPath, brokerPath, metadataPath]) {
      if (!existsSync(path)) throw new Error(`missing publish artifact: ${path}`);
    }

    const manifest = readObject(manifestPath);
    if (
      manifest.name !== expected.packageName
      || manifest.version !== version
      || !isExactStringArray(manifest.os, expected.os)
      || !isExactStringArray(manifest.cpu, expected.cpu)
    ) {
      throw new Error(`platform package manifest does not match ${target}: ${manifestPath}`);
    }

    validateBrokerArtifact({
      binaryPath: brokerPath,
      metadataPath,
      expectedMode: "release",
      expectedTarget: target,
      expectedBrokerVersion: brokerVersion,
      expectedSourceRevision: sourceRevision,
    });
  }

  return versions;
}
