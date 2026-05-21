import { describe, expect, test, beforeAll, afterAll, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  slugifyTaskName,
  createWorktree,
  removeWorktree,
  listWorktrees,
  cleanupAllExceptFinal,
} from "../../src/worktree.js";

// ── slugifyTaskName tests ──

describe("slugifyTaskName", () => {
  test("extracts title from numbered header", () => {
    expect(slugifyTaskName("## 1. Add auth middleware")).toBe(
      "add-auth-middleware",
    );
  });

  test("handles multi-digit task numbers", () => {
    expect(slugifyTaskName("## 12. Deploy to production")).toBe(
      "deploy-to-production",
    );
  });

  test("lowercases and kebab-cases", () => {
    expect(slugifyTaskName("## 3. Write Unit Tests")).toBe("write-unit-tests");
  });

  test("strips special characters", () => {
    expect(slugifyTaskName("## 1. Add API (v2) & docs!")).toBe(
      "add-api-v2-docs",
    );
  });

  test("truncates to 40 chars", () => {
    const long =
      "## 1. This is a very long task name that should definitely be truncated at forty characters";
    const result = slugifyTaskName(long);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toBe(
      "this-is-a-very-long-task-name-that-shoul",
    );
  });

  test("strips trailing hyphens after truncation", () => {
    // 40-char truncation might land mid-word leaving a trailing hyphen
    const header = "## 1. aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbb";
    const result = slugifyTaskName(header);
    expect(result).not.toMatch(/-$/);
  });

  test("handles plain string without header prefix", () => {
    expect(slugifyTaskName("Some task title")).toBe("some-task-title");
  });

  test("handles extra whitespace", () => {
    expect(slugifyTaskName("##  5.   Trim   spaces  ")).toBe("trim-spaces");
  });
});

// ── worktree lifecycle tests (require a real git repo) ──

