import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const WORKER_PATH = join(import.meta.dir, "..", "..", "src", "ralph-macchio.ts");
const EXTRA_PATHS = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".cargo", "bin"),
  join(homedir(), ".bun", "bin"),
  join(homedir(), ".npm-global", "bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
];

interface WorkerRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

let tmpRoot: string;
let repoDir: string;
let fakeBinDir: string;
let fakeStatePath: string;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createFakeClaude(): void {
  const script = `#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const outputArgIndex = args.indexOf("--output-last-message");
const explicitOutputPath = outputArgIndex >= 0 ? args[outputArgIndex + 1] : undefined;
const joinedArgs = args.join("\\n");
const promptOutputPath = joinedArgs.match(/\\S+\\.ralph-response\\.json/)?.[0];
const responsePath = explicitOutputPath || promptOutputPath;
const statePath = process.env.FAKE_RALPH_STATE;
const sequence = JSON.parse(process.env.FAKE_RALPH_SEQUENCE || '["done"]');
const prior = statePath && existsSync(statePath) ? Number(readFileSync(statePath, "utf-8")) || 0 : 0;
const kind = sequence[Math.min(prior, sequence.length - 1)] || "done";
if (statePath) writeFileSync(statePath, String(prior + 1));

if (kind !== "missing") {
  if (!responsePath) throw new Error("fake agent could not find response path in args");
  mkdirSync(dirname(responsePath), { recursive: true });
  if (kind === "invalid") {
    writeFileSync(responsePath, "not json");
  } else if (kind === "needs_subtasks") {
    writeFileSync(responsePath, JSON.stringify({
      version: 1,
      status: "needs_subtasks",
      prereqs: ["fake prereq"],
      tests: ["fake test"],
      done: ["fake breakdown"],
      subtasks: ["implement parser regression", "wire worker regression"],
    }));
  } else {
    writeFileSync(responsePath, JSON.stringify({
      version: 1,
      status: "done",
      prereqs: ["fake prereq"],
      tests: ["fake test"],
      done: ["fake done"],
      subtasks: [],
    }));
  }
}

console.log(\`fake-agent-kind: \${kind}\`);
`;

  const fakeClaude = join(fakeBinDir, "claude");
  writeFileSync(fakeClaude, script, { mode: 0o755 });
}

