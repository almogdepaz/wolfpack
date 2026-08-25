#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BROKER_TARGETS,
  assertReleaseSourceClean,
  readBrokerVersion,
} from "./broker-artifacts";

const CORE_IDENTIFIER = "(?:0|[1-9][0-9]*)";
const PRERELEASE_IDENTIFIER = "(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const BUILD_IDENTIFIER = "[0-9A-Za-z-]+";
const SEMVER_PATTERN = new RegExp(
  `^${CORE_IDENTIFIER}\\.${CORE_IDENTIFIER}\\.${CORE_IDENTIFIER}`
  + `(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?`
  + `(?:\\+${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*)?$`,
);

interface PackageManifest {
  readonly version?: unknown;
  readonly optionalDependencies?: unknown;
}

export interface ReleaseVersions {
  readonly productVersion: string;
  readonly brokerVersion: string;
}

export interface ReleaseTagClassification extends ReleaseVersions {
  readonly prerelease: boolean;
}

function readPackageManifest(root: string): PackageManifest {
  const parsed: unknown = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("root package.json is invalid");
  }
  return parsed as PackageManifest;
}

function matchSemVer(version: string, subject: string): RegExpExecArray {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) throw new Error(`${subject} is not valid SemVer: ${version}`);
  return match;
}

export function validateReleaseVersions(root: string): ReleaseVersions {
  const manifest = readPackageManifest(root);
  if (typeof manifest.version !== "string") throw new Error("root package.json version is invalid");
  const productVersion = manifest.version;
  matchSemVer(productVersion, "root package.json version");

  const optionalDependencies = manifest.optionalDependencies;
  if (
    typeof optionalDependencies !== "object"
    || optionalDependencies === null
    || Array.isArray(optionalDependencies)
  ) {
    throw new Error("root package.json optionalDependencies are missing");
  }
  const versions = optionalDependencies as Record<string, unknown>;
  const expectedPackageNames: readonly string[] = Object.values(BROKER_TARGETS).map(
    target => target.packageName,
  );
  for (const packageName of Object.keys(versions)) {
    if (!expectedPackageNames.includes(packageName)) {
      throw new Error(`unexpected optional platform dependency: ${packageName}`);
    }
  }
  for (const packageName of expectedPackageNames) {
    const dependencyVersion = versions[packageName];
    if (dependencyVersion === undefined) {
      throw new Error(`missing optional platform dependency: ${packageName}`);
    }
    if (dependencyVersion !== productVersion) {
      throw new Error(
        `optional platform dependency ${packageName} is ${String(dependencyVersion)}; expected ${productVersion}`,
      );
    }
  }

  const brokerVersion = readBrokerVersion(root);
  matchSemVer(brokerVersion, "broker/Cargo.toml package version");
  return { productVersion, brokerVersion };
}

export function validateReleaseTag(root: string, tag: string): ReleaseTagClassification {
  if (!tag.startsWith("v")) throw new Error(`release tag must start with v: ${tag}`);
  const taggedVersion = tag.slice(1);
  const tagMatch = matchSemVer(taggedVersion, "release tag version");
  const versions = validateReleaseVersions(root);
  if (taggedVersion !== versions.productVersion) {
    throw new Error(
      `release tag version ${taggedVersion} does not match package.json version ${versions.productVersion}`,
    );
  }
  return { ...versions, prerelease: tagMatch[1] !== undefined };
}

export function assertExactVersionOutput(actual: string, expected: string, subject: string): void {
  if (actual !== expected) {
    throw new Error(`${subject} version output mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function requiredEnvironment(name: "GITHUB_OUTPUT" | "RELEASE_TAG"): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

if (import.meta.main) {
  if (process.argv.length > 2) throw new Error("release version policy does not accept arguments");
  const root = process.env.WOLFPACK_RELEASE_ROOT
    ? resolve(process.env.WOLFPACK_RELEASE_ROOT)
    : resolve(import.meta.dirname, "..");
  assertReleaseSourceClean(root);
  const classification = validateReleaseTag(root, requiredEnvironment("RELEASE_TAG"));
  appendFileSync(
    resolve(requiredEnvironment("GITHUB_OUTPUT")),
    `prerelease=${classification.prerelease}\n`,
  );
  console.log(`validated release ${classification.productVersion} (broker ${classification.brokerVersion})`);
}