describe("worktree lifecycle", () => {
  let repoDir: string;

  beforeAll(() => {
    // Create a temp git repo with an initial commit
    repoDir = realpathSync(mkdtempSync(join(tmpdir(), "wt-test-")));
    execFileSync("git", ["init", repoDir], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "test"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@test.com"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "config", "commit.gpgsign", "false"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "init"], {
      stdio: "pipe",
    });
  });

  afterAll(() => {
    // Clean up all worktrees first, then remove temp dir
    try {
      const wts = listWorktrees(repoDir);
      for (const wt of wts) {
        if (wt.path !== repoDir) {
          try { removeWorktree(wt.path, repoDir); } catch { /* already removed */ }
        }
      }
    } catch { /* best effort */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("createWorktree creates a worktree and returns path", () => {
    const wtPath = createWorktree(repoDir, "ralph/1-test-task", "HEAD");
    expect(wtPath).toContain(".worktrees/1-test-task");

    const wts = listWorktrees(repoDir);
    const found = wts.find((w) => w.branch === "ralph/1-test-task");
    expect(found).toBeDefined();

    // Cleanup
    removeWorktree(wtPath, repoDir);
  });

  test("listWorktrees returns main worktree", () => {
    const wts = listWorktrees(repoDir);
    expect(wts.length).toBeGreaterThanOrEqual(1);
    expect(wts[0].path).toBe(repoDir);
  });

  test("removeWorktree removes a worktree", () => {
    const wtPath = createWorktree(repoDir, "ralph/2-remove-me", "HEAD");
    removeWorktree(wtPath, repoDir);

    const wts = listWorktrees(repoDir);
    const found = wts.find((w) => w.branch === "ralph/2-remove-me");
    expect(found).toBeUndefined();
  });

  test("cleanupAllExceptFinal keeps only the last worktree", () => {
    createWorktree(repoDir, "ralph/3-first", "HEAD");
    createWorktree(repoDir, "ralph/4-second", "HEAD");
    createWorktree(repoDir, "ralph/5-third", "HEAD");

    const result = cleanupAllExceptFinal(repoDir);

    expect(result.removed).toContain("ralph/3-first");
    expect(result.removed).toContain("ralph/4-second");
    expect(result.kept).toBe("ralph/5-third");

    // Only main + final worktree should remain
    const wts = listWorktrees(repoDir);
    const managedWts = wts.filter((w) => w.path !== repoDir);
    expect(managedWts.length).toBe(1);
    expect(managedWts[0].branch).toBe("ralph/5-third");

    // Cleanup
    removeWorktree(managedWts[0].path, repoDir);
  });

  test("cleanupAllExceptFinal with no managed worktrees returns empty", () => {
    const result = cleanupAllExceptFinal(repoDir);
    expect(result.removed).toEqual([]);
    expect(result.kept).toBe("");
  });

  test("cleanupAllExceptFinal keeps numerically highest worktree (10 > 9)", () => {
    createWorktree(repoDir, "ralph/9-early", "HEAD");
    createWorktree(repoDir, "ralph/10-final", "HEAD");

    const result = cleanupAllExceptFinal(repoDir);

    expect(result.removed).toContain("ralph/9-early");
    expect(result.kept).toBe("ralph/10-final");

    // Cleanup
    const wts = listWorktrees(repoDir);
    for (const wt of wts) {
      if (wt.path !== repoDir) {
        try { removeWorktree(wt.path, repoDir); } catch {}
      }
    }
  });

  test("cleanupAllExceptFinal ignores legacy .wolfpack/worktrees entries", () => {
    const legacyPath = join(repoDir, ".wolfpack", "worktrees", "19-legacy");
    execFileSync(
      "git",
      ["worktree", "add", legacyPath, "-b", "ralph/19-legacy", "--", "HEAD"],
      { cwd: repoDir, stdio: "pipe" },
    );
    const orderFile = join(repoDir, ".wolfpack", "worktree-order.txt");
    appendFileSync(orderFile, `${legacyPath}\n`);
    createWorktree(repoDir, "ralph/20-new", "HEAD");

    const result = cleanupAllExceptFinal(repoDir);

    expect(result.removed).not.toContain("ralph/19-legacy");
    expect(result.kept).toBe("ralph/20-new");

    const wts = listWorktrees(repoDir);
    const legacy = wts.find((w) => w.branch === "ralph/19-legacy");
    expect(legacy?.path).toBe(legacyPath);
    const kept = wts.find((w) => w.branch === "ralph/20-new");
    expect(kept?.path).toContain(".worktrees/20-new");

    // Cleanup
    if (kept) removeWorktree(kept.path, repoDir);
    if (legacy) removeWorktree(legacy.path, repoDir);
  });

  test("createWorktree tracks creation order in worktree-order.txt", () => {
    createWorktree(repoDir, "ralph/20-first", "HEAD");
    createWorktree(repoDir, "ralph/21-second", "HEAD");

    const orderFile = join(repoDir, ".wolfpack", "worktree-order.txt");
    expect(existsSync(orderFile)).toBe(true);
    const lines = readFileSync(orderFile, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[lines.length - 2]).toContain("20-first");
    expect(lines[lines.length - 1]).toContain("21-second");

    // Cleanup
    const wts = listWorktrees(repoDir);
    for (const wt of wts) {
      if (wt.path !== repoDir) {
        try { removeWorktree(wt.path, repoDir); } catch {}
      }
    }
  });

  test("plan file can be copied into worktree for agent access", () => {
    // Simulate plan file in project root
    const planContent = "## 1. Add auth\n## 2. Write tests\n";
    writeFileSync(join(repoDir, "PLAN.md"), planContent);

    const wtPath = createWorktree(repoDir, "ralph/30-plan-copy", "HEAD");

    // Copy plan into worktree (as ralph-macchio does via syncFilesToWorktree)
    copyFileSync(join(repoDir, "PLAN.md"), join(wtPath, "PLAN.md"));

    expect(existsSync(join(wtPath, "PLAN.md"))).toBe(true);
    expect(readFileSync(join(wtPath, "PLAN.md"), "utf-8")).toBe(planContent);

    // Cleanup
    removeWorktree(wtPath, repoDir);
  });

  test("removeWorktree tries graceful removal before force", () => {
    const wtPath = createWorktree(repoDir, "ralph/31-graceful", "HEAD");

    // No uncommitted changes — should succeed without --force
    removeWorktree(wtPath, repoDir);

    const wts = listWorktrees(repoDir);
    expect(wts.find(w => w.branch === "ralph/31-graceful")).toBeUndefined();
  });

  test("removeWorktree logs a warning when it falls back to --force", () => {
    const wtPath = createWorktree(repoDir, "ralph/32-force", "HEAD");
    writeFileSync(join(wtPath, "DIRTY.txt"), "unsaved work\n", "utf-8");

    const logs: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      logs.push(String(chunk));
      return true;
    });
    try {
      removeWorktree(wtPath, repoDir);
    } finally {
      spy.mockRestore();
    }

    expect(logs.join("")).toContain("removeWorktree: graceful remove failed; forcing worktree removal");
    const wts = listWorktrees(repoDir);
    expect(wts.find(w => w.branch === "ralph/32-force")).toBeUndefined();
  });
});