function initRepo(planContent: string): void {
  repoDir = join(tmpRoot, "repo");
  execFileSync("mkdir", ["-p", repoDir]);
  git(repoDir, ["init"]);
  git(repoDir, ["config", "user.name", "Test"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["checkout", "-b", "main"]);
  writeFileSync(join(repoDir, "README.md"), "# test repo\n");
  writeFileSync(join(repoDir, "PLAN.md"), planContent);
  git(repoDir, ["add", "README.md", "PLAN.md"]);
  git(repoDir, ["commit", "-m", "initial"]);
}

function workerPathEnv(): string {
  const existing = process.env.PATH || "";
  const knownPaths = EXTRA_PATHS.filter(path => existsSync(path));
  return [fakeBinDir, ...knownPaths, existing].join(":");
}

function runWorker(sequence: readonly string[], extraArgs: readonly string[] = []): WorkerRunResult {
  writeFileSync(fakeStatePath, "0");
  const result = spawnSync("bun", [
    WORKER_PATH,
    "--plan", "PLAN.md",
    "--progress", "progress.txt",
    "--iterations", "1",
    "--agent", "claude",
    "--cleanup", "false",
    "--audit-fix", "false",
    "--sandbox", "false",
    ...extraArgs,
  ], {
    cwd: repoDir,
    env: {
      ...process.env,
      PATH: workerPathEnv(),
      FAKE_RALPH_STATE: fakeStatePath,
      FAKE_RALPH_SEQUENCE: JSON.stringify(sequence),
    },
    encoding: "utf-8",
    timeout: 20_000,
  });

  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function expectWorkerSuccess(result: WorkerRunResult): void {
  expect({ status: result.status, stderr: result.stderr, stdout: result.stdout }).toEqual({
    status: 0,
    stderr: "",
    stdout: "",
  });
}

function workdirFromLog(): string {
  const log = readFileSync(join(repoDir, ".ralph.log"), "utf-8");
  const match = log.match(/^workdir:\s*(.+)$/m);
  return match?.[1]?.trim() || repoDir;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "ralph-worker-response-"));
  fakeBinDir = join(tmpRoot, "bin");
  fakeStatePath = join(tmpRoot, "fake-agent-state.txt");
  execFileSync("mkdir", ["-p", fakeBinDir]);
  createFakeClaude();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ralph worker structured response contract", () => {
  test("done response marks the current task completed through the real worker loop", () => {
    initRepo("- [ ] ship structured response\n");

    const result = runWorker(["done"]);

    expectWorkerSuccess(result);
    const progress = readFileSync(join(repoDir, "progress.txt"), "utf-8");
    const log = readFileSync(join(repoDir, ".ralph.log"), "utf-8");
    expect(progress).toContain("DONE: checkbox: ship structured response");
    expect(log).toContain("all_tasks_done: true");
    expect(log).not.toContain("missing ralph response file");
    expect(existsSync(join(repoDir, ".ralph-response.json"))).toBe(false);
  });

  test("needs_subtasks response appends subtasks and marks the parent completed", () => {
    initRepo("- [ ] break down broad task\n");

    const result = runWorker(["needs_subtasks", "done", "done"]);

    expectWorkerSuccess(result);
    const plan = readFileSync(join(repoDir, "PLAN.md"), "utf-8");
    const progress = readFileSync(join(repoDir, "progress.txt"), "utf-8");
    expect(plan).toContain("- [ ] implement parser regression");
    expect(plan).toContain("- [ ] wire worker regression");
    expect(progress).toContain("DONE: checkbox: break down broad task");
    expect(progress).toContain("DONE: checkbox: implement parser regression");
    expect(progress).toContain("DONE: checkbox: wire worker regression");
  });

  test("missing response file leaves the task incomplete and logs a hard warning", () => {
    initRepo("- [ ] require explicit response file\n");

    const result = runWorker(["missing"]);

    expectWorkerSuccess(result);
    const progress = readFileSync(join(repoDir, "progress.txt"), "utf-8");
    const log = readFileSync(join(repoDir, ".ralph.log"), "utf-8");
    expect(progress).not.toContain("DONE: checkbox: require explicit response file");
    expect(log).toContain("Iteration did not complete: missing ralph response file");
  });

  test("plan worktree mode reads response from the active worktree and excludes runner transients from git", () => {
    initRepo("- [ ] complete from plan worktree\n");

    const result = runWorker(["done"], ["--worktree", "plan"]);

    expectWorkerSuccess(result);
    const workdir = workdirFromLog();
    const progress = readFileSync(join(workdir, "progress.txt"), "utf-8");
    expect(progress).toContain("DONE: checkbox: complete from plan worktree");
    expect(workdir).not.toBe(repoDir);

    writeFileSync(join(workdir, ".ralph-response.json"), "{}\n");
    writeFileSync(join(workdir, ".ralph-response-schema-123.json"), "{}\n");
    writeFileSync(join(workdir, ".ralph-srt-settings-123.json"), "{}\n");
    writeFileSync(join(workdir, ".ralph_iter.tmp"), "tmp\n");
    writeFileSync(join(workdir, "progress.txt"), progress);
    writeFileSync(join(workdir, "feature.ts"), "export const covered = true;\n");

    git(workdir, ["add", "-A"]);
    const staged = git(workdir, ["diff", "--cached", "--name-only"]);
    expect(staged).toContain("feature.ts");
    expect(staged).not.toContain(".ralph-response.json");
    expect(staged).not.toContain(".ralph-response-schema-123.json");
    expect(staged).not.toContain(".ralph-srt-settings-123.json");
    expect(staged).not.toContain(".ralph_iter.tmp");
    expect(staged).not.toContain("progress.txt");

  });
});
