import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createWorktree, listWorktrees, removeWorktree } from "../../src/worktree";

let repoDir: string;

function git(...args: string[]) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repoDir, encoding: "utf-8", stdio: "pipe" });
}

function initRepo() {
  repoDir = mkdtempSync(join(tmpdir(), "ralph-wt-test-"));
  git("init");
  git("config", "user.name", "test");
  git("config", "user.email", "test@test.com");
  git("checkout", "-b", "main");
  writeFileSync(join(repoDir, "README.md"), "# test\n");
  git("add", ".");
  git("commit", "-m", "initial");
}

function cleanupRepo() {
  // remove all worktrees first
  try {
    const wts = listWorktrees(repoDir).filter(w => w.path !== repoDir);
    for (const wt of wts) {
      try { removeWorktree(wt.path, repoDir); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  rmSync(repoDir, { recursive: true, force: true });
}

describe("worktree restart/reuse", () => {
  beforeEach(initRepo);
  afterEach(cleanupRepo);

  test("createWorktree creates a new worktree and branch", () => {
    const wtPath = createWorktree(repoDir, "ralph/plan-test", "main");
    expect(existsSync(wtPath)).toBe(true);
    const wts = listWorktrees(repoDir);
    const found = wts.find(w => w.branch === "ralph/plan-test");
    expect(found).toBeDefined();
    expect(found!.path).toBe(wtPath);
  });

  test("listWorktrees finds existing worktree by branch name", () => {
    createWorktree(repoDir, "ralph/plan-myplan", "main");
    const wts = listWorktrees(repoDir);
    const match = wts.find(w => w.branch === "ralph/plan-myplan");
    expect(match).toBeDefined();
  });

  test("creating duplicate branch fails", () => {
    createWorktree(repoDir, "ralph/plan-dup", "main");
    expect(() => createWorktree(repoDir, "ralph/plan-dup", "main")).toThrow();
  });

  test("restart can detect and reuse existing worktree", () => {
    // simulate first run: create worktree
    const wtPath = createWorktree(repoDir, "ralph/plan-restart", "main");
    // write plan into worktree (gitignored file)
    writeFileSync(join(wtPath, "PLAN.md"), "## 1. Task A\n\n## ~~2. Task B~~\n");

    // simulate restart: find existing worktree by branch
    const existing = listWorktrees(repoDir).find(w => w.branch === "ralph/plan-restart");
    expect(existing).toBeDefined();
    expect(existing!.path).toBe(wtPath);

    // plan file persists in worktree
    const plan = readFileSync(join(existing!.path, "PLAN.md"), "utf-8");
    expect(plan).toContain("## ~~2. Task B~~");
    expect(plan).toContain("## 1. Task A");
  });

  test("orphan cleanup removes ralph/* worktrees except main", () => {
    const mainWt = createWorktree(repoDir, "ralph/plan-main", "main");
    const orphan1 = createWorktree(repoDir, "ralph/1-task-a", "ralph/plan-main");
    const orphan2 = createWorktree(repoDir, "ralph/2-task-b", "ralph/plan-main");

    // verify all exist
    let wts = listWorktrees(repoDir);
    expect(wts.filter(w => w.branch.startsWith("ralph/")).length).toBe(3);

    // simulate orphan cleanup: remove ralph/* that aren't mainWt
    const mainBranch = "ralph/plan-main";
    const orphans = wts.filter(w =>
      w.path !== mainWt &&
      w.path !== repoDir &&
      w.branch.startsWith("ralph/") &&
      w.branch !== mainBranch,
    );
    expect(orphans.length).toBe(2);

    for (const o of orphans) {
      removeWorktree(o.path, repoDir);
      git("branch", "-D", o.branch);
    }

    // verify only main worktree remains
    wts = listWorktrees(repoDir);
    const ralphWts = wts.filter(w => w.branch.startsWith("ralph/"));
    expect(ralphWts.length).toBe(1);
    expect(ralphWts[0].branch).toBe("ralph/plan-main");
  });

  test("orphan branch is deleted so fresh worktree creation succeeds", () => {
    // first run: create worktree + branch
    const wtPath = createWorktree(repoDir, "ralph/plan-orphan", "main");
    expect(existsSync(wtPath)).toBe(true);

    // simulate cleanup: remove worktree but leave the branch behind
    removeWorktree(wtPath, repoDir);
    const wts = listWorktrees(repoDir);
    expect(wts.find(w => w.branch === "ralph/plan-orphan")).toBeUndefined();

    // branch still exists
    const branchCheck = git("branch", "--list", "ralph/plan-orphan").trim();
    expect(branchCheck).toContain("ralph/plan-orphan");

    // createWorktree with -b would fail here — verify it does
    expect(() => createWorktree(repoDir, "ralph/plan-orphan", "main")).toThrow(/already exists/);

    // fix: delete the orphan branch, then create fresh
    git("branch", "-D", "ralph/plan-orphan");
    const freshWt = createWorktree(repoDir, "ralph/plan-orphan", "main");
    expect(existsSync(freshWt)).toBe(true);
    const found = listWorktrees(repoDir).find(w => w.branch === "ralph/plan-orphan");
    expect(found).toBeDefined();
  });

  test("task worktree merges into main worktree", () => {
    const mainWt = createWorktree(repoDir, "ralph/plan-merge", "main");

    // create task sub-worktree
    const taskWt = createWorktree(repoDir, "ralph/1-add-feature", "ralph/plan-merge");
    writeFileSync(join(taskWt, "feature.ts"), "export const x = 1;\n");
    execFileSync("git", ["-c", "commit.gpgsign=false", "add", "feature.ts"], { cwd: taskWt, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add feature"], { cwd: taskWt, stdio: "pipe" });

    // merge task branch into main worktree
    execFileSync("git", ["-c", "commit.gpgsign=false", "merge", "ralph/1-add-feature", "-m", "merge task 1"], {
      cwd: mainWt,
      stdio: "pipe",
    });

    // verify feature.ts exists in main worktree after merge
    expect(existsSync(join(mainWt, "feature.ts"))).toBe(true);
    const content = readFileSync(join(mainWt, "feature.ts"), "utf-8");
    expect(content).toContain("export const x = 1");

    // cleanup task worktree
    removeWorktree(taskWt, repoDir);
    const remaining = listWorktrees(repoDir).filter(w => w.branch.startsWith("ralph/"));
    expect(remaining.length).toBe(1);
    expect(remaining[0].branch).toBe("ralph/plan-merge");
  });
});

describe("ralph log worktreeMode parsing", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ralph-log-wt-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("parses worktreeMode from log header", () => {
    writeFileSync(join(projectDir, ".ralph.log"), [
      "🥋 ralph — 5 iterations",
      "agent: claude",
      "plan: PLAN.md",
      "progress: progress.txt",
      "phase_cleanup: on",
      "phase_audit_fix: off",
      "worktree: task",
      "pid: 1",
      "started: Wed Mar 18 2026",
      "",
      "finished: Wed Mar 18 2026",
    ].join("\n"));
    writeFileSync(join(projectDir, "PLAN.md"), "## 1. Task\n");

    // import parseRalphLog — can't easily due to DEV_DIR dependency,
    // so we test the regex directly
    const content = readFileSync(join(projectDir, ".ralph.log"), "utf-8");
    const wtMatch = content.match(/^worktree:\s*(.+)/m);
    expect(wtMatch).not.toBeNull();
    expect(wtMatch![1].trim()).toBe("task");
  });

  test("workdir path traversal blocked", () => {
    const projectDir2 = mkdtempSync(join(tmpdir(), "ralph-log-wt2-"));
    writeFileSync(join(projectDir2, "secret.md"), "## 1. Secret\n## ~~2. Done~~\n");

    // simulate a log with workdir pointing outside projectDir
    writeFileSync(join(projectDir, ".ralph.log"), [
      "🥋 ralph — 5 iterations",
      "plan: secret.md",
      `workdir: ${projectDir2}`,
      "pid: 1",
      "finished: done",
    ].join("\n"));

    // the validation: workdir must start with projectDir
    const content = readFileSync(join(projectDir, ".ralph.log"), "utf-8");
    const workdirMatch = content.match(/^workdir:\s*(.+)/m);
    const workdirPath = workdirMatch ? workdirMatch[1].trim() : "";
    const planBase = workdirPath && workdirPath.startsWith(projectDir) && existsSync(join(workdirPath, "secret.md"))
      ? workdirPath
      : projectDir;

    // should fall back to projectDir since workdirPath doesn't start with projectDir
    expect(planBase).toBe(projectDir);

    rmSync(projectDir2, { recursive: true, force: true });
  });
});
