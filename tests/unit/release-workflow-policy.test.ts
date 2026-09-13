import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReleaseTag } from "../../scripts/release-version-policy";

type WorkflowStep = {
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, unknown>;
  readonly "working-directory"?: string;
  readonly run?: string;
};

type WorkflowJob = {
  readonly "runs-on"?: string;
  readonly if?: string;
  readonly needs?: string | string[];
  readonly outputs?: Record<string, unknown>;
  readonly permissions?: Record<string, string>;
  readonly env?: Record<string, unknown>;
  readonly steps?: WorkflowStep[];
};

type ReleaseWorkflow = {
  readonly permissions?: Record<string, string>;
  readonly jobs: Record<string, WorkflowJob>;
};

const workflowPath = join(process.cwd(), ".github", "workflows", "release.yml");
const workflowSource = readFileSync(workflowPath, "utf-8");
const productVersion = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as { version: string }).version;
const workflow = Bun.YAML.parse(workflowSource) as ReleaseWorkflow;
const jobs = workflow.jobs;
const allSteps = Object.values(jobs).flatMap(job => job.steps ?? []);

function stepsUsing(ownerAndAction: string): WorkflowStep[] {
  return allSteps.filter(step => step.uses?.startsWith(`${ownerAndAction}@`));
}

function jobSource(name: string): string {
  return JSON.stringify(jobs[name] ?? {});
}

function jobNeeds(jobName: string, dependency: string): boolean {
  const needs = jobs[jobName]?.needs;
  return Array.isArray(needs) ? needs.includes(dependency) : needs === dependency;
}

interface FinalizationFixture {
  readonly root: string;
  readonly archive: string;
  readonly checksum: string;
  readonly codesignLog: string;
  readonly runnerTemp: string;
}

const FINAL_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;
const FINAL_PAYLOADS = ["wolfpack", "wolfpack-broker"] as const;

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function prepareFinalizationFixture(): FinalizationFixture {
  const root = mkdtempSync(join(tmpdir(), "wolfpack-finalization-"));
  const dist = join(root, "dist");
  const tools = join(root, "tools");
  const runnerTemp = join(root, "runner-temp");
  const codesignLog = join(root, "codesign.log");
  mkdirSync(tools, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  writeFileSync(codesignLog, "");
  for (const target of FINAL_TARGETS) {
    const packageRoot = join(dist, "npm", `wolfpack-bridge-${target}`);
    const brokerRoot = join(dist, "broker", `bun-${target}`);
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(brokerRoot, { recursive: true });
    writeFileSync(join(dist, `wolfpack-${target}`), `server ${target}\n`);
    writeFileSync(join(brokerRoot, "wolfpack-broker"), `broker ${target}\n`);
    writeFileSync(join(packageRoot, "wolfpack"), `server ${target}\n`);
    writeFileSync(join(packageRoot, "wolfpack-broker"), `broker ${target}\n`);
  }
  writeFileSync(join(dist, "THIRD_PARTY_NOTICES"), "notices\n");
  writeFileSync(join(dist, "checksums-sha256.txt"), "stale pre-sign checksum\n");
  writeExecutable(join(tools, "codesign"), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CODESIGN_LOG"
if [ "\${FAIL_CODESIGN:-0}" = 1 ] && [ "$1" = --sign ]; then exit 17; fi
if [ "$1" = --sign ]; then printf 'signed\\n' >> "$4"; fi
`);
  writeExecutable(join(tools, "lipo"), `#!/bin/sh
set -eu
case "$2" in
  *darwin-arm64*) printf 'arm64\\n' ;;
  *darwin-x64*) printf 'x86_64\\n' ;;
  *) exit 64 ;;
esac
`);
  return {
    root,
    archive: join(runnerTemp, "release-final-bundle.tar.gz"),
    checksum: join(dist, "checksums-sha256.txt"),
    codesignLog,
    runnerTemp,
  };
}

function runFinalization(fixture: FinalizationFixture, failCodesign = false): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [join(process.cwd(), "scripts", "prepare-final-macos-payloads.sh")], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(fixture.root, "tools")}:/usr/bin:/bin`,
      CODESIGN_LOG: fixture.codesignLog,
      FAIL_CODESIGN: failCodesign ? "1" : "0",
    },
  });
}

function runFinalBundle(fixture: FinalizationFixture): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [join(process.cwd(), "scripts", "create-final-release-bundle.sh")], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
      RUNNER_TEMP: fixture.runnerTemp,
    },
  });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface TagClassification {
  readonly status: number | null;
  readonly prerelease: string | undefined;
  readonly expectedPrerelease: string | undefined;
  readonly stderr: string;
}

