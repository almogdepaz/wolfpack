import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RALPH_AGENT_CONTEXT } from "../../../src/wolfpack-context.ts";
import { buildPrompt, runTaskLoop } from "../../../src/kobra-kai/task-runner.ts";
import type { AgentSpawnConfig } from "../../../src/shared/task-iteration.ts";

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------

describe("buildPrompt", () => {
  test("includes RALPH_AGENT_CONTEXT", () => {
    const result = buildPrompt("ctx", "do the thing", "/tmp/wt");
    expect(result).toContain(RALPH_AGENT_CONTEXT);
  });

  test("includes project context", () => {
    const result = buildPrompt("Branch: main\nRecent commits: abc", "task", "/tmp/wt");
    expect(result).toContain("## Project Context");
    expect(result).toContain("Branch: main");
    expect(result).toContain("Recent commits: abc");
  });

  test("includes task description", () => {
    const result = buildPrompt("ctx", "Add authentication middleware", "/tmp/wt");
    expect(result).toContain("YOUR TASK:");
    expect(result).toContain("Add authentication middleware");
  });

  test("includes worktree path in sandbox rule", () => {
    const result = buildPrompt("ctx", "task", "/workspace/my-wt");
    expect(result).toContain("You may ONLY create/edit/delete files under /workspace/my-wt");
  });

  test("includes subtask and focus rules", () => {
    const result = buildPrompt("ctx", "task", "/tmp/wt");
    expect(result).toContain("<subtasks>");
    expect(result).toContain("ONLY work on ONE task per iteration");
    expect(result).toContain("Do NOT remove or renumber tasks");
    expect(result).toContain("BEGIN.");
  });
});

// ---------------------------------------------------------------------------
// runTaskLoop — integration tests with mock agent
// ---------------------------------------------------------------------------

