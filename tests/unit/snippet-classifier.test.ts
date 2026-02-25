import { describe, expect, test } from "bun:test";
import { classifySnippets, type Snippet } from "../../snippet-classifier";

/** Helper: extract just the command strings from results */
function cmds(pane: string): string[] {
  return classifySnippets(pane).map((s) => s.command);
}

// ── npm errors ──

describe("snippet classifier — npm", () => {
  test("npm ERR! suggests npm ci and npm install", () => {
    const out = cmds("npm ERR! code ELIFECYCLE\nnpm ERR! errno 1");
    expect(out).toContain("npm ci");
    expect(out).toContain("npm install");
  });

  test("npm warn / ERESOLVE suggests --force", () => {
    expect(cmds("npm warn ERESOLVE overriding peer dependency")).toContain(
      "npm install --force"
    );
  });

  test("Cannot find module suggests install", () => {
    const out = cmds(
      "Error: Cannot find module 'express'\nRequire stack:\n- /app/index.js"
    );
    expect(out).toContain("npm install");
    expect(out).toContain("bun install");
  });
});

// ── bun errors ──

describe("snippet classifier — bun", () => {
  test("bun install error suggests bun install", () => {
    expect(cmds("error: bun install failed")).toContain("bun install");
  });

  test("ModuleNotFound suggests bun install", () => {
    expect(cmds("ModuleNotFound: can't resolve 'zod'")).toContain(
      "bun install"
    );
  });

  test("bun.lockb reference suggests install", () => {
    expect(cmds("error reading bun.lockb")).toContain("bun install");
  });
});

// ── git conflicts ──

describe("snippet classifier — git conflicts", () => {
  test("CONFLICT marker suggests git status + git diff", () => {
    const out = cmds("CONFLICT (content): Merge conflict in src/index.ts");
    expect(out).toContain("git status");
    expect(out).toContain("git diff");
  });

  test("both modified suggests status + diff", () => {
    const out = cmds("both modified:   package.json");
    expect(out).toContain("git status");
  });

  test("unmerged paths suggests status + diff + abort", () => {
    const out = cmds(
      "error: You have unmerged paths.\nhint: fix conflicts and run git commit"
    );
    expect(out).toContain("git status");
    expect(out).toContain("git diff");
    expect(out).toContain("git merge --abort");
  });

  test("rebase in progress suggests continue + abort", () => {
    const out = cmds("interactive rebase in progress; onto abc1234");
    expect(out).toContain("git rebase --continue");
    expect(out).toContain("git rebase --abort");
  });
});

// ── git push/pull ──

describe("snippet classifier — git push/pull", () => {
  test("push rejected suggests pull", () => {
    const out = cmds(
      "! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs"
    );
    expect(out).toContain("git pull");
    expect(out).toContain("git pull --rebase");
  });

  test("branch behind suggests pull", () => {
    expect(
      cmds("Your branch is behind 'origin/main' by 3 commits")
    ).toContain("git pull");
  });

  test("not a git repository", () => {
    expect(
      cmds("fatal: not a git repository (or any parent)")
    ).toContain("git init");
  });
});

// ── python errors ──

describe("snippet classifier — python", () => {
  test("ModuleNotFoundError suggests pip install", () => {
    expect(
      cmds("ModuleNotFoundError: No module named 'requests'")
    ).toContain("pip install");
  });

  test("ImportError suggests pip install -r", () => {
    expect(cmds("ImportError: cannot import name 'Flask'")).toContain(
      "pip install -r requirements.txt"
    );
  });

  test("venv not found suggests create venv", () => {
    expect(cmds("No such file or directory: './venv/bin/python'")).toContain(
      "python -m venv venv"
    );
  });
});

// ── permission denied ──

describe("snippet classifier — permission denied", () => {
  test("Permission denied suggests sudo + chmod", () => {
    const out = cmds("bash: ./deploy.sh: Permission denied");
    expect(out).toContain("sudo !!");
    expect(out).toContain("chmod +x ");
  });

  test("EACCES suggests sudo", () => {
    expect(cmds("Error: EACCES: permission denied, open '/etc/hosts'")).toContain(
      "sudo !!"
    );
  });
});

// ── docker ──

