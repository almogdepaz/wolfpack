import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReleaseTag } from "../../scripts/release-version-policy";

type WorkflowStep = {
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, unknown>;
  readonly run?: string;
};

type WorkflowJob = {
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
    expect(bunSetupSteps).toHaveLength(5);
    for (const step of bunSetupSteps) {
      expect(step.with?.["bun-version"]).toBe("1.3.9");
    }
    const rustSetupSteps = stepsUsing("dtolnay/rust-toolchain");
    expect(rustSetupSteps).toHaveLength(2);
    for (const step of rustSetupSteps) {
      expect(step.with?.toolchain).toBe("1.89.0");
    }
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

  test("uploads only dist and publishes it with the validated checked-out manifest", () => {
    const buildUpload = jobs.build?.steps?.find(step => step.name === "Upload release bundle");
    const publishSteps = jobs["publish-npm"]?.steps ?? [];
    const publishCheckout = publishSteps.findIndex(step => step.uses?.startsWith("actions/checkout@"));
    const publishDownload = publishSteps.findIndex(step => step.name === "Download release bundle");

    expect(buildUpload?.with?.path).toBe("dist");
    expect(JSON.stringify(buildUpload)).not.toContain("package.json");
    const releaseDownload = jobs.release?.steps?.find(step => step.name === "Download release bundle");
    expect(publishCheckout).toBeGreaterThanOrEqual(0);
    expect(publishDownload).toBeGreaterThan(publishCheckout);
    expect(publishSteps[publishDownload]?.with?.path).toBe("dist");
    expect(releaseDownload?.with?.path).toBe("dist");
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

  test("ships third-party notices with broker-containing release assets", () => {
    const buildJob = jobSource("build");
    const releaseJob = jobSource("release");

    expect(buildJob).toContain("THIRD_PARTY_NOTICES");
    expect(buildJob).toContain("checksums-sha256.txt");
    expect(releaseJob).toContain("dist/THIRD_PARTY_NOTICES");
  });
});