function classifyTag(tag: string, fixtureProductVersion = productVersion): TagClassification {
  const classificationStep = jobs["classify-release"]?.steps?.find(step => step.id === "classify");
  const root = mkdtempSync(join(tmpdir(), "wolfpack-release-tag-"));
  const outputPath = join(root, "github-output");
  try {
    mkdirSync(join(root, "broker"));
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as {
      version: string;
      optionalDependencies: Record<string, string>;
    };
    manifest.version = fixtureProductVersion;
    manifest.optionalDependencies = Object.fromEntries(
      Object.keys(manifest.optionalDependencies).map(name => [name, fixtureProductVersion]),
    );
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(root, "broker", "Cargo.toml"), readFileSync(join(process.cwd(), "broker", "Cargo.toml")));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "package.json", "broker/Cargo.toml"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"],
      { cwd: root },
    );
    const expectedPrerelease = tag === `v${fixtureProductVersion}`
      ? String(validateReleaseTag(root, tag).prerelease)
      : undefined;
    const execution = spawnSync("bash", ["-c", `set -euo pipefail\n${classificationStep?.run ?? ""}`], {
      encoding: "utf-8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        RELEASE_TAG: tag,
        WOLFPACK_RELEASE_ROOT: root,
      },
    });
    const output = existsSync(outputPath) ? readFileSync(outputPath, "utf-8").trim() : "";
    const prerelease = output
      .split("\n")
      .find(line => line.startsWith("prerelease="))
      ?.slice("prerelease=".length);
    return { status: execution.status, prerelease, expectedPrerelease, stderr: execution.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("release workflow security policy", () => {
  test("classifies stable or prerelease tags from the checked-out manifest policy", () => {
    for (const version of [productVersion, "1.6.20-rc.1"]) {
      const classification = classifyTag(`v${version}`, version);

      expect(classification.status, classification.stderr).toBe(0);
      expect(classification.prerelease).toBe(classification.expectedPrerelease);
    }
  });

  test("rejects invalid and mismatched tags before release jobs can mutate state", () => {
    for (const tag of ["v1.6", "v1.6.20-rc..1", "not-a-tag", "v999.0.0"]) {
      const classification = classifyTag(tag);

      expect(classification.status).not.toBe(0);
      expect(classification.prerelease).toBeUndefined();
    }
  });

  test("binds checked-out manifests before every build and reuses one classification", () => {
    const classifier = jobs["classify-release"];
    const classifierSteps = classifier?.steps ?? [];
    const checkoutIndex = classifierSteps.findIndex(step => step.uses?.startsWith("actions/checkout@"));
    const setupIndex = classifierSteps.findIndex(step => step.uses?.startsWith("oven-sh/setup-bun@"));
    const classifyIndex = classifierSteps.findIndex(step => step.id === "classify");
    const releaseSteps = stepsUsing("softprops/action-gh-release");

    expect(checkoutIndex).toBeGreaterThanOrEqual(0);
    expect(setupIndex).toBeGreaterThan(checkoutIndex);
    expect(classifyIndex).toBeGreaterThan(setupIndex);
    expect(classifierSteps[classifyIndex]?.run).toBe("bun run scripts/release-version-policy.ts");
    expect(classifierSteps[classifyIndex]?.env).toEqual({ RELEASE_TAG: "${{ github.ref_name }}" });
    for (const jobName of ["broker-darwin", "broker-linux", "build"]) {
      expect(jobNeeds(jobName, "classify-release")).toBe(true);
    }
    expect(classifier?.outputs?.prerelease).toBe("${{ steps.classify.outputs.prerelease }}");
    expect(releaseSteps).toHaveLength(1);
    expect(releaseSteps[0].with?.prerelease).toBe(
      "${{ needs.classify-release.outputs.prerelease }}",
    );
    expect(jobs["publish-npm"]?.if).toBe(
      "${{ needs.classify-release.outputs.prerelease == 'false' }}",
    );
    expect(jobNeeds("release", "classify-release")).toBe(true);
    expect(jobNeeds("publish-npm", "classify-release")).toBe(true);
  });

  test("pins every action and release toolchain to an immutable version", () => {
    const actionReferences = allSteps.flatMap(step => step.uses ? [step.uses] : []);
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
    }

    const bunSetupSteps = stepsUsing("oven-sh/setup-bun");
    expect(bunSetupSteps).toHaveLength(6);
    for (const step of bunSetupSteps) {
      expect(step.with?.["bun-version"]).toBe("1.4.2");
    }
    const rustSetupSteps = stepsUsing("dtolnay/rust-toolchain");
    expect(rustSetupSteps).toHaveLength(2);
    for (const step of rustSetupSteps) {
      expect(step.with?.toolchain).toBe("1.89.0");
    }
  });

  test("pins Node 22 before the build job runs the installed package smoke", () => {
    const buildSteps = jobs.build?.steps ?? [];
    const nodeIndex = buildSteps.findIndex(step => step.uses?.startsWith("actions/setup-node@"));
    const smokeIndex = buildSteps.findIndex(step => step.name === "Smoke installed package and native release artifacts");

    expect(nodeIndex).toBeGreaterThanOrEqual(0);
    expect(buildSteps[nodeIndex]?.with?.["node-version"]).toBe("22.17.0");
    expect(smokeIndex).toBeGreaterThan(nodeIndex);
  });

  test("release broker builds use unconditional authoritative Ghostty", () => {
    const brokerBuilds = allSteps.filter(step => step.run?.includes("--manifest-path broker/Cargo.toml"));
    expect(brokerBuilds).toHaveLength(4);
    for (const step of brokerBuilds) {
      expect(step.run).toContain("--bin wolfpack-broker");
      expect(step.run).not.toContain("--features");
      expect(step.run).not.toContain("shadow");
    }
  });

  test("stages broker provenance for every target and selects package-all explicitly", () => {
    const brokerJobs = [jobs["broker-darwin"], jobs["broker-linux"]];
    const stagingSource = brokerJobs
      .flatMap(job => job?.steps ?? [])
      .map(step => step.run ?? "")
      .join("\n");
    for (const target of [
      "bun-linux-x64",
      "bun-linux-arm64",
      "bun-darwin-x64",
      "bun-darwin-arm64",
    ]) {
      expect(stagingSource).toContain(`--target=${target}`);
    }
    expect(stagingSource.match(/broker-artifacts\.ts stage/g)).toHaveLength(4);
    expect(jobSource("build")).toContain("WOLFPACK_BUILD_MODE=package-all bun run scripts/build.ts");
  });

  test("keeps build jobs read-only and grants release authority only to the release job", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(jobs.release?.permissions).toMatchObject({
      contents: "write",
      "id-token": "write",
      attestations: "write",
    });

    for (const [name, job] of Object.entries(jobs)) {
      if (name === "release") continue;
      expect(job.permissions?.contents ?? workflow.permissions?.contents).toBe("read");
    }
    expect(jobSource("build")).not.toContain("action-gh-release");
    expect(jobSource("build")).not.toContain("NPM_TOKEN");
  });

  test("transports build and final artifacts in mode-preserving bundles", () => {
    const buildUpload = jobs.build?.steps?.find(step => step.name === "Upload build bundle");
    const preparationSteps = jobs["prepare-final-bundle"]?.steps ?? [];
    const publishSteps = jobs["publish-npm"]?.steps ?? [];
    const publishCheckout = publishSteps.findIndex(step => step.uses?.startsWith("actions/checkout@"));
    const publishDownload = publishSteps.findIndex(step => step.name === "Download final release bundle");

    expect(buildUpload?.with?.path).toBe("${{ runner.temp }}/release-build-bundle.tar.gz");
    expect(JSON.stringify(buildUpload)).not.toContain("package.json");
    expect(preparationSteps.find(step => step.name === "Extract build bundle")?.run).toContain("tar -xzf");
    const releaseDownload = jobs.release?.steps?.find(step => step.name === "Download final release bundle");
    expect(publishCheckout).toBeGreaterThanOrEqual(0);
    expect(publishDownload).toBeGreaterThan(publishCheckout);
    expect(publishSteps[publishDownload]?.with?.path).toBe("bundle");
    expect(releaseDownload?.with?.path).toBe("bundle");
    expect(jobSource("release")).toContain("tar -xzf bundle/release-final-bundle.tar.gz");
    expect(jobSource("publish-npm")).toContain("tar -xzf bundle/release-final-bundle.tar.gz");
    expect(workflowSource).not.toContain("version-synchronized by scripts/build.ts");
  });

  test("isolates npm credentials and attests installer-consumed release assets", () => {
    const publishJob = jobs["publish-npm"];
    expect(publishJob).toBeDefined();
    expect(jobSource("publish-npm")).toContain("secrets.NPM_TOKEN");
    expect(jobSource("publish-npm")).toContain("NPM_CONFIG_PROVENANCE");
    expect(JSON.stringify(publishJob.env ?? {})).not.toContain("NPM_TOKEN");
    const tokenSteps = (publishJob.steps ?? []).filter(step => JSON.stringify(step.env ?? {}).includes("NPM_TOKEN"));
    expect(tokenSteps).toHaveLength(1);
    expect(tokenSteps[0].uses).toBeUndefined();

    for (const name of Object.keys(jobs)) {
      if (name !== "publish-npm") expect(jobSource(name)).not.toContain("NPM_TOKEN");
    }

    expect(stepsUsing("actions/attest-build-provenance")).toHaveLength(1);
    expect(jobSource("release")).toContain("dist/wolfpack-linux-x64");
    expect(jobSource("release")).toContain("dist/wolfpack-broker-darwin-arm64");
  });

  test("routes the macOS-prepared final bundle through smoke and every release consumer", () => {
    const preparation = jobs["prepare-final-bundle"];
    const preparationSteps = preparation?.steps ?? [];
    const index = (name: string): number => preparationSteps.findIndex(step => step.name === name);
    const orderedSteps = [
      "Prepare final macOS payloads",
      "Smoke host-compatible final package",
      "Create final release bundle",
      "Upload final bundle",
    ].map(index);

    expect(preparation?.["runs-on"]).toBe("macos-14");
    expect(jobNeeds("prepare-final-bundle", "build")).toBe(true);
    expect(preparationSteps[orderedSteps[0] ?? -1]?.run).toBe("scripts/prepare-final-macos-payloads.sh");
    expect(preparationSteps[orderedSteps[2] ?? -1]?.run).toBe("scripts/create-final-release-bundle.sh");
    expect(statSync(join(process.cwd(), "scripts", "prepare-final-macos-payloads.sh")).mode & 0o111).toBe(0o111);
    expect(statSync(join(process.cwd(), "scripts", "create-final-release-bundle.sh")).mode & 0o111).toBe(0o111);
    expect(orderedSteps[0]).toBeGreaterThanOrEqual(0);
    for (let position = 1; position < orderedSteps.length; position++) {
      expect(orderedSteps[position]).toBeGreaterThan(orderedSteps[position - 1] ?? -1);
    }
    expect(preparationSteps[orderedSteps.at(-1) ?? -1]?.with?.name).toBe("release-final-bundle-${{ github.sha }}");
    for (const jobName of ["release", "publish-npm"]) {
      expect(jobNeeds(jobName, "prepare-final-bundle")).toBe(true);
      const steps = jobs[jobName]?.steps ?? [];
      const download = steps.find(step => step.name === "Download final release bundle");
      const extractIndex = steps.findIndex(step => step.name === "Extract final release bundle");
      const consumerIndex = jobName === "release"
        ? steps.findIndex(step => step.name === "Attest release binaries")
        : steps.findIndex(step => step.name === "Publish to npm with provenance");
      expect(download?.with?.name).toBe("release-final-bundle-${{ github.sha }}");
      expect(extractIndex).toBeGreaterThanOrEqual(0);
      expect(consumerIndex).toBeGreaterThan(extractIndex);
    }
  });

  test("executes the owned finalization script with final signed pair bytes", () => {
    const fixture = prepareFinalizationFixture();
    try {
      const result = runFinalization(fixture);
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(readFileSync(fixture.codesignLog, "utf8").trim().split("\n")).toEqual([
        "--sign - --force dist/wolfpack-darwin-arm64",
        "--sign - --force dist/wolfpack-darwin-x64",
        "--verify --strict dist/wolfpack-darwin-arm64",
        "--verify --strict dist/wolfpack-darwin-x64",
        "--verify --strict dist/wolfpack-broker-darwin-arm64",
        "--verify --strict dist/wolfpack-broker-darwin-x64",
      ]);
      for (const target of FINAL_TARGETS) {
        for (const payload of FINAL_PAYLOADS) {
          const releasePayload = join(fixture.root, "dist", `${payload === "wolfpack" ? "wolfpack" : "wolfpack-broker"}-${target}`);
          const packagePayload = join(fixture.root, "dist", "npm", `wolfpack-bridge-${target}`, payload);
          expect(readFileSync(packagePayload)).toEqual(readFileSync(releasePayload));
          expect(statSync(releasePayload).mode & 0o777).toBe(0o755);
          expect(statSync(packagePayload).mode & 0o777).toBe(0o755);
        }
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("creates final checksums and archive from post-sign payloads", () => {
    const fixture = prepareFinalizationFixture();
    try {
      const finalization = runFinalization(fixture);
      expect(finalization.status, `${finalization.stderr}\n${finalization.stdout}`).toBe(0);
      const bundle = runFinalBundle(fixture);
      expect(bundle.status, `${bundle.stderr}\n${bundle.stdout}`).toBe(0);

      const checksumLines = readFileSync(fixture.checksum, "utf8").trim().split("\n");
      const expectedChecksumLines = [
        ...FINAL_TARGETS.flatMap(target => FINAL_PAYLOADS.map(payload => {
          const name = `${payload === "wolfpack" ? "wolfpack" : "wolfpack-broker"}-${target}`;
          return `${sha256(join(fixture.root, "dist", name))}  ${name}`;
        })),
        `${sha256(join(fixture.root, "dist", "THIRD_PARTY_NOTICES"))}  THIRD_PARTY_NOTICES`,
      ].sort();
      expect(checksumLines.sort()).toEqual(expectedChecksumLines);

      const archiveContents = execFileSync("tar", ["-tzf", fixture.archive], { encoding: "utf8" });
      for (const target of FINAL_TARGETS) {
        for (const payload of FINAL_PAYLOADS) {
          const name = `${payload === "wolfpack" ? "wolfpack" : "wolfpack-broker"}-${target}`;
          expect(archiveContents).toContain(`dist/${name}`);
        }
      }
      expect(archiveContents).toContain("dist/THIRD_PARTY_NOTICES");
      expect(archiveContents).toContain("dist/checksums-sha256.txt");

      const extracted = join(fixture.root, "extracted");
      mkdirSync(extracted);
      execFileSync("tar", ["-xzf", fixture.archive, "-C", extracted]);
      for (const target of FINAL_TARGETS) {
        for (const payload of FINAL_PAYLOADS) {
          const name = `${payload === "wolfpack" ? "wolfpack" : "wolfpack-broker"}-${target}`;
          const source = join(fixture.root, "dist", name);
          const archived = join(extracted, "dist", name);
          const packagePayload = join(fixture.root, "dist", "npm", `wolfpack-bridge-${target}`, payload);
          const archivedPackagePayload = join(extracted, "dist", "npm", `wolfpack-bridge-${target}`, payload);
          expect(readFileSync(archived)).toEqual(readFileSync(source));
          expect(statSync(archived).mode & 0o777).toBe(statSync(source).mode & 0o777);
          expect(readFileSync(archivedPackagePayload)).toEqual(readFileSync(packagePayload));
          expect(readFileSync(packagePayload)).toEqual(readFileSync(source));
          expect(statSync(archivedPackagePayload).mode & 0o777).toBe(statSync(packagePayload).mode & 0o777);
          expect(statSync(packagePayload).mode & 0o777).toBe(statSync(source).mode & 0o777);
        }
      }
      expect(readFileSync(join(extracted, "dist", "THIRD_PARTY_NOTICES"))).toEqual(
        readFileSync(join(fixture.root, "dist", "THIRD_PARTY_NOTICES")),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("fails closed when a final package pair differs", () => {
    const fixture = prepareFinalizationFixture();
    try {
      writeFileSync(join(fixture.root, "dist", "npm", "wolfpack-bridge-linux-x64", "wolfpack-broker"), "tampered broker\n");
      const result = runFinalization(fixture);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("wolfpack-broker-linux-x64");
      expect(readFileSync(fixture.checksum, "utf8")).toBe("stale pre-sign checksum\n");
      expect(existsSync(fixture.archive)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("fails closed when final server signing fails", () => {
    const fixture = prepareFinalizationFixture();
    try {
      const result = runFinalization(fixture, true);
      expect(result.status).not.toBe(0);
      expect(readFileSync(fixture.codesignLog, "utf8").trim().split("\n")).toEqual([
        "--sign - --force dist/wolfpack-darwin-arm64",
      ]);
      expect(readFileSync(fixture.checksum, "utf8")).toBe("stale pre-sign checksum\n");
      expect(existsSync(fixture.archive)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("ships third-party notices with broker-containing final release assets", () => {
    const finalBundleScript = readFileSync(join(process.cwd(), "scripts", "create-final-release-bundle.sh"), "utf8");
    const releaseJob = jobSource("release");

    expect(finalBundleScript).toContain("THIRD_PARTY_NOTICES");
    expect(finalBundleScript).toContain("checksums-sha256.txt");
    expect(releaseJob).toContain("dist/THIRD_PARTY_NOTICES");
  });
});
