import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertExactVersionOutput,
  validateReleaseTag,
  validateReleaseVersions,
} from "../../scripts/release-version-policy";
import { BROKER_TARGETS } from "../../scripts/broker-artifacts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function prepareFixture(
  productVersion: string,
  brokerVersion = "0.0.1",
  optionalDependencies: Record<string, string> = Object.fromEntries(
    Object.values(BROKER_TARGETS).map(target => [target.packageName, productVersion]),
  ),
): string {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-release-version-"));
  roots.push(root);
  mkdirSync(join(root, "broker"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    version: productVersion,
    optionalDependencies,
  }));
  writeFileSync(
    join(root, "broker", "Cargo.toml"),
    `[package]\nname = "wolfpack-broker"\nversion = "${brokerVersion}"\n`,
  );
  return root;
}

describe("release version policy", () => {
  test("binds exact stable, prerelease, and build-metadata tags", () => {
    for (const expected of [
      { version: "1.6.20", prerelease: false },
      { version: "1.6.20-rc.1", prerelease: true },
      { version: "1.6.20+build.7", prerelease: false },
      { version: "1.6.20-rc.1+build.7", prerelease: true },
    ] as const) {
      const fixture = prepareFixture(expected.version);
      const validated = validateReleaseTag(fixture, `v${expected.version}`);

      expect(validated.productVersion).toBe(expected.version);
      expect(validated.prerelease).toBe(expected.prerelease);
    }
  });

  test("rejects invalid, non-v-prefixed, and mismatched tags", () => {
    const fixture = prepareFixture("1.6.20");

    for (const tag of ["1.6.20", "vv1.6.20", "v1.6", "v1.6.20-rc..1", "v1.6.21", "v1.6.20+build.7"]) {
      expect(() => validateReleaseTag(fixture, tag)).toThrow();
    }
  });

  test("requires exactly every expected platform dependency at the exact product version", () => {
    const missing = Object.fromEntries(
      Object.values(BROKER_TARGETS).slice(1).map(target => [target.packageName, "1.6.20"]),
    );
    expect(() => validateReleaseVersions(prepareFixture("1.6.20", "0.0.1", missing))).toThrow("missing");

    const mismatched = Object.fromEntries(
      Object.values(BROKER_TARGETS).map(target => [target.packageName, "1.6.20"]),
    );
    mismatched[Object.values(BROKER_TARGETS)[0].packageName] = "1.6.19";
    expect(() => validateReleaseVersions(prepareFixture("1.6.20", "0.0.1", mismatched))).toThrow("1.6.19");

    const extra = {
      ...Object.fromEntries(
        Object.values(BROKER_TARGETS).map(target => [target.packageName, "1.6.20"]),
      ),
      "wolfpack-bridge-freebsd-x64": "1.6.20",
    };
    expect(() => validateReleaseVersions(prepareFixture("1.6.20", "0.0.1", extra))).toThrow(
      "unexpected optional platform dependency",
    );
  });

  test("keeps the broker Cargo version independent from the product version", () => {
    const fixture = prepareFixture("1.6.20", "0.0.1");

    expect(validateReleaseVersions(fixture)).toEqual({
      productVersion: "1.6.20",
      brokerVersion: "0.0.1",
    });
  });

  test("accepts only exact version command output", () => {
    expect(() => assertExactVersionOutput("1.6.20\n", "1.6.20\n", "CLI")).not.toThrow();
    expect(() => assertExactVersionOutput("wolfpack 1.6.20\n", "1.6.20\n", "CLI")).toThrow("CLI");
    expect(() => assertExactVersionOutput("1.6.20-rc.1\n", "1.6.20\n", "CLI")).toThrow("CLI");
    expect(() => assertExactVersionOutput("wolfpack-broker 0.0.10\n", "wolfpack-broker 0.0.1\n", "broker")).toThrow("broker");
  });
});
