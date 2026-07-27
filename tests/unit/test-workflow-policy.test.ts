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
  readonly "runs-on"?: string;
  readonly steps?: WorkflowStep[];
};

type TestWorkflow = {
  readonly jobs: Record<string, WorkflowJob>;
};

const workflowPath = join(process.cwd(), ".github", "workflows", "test.yml");
const workflowSource = readFileSync(workflowPath, "utf-8");
const workflow = Bun.YAML.parse(workflowSource) as TestWorkflow;

function requireJob(name: string): WorkflowJob {
  const job = workflow.jobs[name];
  expect(job).toBeDefined();
  return job;
}

function jobSource(job: WorkflowJob): string {
  return JSON.stringify(job);
}

function runCommands(job: WorkflowJob): string[] {
  return (job.steps ?? []).flatMap(step => step.run ? [step.run] : []);
}

describe("pull request Ghostty VT behavior CI policy", () => {
  test("uses pinned actions and toolchains without latest in the Ghostty behavior job", () => {
    const job = requireJob("ghostty-vt-behavior");
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(jobSource(job)).not.toContain("latest");

    const actionReferences = (job.steps ?? []).flatMap(step => step.uses ? [step.uses] : []);
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
    }

    expect(jobSource(job)).toContain("bun-version\":\"1.3.9");
    expect(jobSource(job)).toContain("toolchain\":\"1.89.0");
  });

  test("builds the verified Linux x64 Ghostty bundle through the pinned Zig setup", () => {
    const job = requireJob("ghostty-vt-behavior");
    const commands = runCommands(job).join("\n");
    expect(commands).toContain("scripts/setup-zig-0.16.0.sh");
    expect(commands).toContain("bun run scripts/build-ghostty-vt.ts --target x86_64-unknown-linux-gnu");
  });

  test("runs the complete locked Cargo suite with authoritative Ghostty", () => {
    const job = requireJob("ghostty-vt-behavior");
    const commands = runCommands(job).join("\n");
    expect(commands).toContain("cargo test --locked --manifest-path broker/Cargo.toml --all");
    expect(commands).not.toContain("--features");
    expect(commands).not.toContain("shadow");
  });

  test("builds an authoritative real broker and runs snapshot hydration/reflow integration against it", () => {
    const job = requireJob("ghostty-vt-behavior");
    const commands = runCommands(job).join("\n");
    const source = jobSource(job);
    expect(commands).toContain("cargo build --release --locked --manifest-path broker/Cargo.toml --bin wolfpack-broker");
    expect(source).toContain("WOLFPACK_BROKER_BIN");
    expect(source).toContain("broker/target/release/wolfpack-broker");
    expect(commands).toContain("bun test tests/integration/broker-snapshot-reflow.test.ts");
  });
});
