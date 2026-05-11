/**
 * Worktree lifecycle utilities for ralph task isolation.
 *
 * Each task (or plan) gets its own git worktree under .wolfpack/worktrees/,
 * allowing concurrent agents to work without file conflicts.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { realpathSync, existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { createLogger, errMsg } from "./log.js";

const log = createLogger("worktree");

let _cleanupInProgress = false;

/** Test helper — returns true if a cleanup is currently running. */
export function _isCleanupInProgress(): boolean { return _cleanupInProgress; }

const WORKTREE_DIR = ".wolfpack/worktrees";
const WORKTREE_ORDER_FILE = ".wolfpack/worktree-order.txt";

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  bare: boolean;
}

/**
 * Extract task title from a `## N. Title` header, lowercase, kebab-case,
 * truncated to 40 chars.
 */
export function slugifyTaskName(header: string): string {
  const match = header.match(/^##\s*\d+\.\s*(.+)/);
  const title = match ? match[1].trim() : header.trim();
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/**
 * Create a git worktree at .wolfpack/worktrees/<slug> on a new branch.
 * Returns the absolute worktree path.
 */
export function createWorktree(
  projectDir: string,
  branchName: string,
  baseBranch: string,
): string {
  const slug = branchName.replace(/^ralph\//, "").replace(/[^a-z0-9-]/g, "-");
  const realProjectDir = realpathSync(projectDir);
  const worktreePath = join(realProjectDir, WORKTREE_DIR, slug);
  execFileSync(
    "git",
    ["worktree", "add", worktreePath, "-b", branchName, "--", baseBranch],
    { cwd: realProjectDir, stdio: "pipe" },
  );
  // Track creation order so cleanup can reliably identify the final worktree
  const orderFile = join(realProjectDir, WORKTREE_ORDER_FILE);
  try {
    mkdirSync(join(realProjectDir, ".wolfpack"), { recursive: true });
    appendFileSync(orderFile, `${worktreePath}\n`);
  } catch (e: unknown) {
    // Worktree was created successfully — don't roll back, just warn
    log.warn("createWorktree: failed to write order file", { worktreePath, error: errMsg(e) });
  }
  return worktreePath;
}

/**
 * Remove a git worktree by path.
 * Uses --force which discards uncommitted changes — caller should be aware.
 */
export function removeWorktree(worktreePath: string, projectDir?: string): void {
  const cwd = projectDir ? realpathSync(projectDir) : undefined;
  const opts = cwd ? { cwd, stdio: "pipe" as const } : { stdio: "pipe" as const };
  // Try graceful removal first; fall back to --force if there are uncommitted changes
  try {
    execFileSync("git", ["worktree", "remove", worktreePath], opts);
  } catch (gracefulErr: any) {
    log.warn("removeWorktree: graceful remove failed; forcing worktree removal (uncommitted changes may be lost)", {
      worktreePath,
      error: errMsg(gracefulErr),
    });
    try {
      execFileSync("git", ["worktree", "remove", worktreePath, "--force"], opts);
    } catch (forceErr: any) {
      throw new Error(
        `failed to remove worktree ${worktreePath}: ${forceErr?.message ?? gracefulErr?.message ?? "unknown error"}`,
      );
    }
  }
}

/**
 * Best-effort directory mtime; returns 0 if stat fails so the caller's
 * sort treats inaccessible entries as oldest. Used as the L6 fallback
 * for cleanupAllExceptFinal when the explicit order file is unavailable.
 */
function mtimeOrZero(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

/**
 * Parse `git worktree list --porcelain` output into WorktreeInfo entries.
 * Exported for testing — callers should use listWorktrees() instead.
 */
export function parsePorcelainWorktrees(output: string): WorktreeInfo[] {
  const entries: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "") {
      if (current.path) {
        entries.push({
          path: current.path,
          branch: current.branch ?? "",
          head: current.head ?? "",
          bare: current.bare ?? false,
        });
      }
      current = {};
    }
  }

  // Flush final section if output lacks a trailing newline
  if (current.path) {
    entries.push({
      path: current.path,
      branch: current.branch ?? "",
      head: current.head ?? "",
      bare: current.bare ?? false,
    });
  }

  return entries;
}

/**
 * List all git worktrees for the repo at projectDir.
 */
export function listWorktrees(projectDir: string): WorktreeInfo[] {
  const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: realpathSync(projectDir),
    encoding: "utf-8",
  });
  return parsePorcelainWorktrees(output);
}

