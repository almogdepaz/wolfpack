import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  readonly stderr: string;
}

function classifyTag(tag: string): TagClassification {
  const classificationStep = jobs["classify-release"]?.steps?.find(step => step.id === "classify");
  const root = mkdtempSync(join(tmpdir(), "wolfpack-release-tag-"));
  const outputPath = join(root, "github-output");
  try {
    const execution = spawnSync("bash", ["-c", `set -euo pipefail\n${classificationStep?.run ?? ""}`], {
      encoding: "utf-8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        RELEASE_TAG: tag,
      },
    });
    const output = existsSync(outputPath) ? readFileSync(outputPath, "utf-8").trim() : "";
    const prerelease = output
      .split("\n")
      .find(line => line.startsWith("prerelease="))
      ?.slice("prerelease=".length);
    return { status: execution.status, prerelease, stderr: execution.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("release workflow security policy", () => {
  test("classifies stable, build-metadata, and prerelease tags behaviorally", () => {
    const cases = [
      { tag: "v1.6.20", prerelease: "false", npmEligible: true },
      { tag: "v1.6.20+build-1", prerelease: "false", npmEligible: true },
      { tag: "v1.6.20-rc.1", prerelease: "true", npmEligible: false },
      { tag: "v1.6.20-rc.1+build-1", prerelease: "true", npmEligible: false },
    ] as const;

    for (const expected of cases) {
      const classification = classifyTag(expected.tag);

      expect(classification.status, classification.stderr).toBe(0);
      expect(classification.prerelease).toBe(expected.prerelease);
      expect(classification.prerelease === "false").toBe(expected.npmEligible);
    }
  });

  test("rejects invalid tags before release jobs can mutate state", () => {
    for (const tag of ["v1.6", "v1.6.20-rc..1", "not-a-tag"]) {
      const classification = classifyTag(tag);

      expect(classification.status).not.toBe(0);
      expect(classification.prerelease).toBeUndefined();
    }
  });

  test("reuses one validated classification for GitHub release and npm eligibility", () => {
    const classifier = jobs["classify-release"];
    const releaseSteps = stepsUsing("softprops/action-gh-release");

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
    expect(bunSetupSteps).toHaveLength(4);
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
