import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type WorkflowStep = {
  readonly name?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, unknown>;
  readonly run?: string;
};

type WorkflowJob = {
  readonly needs?: string | string[];
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

describe("release workflow security policy", () => {
  test("pins every action and release toolchain to an immutable version", () => {
    const actionReferences = allSteps.flatMap(step => step.uses ? [step.uses] : []);
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
    }

    const bunSetupSteps = stepsUsing("oven-sh/setup-bun");
    expect(bunSetupSteps).toHaveLength(2);
    for (const step of bunSetupSteps) {
      expect(step.with?.["bun-version"]).toBe("1.3.9");
    }
    const rustSetupSteps = stepsUsing("dtolnay/rust-toolchain");
    expect(rustSetupSteps).toHaveLength(2);
    for (const step of rustSetupSteps) {
      expect(step.with?.toolchain).toBe("1.89.0");
    }
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
});