describe("runTaskLoop", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "task-runner-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  function makeMockAgent(responses: Array<{ exitCode: number; output: string }>): AgentSpawnConfig {
    let callIdx = 0;
    return {
      bin: "echo",
      args: (prompt) => {
        const resp = responses[callIdx] || { exitCode: 0, output: "" };
        callIdx++;
        // We use a script that outputs the predetermined response
        return [resp.output];
      },
    };
  }

  // For integration tests, we need to mock runAgentIteration since it spawns real processes.
  // Instead, we test the flow using real plan files and a real agent that just echos output.

  test("exits when plan has no tasks", async () => {
    writeFileSync(join(dir, "PLAN.md"), "# Plan\nNothing to do here\n");

    const agent: AgentSpawnConfig = {
      bin: "echo",
      args: () => ["done"],
    };

    await runTaskLoop(dir, 5, agent, "test context");

    const log = readFileSync(join(dir, ".kobra-kai.log"), "utf-8");
    expect(log).toContain("no remaining tasks");
  });

  test("marks checkbox task done after successful agent run", async () => {
    writeFileSync(join(dir, "PLAN.md"), "# Plan\n- [ ] Create hello.ts\n- [ ] Create world.ts\n");

    // Agent that just succeeds with no subtasks output
    const agent: AgentSpawnConfig = {
      bin: "echo",
      args: () => ["task completed successfully"],
    };

    // Run 1 iteration
    await runTaskLoop(dir, 1, agent, "test context");

    const plan = readFileSync(join(dir, "PLAN.md"), "utf-8");
    expect(plan).toContain("- [x] Create hello.ts");
    expect(plan).toContain("- [ ] Create world.ts");
  });

  test("marks section header done after successful agent run", async () => {
    writeFileSync(join(dir, "PLAN.md"), "## 1. Add auth module\nImplement JWT\n\n## 2. Add tests\nWrite unit tests\n");

    const agent: AgentSpawnConfig = {
      bin: "echo",
      args: () => ["implemented auth module"],
    };

    await runTaskLoop(dir, 1, agent, "ctx");

    const plan = readFileSync(join(dir, "PLAN.md"), "utf-8");
    expect(plan).toContain("## ~~1. Add auth module~~");
    // Second task untouched
    expect(plan).toContain("## 2. Add tests");
    expect(plan).not.toContain("~~2. Add tests~~");
  });

  test("appends subtasks when agent outputs <subtasks> block", async () => {
    writeFileSync(join(dir, "PLAN.md"), "# Plan\n- [ ] Big feature\n");

    const agent: AgentSpawnConfig = {
      bin: "echo",
      args: () => [
        "This is too large.\n<subtasks>\nImplement auth middleware\nAdd auth tests\nAdd auth docs\n</subtasks>",
      ],
    };

    await runTaskLoop(dir, 1, agent, "ctx");

    const plan = readFileSync(join(dir, "PLAN.md"), "utf-8");
    // Original task still unchecked (subtask expansion doesn't mark it done)
    expect(plan).toContain("- [ ] Big feature");
    // Subtasks appended
    expect(plan).toContain("- [ ] Implement auth middleware");
    expect(plan).toContain("- [ ] Add auth tests");
    expect(plan).toContain("- [ ] Add auth docs");
  });

  test("continues on agent failure", async () => {
    writeFileSync(join(dir, "PLAN.md"), "# Plan\n- [ ] Task A\n- [ ] Task B\n");

    // Agent that exits with failure (non-zero from 'false' command)
    const agent: AgentSpawnConfig = {
      bin: "false",
      args: () => [],
    };

    // Run 2 iterations — both should fail but loop continues
    await runTaskLoop(dir, 2, agent, "ctx");

    const plan = readFileSync(join(dir, "PLAN.md"), "utf-8");
    // Neither task marked done (agent failed both times)
    expect(plan).toContain("- [ ] Task A");
    expect(plan).toContain("- [ ] Task B");

    const log = readFileSync(join(dir, ".kobra-kai.log"), "utf-8");
    expect(log).toContain("agent exited with code");
  });

  test("processes multiple tasks across iterations", async () => {
    writeFileSync(join(dir, "PLAN.md"), "# Plan\n- [ ] First task\n- [ ] Second task\n- [ ] Third task\n");

    const agent: AgentSpawnConfig = {
      bin: "echo",
      args: () => ["done"],
    };

    await runTaskLoop(dir, 3, agent, "ctx");

    const plan = readFileSync(join(dir, "PLAN.md"), "utf-8");
    expect(plan).toContain("- [x] First task");
    expect(plan).toContain("- [x] Second task");
    expect(plan).toContain("- [x] Third task");
  });

  test("stops early when all tasks completed", async () => {
    writeFileSync(join(dir, "PLAN.md"), "# Plan\n- [ ] Only task\n");

    const agent: AgentSpawnConfig = {
      bin: "echo",
      args: () => ["done"],
    };

    // Allow 10 iterations but only 1 task
    await runTaskLoop(dir, 10, agent, "ctx");

    const log = readFileSync(join(dir, ".kobra-kai.log"), "utf-8");
    expect(log).toContain("no remaining tasks");
    // Should have iteration 1 and 2 (where it finds no task), not all 10
    expect(log).not.toContain("iteration 10/10");
  });

  test("writes log file to worktree dir", async () => {
    writeFileSync(join(dir, "PLAN.md"), "# Empty plan\n");

    const agent: AgentSpawnConfig = {
      bin: "echo",
      args: () => ["done"],
    };

    await runTaskLoop(dir, 1, agent, "ctx");

    const log = readFileSync(join(dir, ".kobra-kai.log"), "utf-8");
    expect(log).toContain("kobra-kai task runner started");
    expect(log).toContain(`worktree: ${dir}`);
  });

  test("subtask expansion then iteration picks up new subtask", async () => {
    writeFileSync(join(dir, "PLAN.md"), "# Plan\n- [ ] Big task\n");

    let call = 0;
    const agent: AgentSpawnConfig = {
      bin: "sh",
      args: () => {
        call++;
        if (call === 1) {
          // First call: output subtasks
          return ["-c", 'echo "<subtasks>\nSub A\nSub B\n</subtasks>"'];
        }
        // Subsequent calls: just succeed
        return ["-c", 'echo "done"'];
      },
    };

    // 4 iterations: expand → mark "Big task" done → do Sub A → do Sub B
    await runTaskLoop(dir, 4, agent, "ctx");

    const plan = readFileSync(join(dir, "PLAN.md"), "utf-8");
    // Parent task gets picked up again after expansion and marked done
    expect(plan).toContain("- [x] Big task");
    // Subtasks should also be marked done
    expect(plan).toContain("- [x] Sub A");
    expect(plan).toContain("- [x] Sub B");
  });
});