describe("snippet classifier — docker", () => {
  test("docker daemon not running", () => {
    expect(
      cmds("Cannot connect to the Docker daemon at unix:///var/run/docker.sock")
    ).toContain("docker info");
  });

  test("no such container", () => {
    expect(cmds("Error: No such container: myapp")).toContain("docker ps -a");
  });
});

// ── rust / cargo ──

describe("snippet classifier — rust", () => {
  test("error[E0308] suggests cargo check + build", () => {
    const out = cmds("error[E0308]: mismatched types");
    expect(out).toContain("cargo check");
    expect(out).toContain("cargo build");
  });
});

// ── typescript ──

describe("snippet classifier — typescript", () => {
  test("TS error code suggests tsc", () => {
    expect(cmds("src/app.ts(12,5): error TS2322: Type")).toContain(
      "npx tsc --noEmit"
    );
  });
});

// ── port in use ──

describe("snippet classifier — port in use", () => {
  test("EADDRINUSE suggests lsof", () => {
    expect(cmds("Error: listen EADDRINUSE: address already in use :::3000")).toContain(
      "lsof -i :"
    );
  });
});

// ── disk / memory ──

describe("snippet classifier — system resources", () => {
  test("no space left suggests df -h", () => {
    expect(cmds("ENOSPC: no space left on device")).toContain("df -h");
  });

  test("out of memory suggests free -h", () => {
    expect(
      cmds("FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory")
    ).toContain("free -h");
  });
});

// ── test failures ──

describe("snippet classifier — test failures", () => {
  test("N tests failed suggests rerun", () => {
    expect(cmds("23 tests failed")).toContain("bun test");
  });

  test("FAILED test suggests rerun", () => {
    expect(cmds("FAILED tests/unit/foo.test.ts")).toContain("bun test");
  });
});

// ── behavior: scanning, dedup, limits ──

describe("snippet classifier — behavior", () => {
  test("empty input returns empty", () => {
    expect(classifySnippets("")).toEqual([]);
  });

  test("no matching pattern returns empty", () => {
    expect(classifySnippets("$ echo hello\nhello")).toEqual([]);
  });

  test("returns at most max snippets", () => {
    // Trigger multiple rules at once
    const pane =
      "npm ERR! code ELIFECYCLE\nPermission denied\nCONFLICT (content): in file.ts";
    const result = classifySnippets(pane, 3);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  test("deduplicates commands across rules", () => {
    // Both npm rules would suggest npm install
    const pane = "npm ERR! foo\nCannot find module 'bar'";
    const commands = cmds(pane);
    const unique = [...new Set(commands)];
    expect(commands.length).toBe(unique.length);
  });

  test("only scans last 20 lines", () => {
    const noise = Array(25).fill("all good").join("\n");
    const pane = "npm ERR! something\n" + noise;
    expect(classifySnippets(pane)).toEqual([]);
  });

  test("error in last 20 lines IS detected", () => {
    const noise = Array(15).fill("all good").join("\n");
    const pane = noise + "\nnpm ERR! something";
    expect(cmds(pane)).toContain("npm ci");
  });

  test("result shape has label and command", () => {
    const result = classifySnippets("npm ERR! code ENOENT");
    expect(result.length).toBeGreaterThan(0);
    for (const s of result) {
      expect(typeof s.label).toBe("string");
      expect(typeof s.command).toBe("string");
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.command.length).toBeGreaterThan(0);
    }
  });
});

// ── negative matches: normal output should not trigger ──

describe("snippet classifier — negative matches", () => {
  test("successful npm install", () => {
    expect(classifySnippets("added 42 packages in 3s")).toEqual([]);
  });

  test("successful build", () => {
    expect(classifySnippets("Build completed successfully")).toEqual([]);
  });

  test("normal git output", () => {
    expect(
      classifySnippets("On branch main\nnothing to commit, working tree clean")
    ).toEqual([]);
  });

  test("passing tests", () => {
    expect(classifySnippets("✓ All 42 tests passed")).toEqual([]);
  });

  test("generic log line with 'error' in different context", () => {
    // "error" appears in a log level, not as a crash pattern
    expect(classifySnippets("2024-01-01 [INFO] processed 0 errors")).toEqual(
      []
    );
  });
});
