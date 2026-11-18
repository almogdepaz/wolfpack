import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type WorkflowStep = {
  readonly id?: string;
  readonly if?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, unknown>;
  readonly run?: string;
};

type WorkflowJob = {
  readonly "runs-on"?: string;
  readonly "timeout-minutes"?: number;
  readonly needs?: string | string[];
  readonly container?: { readonly image?: string; readonly options?: string };
  readonly steps?: WorkflowStep[];
};

type TestWorkflow = {
  readonly concurrency?: { readonly group?: string; readonly "cancel-in-progress"?: unknown };
  readonly jobs: Record<string, WorkflowJob>;
};

const workflowPath = join(process.cwd(), ".github", "workflows", "test.yml");
const workflowSource = readFileSync(workflowPath, "utf-8");
const workflow = Bun.YAML.parse(workflowSource) as TestWorkflow;
const LOCKED_BROKER_TEST_COMMAND = "cargo test --locked --manifest-path broker/Cargo.toml --all";
const gateSource = readFileSync(join(process.cwd(), "scripts", "ci-gate.sh"), "utf8");

function delegatedBrokerCommands(stage: string): string[] {
  const root = mkdtempSync(join(tmpdir(), "workflow-broker-policy-"));
  try {
    const bin = join(root, "bin"), calls = join(root, "calls.jsonl");
    mkdirSync(bin);
    mkdirSync(join(root, "scripts"));
    const gate = join(root, "scripts", "ci-gate.sh");
    writeFileSync(gate, gateSource);
    // Execute the real stage, replacing only the external Cargo process.
    writeFileSync(join(bin, "cargo"), `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(["cargo", ...process.argv.slice(2)]) + "\\n");
`, { mode: 0o700 });
    // These broker stages need no Bash 4-only builtins; /bin/bash is stable
    // even when a prior server import changes the shared process PATH.
    const result = Bun.spawnSync(["/bin/bash", gate, stage], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    return readFileSync(calls, "utf8").trim().split("\n")
      .map(line => (JSON.parse(line) as string[]).join(" "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function requireJob(name: string): WorkflowJob {
  const job = workflow.jobs[name];
  expect(job).toBeDefined();
  return job;
}

function jobSource(job: WorkflowJob): string {
  return JSON.stringify(job);
}

function runCommands(job: WorkflowJob): string[] {
  return (job.steps ?? []).flatMap(step => {
    if (!step.run) return [];
    const delegated = /^scripts\/ci-gate\.sh (broker-(?:build|test))$/.exec(step.run);
    return delegated ? delegatedBrokerCommands(delegated[1]!) : [step.run];
  });
}

describe("pull request homepage diagnostics CI policy", () => {
  test("uploads diagnostics only after QA ran, retaining strict missing-artifact checks", () => {
    const steps = requireJob("e2e").steps ?? [];
    const qa = steps.find(step => step.run === "scripts/ci-gate.sh e2e-pr");
    const upload = steps.find(step => step.name === "Upload homepage QA diagnostics");
    expect(qa?.id).toBe("homepage-qa");
    expect(steps.indexOf(upload!)).toBeGreaterThan(steps.indexOf(qa!));
    expect(upload?.if).toBe("always() && steps.homepage-qa.outcome != 'skipped'");
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
  });
});

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

    expect(jobSource(job)).toContain("bun-version\":\"1.4.2");
    expect(jobSource(job)).toContain("toolchain\":\"1.89.0");
  });

  test("builds the verified Linux x64 Ghostty bundle through the pinned Zig setup", () => {
    const job = requireJob("ghostty-vt-behavior");
    const commands = runCommands(job).join("\n");
    expect(commands).toContain("scripts/setup-zig-0.16.0.sh");
    expect(commands).toContain("bun run scripts/build-ghostty-vt.ts --target x86_64-unknown-linux-gnu");
  });

  test("runs the complete locked Cargo suite exactly once in the Rust job", () => {
    const primaryCommands = runCommands(requireJob("rust"));
    const specializedCommands = runCommands(requireJob("ghostty-vt-behavior"));
    const workflowCommands = Object.values(workflow.jobs).flatMap(runCommands);

    expect(primaryCommands).toContain(LOCKED_BROKER_TEST_COMMAND);
    expect(specializedCommands).not.toContain(LOCKED_BROKER_TEST_COMMAND);
    expect(workflowCommands.filter(command => command.trim() === LOCKED_BROKER_TEST_COMMAND)).toHaveLength(1);
    expect(workflowCommands.join("\n")).not.toContain("--features");
    expect(workflowCommands.join("\n")).not.toContain("shadow");
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

describe("pull request CI job topology", () => {
  const BROKER_ARTIFACT = "wolfpack-broker";
  const BROKER_PATH = "broker/target/release/wolfpack-broker";

  function brokerDownload(job: WorkflowJob): WorkflowStep | undefined {
    return (job.steps ?? []).find(step => step.uses?.startsWith("actions/download-artifact@") && step.with?.name === BROKER_ARTIFACT);
  }

  test("bounds every job with its own timeout and cancels superseded pull request runs", () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect({ name, timeout: job["timeout-minutes"] }).toEqual({ name, timeout: expect.any(Number) });
      expect(job["timeout-minutes"]!).toBeLessThanOrEqual(30);
    }
    expect(workflow.concurrency?.group).toContain("github.ref");
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  });

  test("pins every action to a full commit SHA", () => {
    const references = Object.values(workflow.jobs).flatMap(job => (job.steps ?? []).flatMap(step => step.uses ? [step.uses] : []));
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) expect(reference).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
  });

  test("never installs browser system packages from apt during pull request CI", () => {
    const commands = Object.values(workflow.jobs).flatMap(job => (job.steps ?? []).flatMap(step => step.run ? [step.run] : [])).join("\n");
    expect(commands).not.toContain("playwright install");
    expect(commands).not.toMatch(/\bapt(-get)?\b/);
  });

  test("runs browser jobs in the official Playwright image matching the installed Playwright version", () => {
    const version = (JSON.parse(readFileSync(join(process.cwd(), "node_modules", "@playwright", "test", "package.json"), "utf8")) as { version: string }).version;
    const container = requireJob("e2e").container;
    expect(container?.image).toMatch(new RegExp(`^mcr\\.microsoft\\.com/playwright:v${version.replaceAll(".", "\\.")}-noble@sha256:[0-9a-f]{64}$`));
    // GitHub-hosted runners own the workspace as uid 1001.
    expect(container?.options).toBe("--user 1001");
  });

  test("builds the broker once and shares it with the integration and E2E jobs", () => {
    const build = requireJob("broker").steps ?? [];
    const buildIndex = build.findIndex(step => step.run === "scripts/ci-gate.sh broker-build");
    const upload = build.find(step => step.uses?.startsWith("actions/upload-artifact@") && step.with?.name === BROKER_ARTIFACT);
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(build.indexOf(upload!)).toBeGreaterThan(buildIndex);
    expect(upload?.with).toMatchObject({ name: BROKER_ARTIFACT, path: BROKER_PATH, "if-no-files-found": "error" });

    for (const name of ["integration", "e2e"]) {
      const job = requireJob(name);
      expect([job.needs].flat()).toContain("broker");
      const steps = job.steps ?? [];
      const download = brokerDownload(job);
      expect(download?.with).toMatchObject({ name: BROKER_ARTIFACT, path: "broker/target/release" });
      // Artifact transfer drops the executable bit; ci-gate requires it.
      const chmod = steps.findIndex(step => step.run?.includes(`chmod +x ${BROKER_PATH}`));
      expect(chmod).toBeGreaterThan(steps.indexOf(download!));
      const gate = steps.findIndex(step => /^scripts\/ci-gate\.sh (integration|e2e-pr)$/.test(step.run ?? ""));
      expect(gate).toBeGreaterThan(chmod);
    }
  });

  test("generates embedded assets on the host because the Playwright image has no patch tool", () => {
    const build = requireJob("broker").steps ?? [];
    const generate = build.findIndex(step => step.run === "scripts/ci-gate.sh assets");
    const upload = build.find(step => step.uses?.startsWith("actions/upload-artifact@") && step.with?.name === "generated-assets");
    expect(generate).toBeGreaterThanOrEqual(0);
    expect(build.indexOf(upload!)).toBeGreaterThan(generate);
    expect(upload?.with).toMatchObject({ path: "src/public-assets.ts\npublic/\n", "if-no-files-found": "error" });

    const e2e = requireJob("e2e").steps ?? [];
    const download = e2e.findIndex(step => step.uses?.startsWith("actions/download-artifact@") && step.with?.name === "generated-assets");
    expect(download).toBeGreaterThanOrEqual(0);
    expect(e2e.findIndex(step => step.run === "scripts/ci-gate.sh e2e-pr")).toBeGreaterThan(download);
    expect(e2e.some(step => step.run === "scripts/ci-gate.sh assets")).toBe(false);
  });

  test("keeps fast checks independent of the broker build", () => {
    const checks = requireJob("checks");
    expect(checks.needs).toBeUndefined();
    const gates = (checks.steps ?? []).flatMap(step => step.run?.startsWith("scripts/ci-gate.sh ") ? [step.run.slice("scripts/ci-gate.sh ".length)] : []);
    expect(gates).toEqual(["context", "lint", "audit", "assets", "typecheck", "unit", "bundle"]);
  });
});