/**
 * Remove all worktrees under .wolfpack/worktrees/ except the last one
 * (by numeric-aware sort of directory name, so task 10 sorts after task 9).
 */
export function cleanupAllExceptFinal(
  projectDir: string,
): { removed: string[]; kept: string } {
  if (_cleanupInProgress) return { removed: [], kept: "" };
  _cleanupInProgress = true;
  try {
    return _cleanupAllExceptFinalImpl(projectDir);
  } finally {
    _cleanupInProgress = false;
  }
}

function _cleanupAllExceptFinalImpl(
  projectDir: string,
): { removed: string[]; kept: string } {
  const realProjectDir = realpathSync(projectDir);
  const worktrees = listWorktrees(realProjectDir);
  const wtDir = join(realProjectDir, WORKTREE_DIR);

  const managed = worktrees.filter((w) => w.path.startsWith(wtDir));

  if (managed.length === 0) {
    return { removed: [], kept: "" };
  }

  // Use creation-order file if available (written by createWorktree),
  // fall back to numeric path sort
  const orderFile = join(realProjectDir, WORKTREE_ORDER_FILE);
  let orderedPaths: string[] | null = null;
  try {
    if (existsSync(orderFile)) {
      orderedPaths = readFileSync(orderFile, "utf-8").trim().split("\n").filter(Boolean);
    }
  } catch (e: unknown) {
    log.warn("cleanupAllExceptFinal: failed to read worktree order file", { error: errMsg(e) });
  }

  if (orderedPaths && orderedPaths.length > 0) {
    // Order managed worktrees by creation order
    const pathOrder = new Map(orderedPaths.map((p, i) => [p, i]));
    // Unrecorded worktrees sort after all recorded ones, ordered by mtime
    // (see fallback below for why mtime beats path sort).
    managed.sort((a, b) => {
      const aInOrder = pathOrder.has(a.path);
      const bInOrder = pathOrder.has(b.path);
      if (aInOrder && bInOrder) return pathOrder.get(a.path)! - pathOrder.get(b.path)!;
      if (aInOrder && !bInOrder) return -1;
      if (!aInOrder && bInOrder) return 1;
      return mtimeOrZero(a.path) - mtimeOrZero(b.path);
    });
  } else {
    // Fallback when the order file is missing or unreadable (issues.md L6):
    // sort by directory mtime instead of numeric path sort. Path sort
    // breaks when slug names collide and get timestamp suffixes — the
    // "final" worktree picked for preservation may not be the most recent
    // and `cleanupAllExceptFinal` would discard the latest agent work.
    // mtime is creation-time-ish (writes during the agent run keep the
    // most recent worktree's directory mtime newest).
    log.warn("cleanupAllExceptFinal: worktree-order file missing or empty; falling back to mtime sort", { orderFile });
    managed.sort((a, b) => mtimeOrZero(a.path) - mtimeOrZero(b.path));
  }

  const final = managed[managed.length - 1];
  const toRemove = managed.slice(0, -1);

  const removed: string[] = [];
  for (const wt of toRemove) {
    try {
      removeWorktree(wt.path, realProjectDir);
      removed.push(wt.branch);
    } catch (e: unknown) {
      log.warn("failed to remove worktree, continuing cleanup", { path: wt.path, branch: wt.branch, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Prune stale worktree refs and clean up order file
  execFileSync("git", ["worktree", "prune"], {
    cwd: realProjectDir,
    stdio: "pipe",
  });
  try { writeFileSync(orderFile, `${final.path}\n`); } catch (e: unknown) {
    log.warn("cleanupAllExceptFinal: failed to update order file", { error: errMsg(e) });
  }

  return { removed, kept: final.branch };
}
