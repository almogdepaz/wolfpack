import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractCurrentTask,
  markSectionDone,
  markCheckboxDone,
  appendSubtasksToPlan,
  parseSubtasks,
} from "../../../src/shared/task-iteration.js";

// ── Test helpers ──

let tmpDir: string;
let planPath: string;

function writePlan(content: string): void {
  writeFileSync(planPath, content);
}

function readPlan(): string {
  return readFileSync(planPath, "utf-8");
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "task-iteration-"));
  planPath = join(tmpDir, "PLAN.md");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// extractCurrentTask
// ═══════════════════════════════════════════════════════════════════════════

describe("extractCurrentTask (checkbox mode)", () => {
  test("returns first unchecked checkbox task", () => {
    writePlan("- [ ] first task\n- [ ] second task\n");
    const result = extractCurrentTask(planPath);
    expect(result).toEqual({ task: "first task", checkbox: true });
  });

  test("skips checked tasks, returns first unchecked", () => {
    writePlan("- [x] done one\n- [x] done two\n- [ ] pending one\n- [ ] pending two\n");
    const result = extractCurrentTask(planPath);
    expect(result).toEqual({ task: "pending one", checkbox: true });
  });

  test("returns null when all tasks checked", () => {
    writePlan("- [x] done one\n- [x] done two\n");
    expect(extractCurrentTask(planPath)).toBeNull();
  });

  test("checkbox takes priority over section headers", () => {
    writePlan("## 1. Section task\ndetails\n\n- [ ] checkbox task\n");
    const result = extractCurrentTask(planPath);
    expect(result).toEqual({ task: "checkbox task", checkbox: true });
  });

  test("handles task text with special characters", () => {
    writePlan("- [ ] fix `parseSubtasks()` in ralph-macchio.ts\n");
    const result = extractCurrentTask(planPath);
    expect(result).toEqual({ task: "fix `parseSubtasks()` in ralph-macchio.ts", checkbox: true });
  });
});

describe("extractCurrentTask (section headers)", () => {
  test("returns first numbered ## section with body", () => {
    writePlan("## 1. First task\ndo the thing\n\n## 2. Second task\nother thing\n");
    const result = extractCurrentTask(planPath);
    expect(result).toEqual({
      task: "## 1. First task\ndo the thing",
      checkbox: false,
    });
  });

  test("skips struck-through section headers", () => {
    writePlan("## ~~1. Done task~~\nold stuff\n\n## 2. Active task\nnew stuff\n");
    const result = extractCurrentTask(planPath);
    expect(result).toEqual({
      task: "## 2. Active task\nnew stuff",
      checkbox: false,
    });
  });

  test("returns null when all sections struck through", () => {
    writePlan("## ~~1. Done~~\nstuff\n\n## ~~2. Also done~~\nmore stuff\n");
    expect(extractCurrentTask(planPath)).toBeNull();
  });

  test("collects full section content until next same-level header", () => {
    writePlan("## 1. Task\nline 1\nline 2\nline 3\n\n## 2. Next task\nother\n");
    const result = extractCurrentTask(planPath);
    expect(result).toEqual({
      task: "## 1. Task\nline 1\nline 2\nline 3",
      checkbox: false,
    });
  });

  test("matches lettered sub-numbering like 1a.", () => {
    writePlan("### 1a. Sub-task alpha\ndetails\n\n### 1b. Sub-task beta\nmore\n");
    const result = extractCurrentTask(planPath);
    expect(result).toEqual({
      task: "### 1a. Sub-task alpha\ndetails",
      checkbox: false,
    });
  });

  test("does not match unnumbered section headers", () => {
    writePlan("## Overview\nsome text\n\n## Architecture\nmore text\n");
    expect(extractCurrentTask(planPath)).toBeNull();
  });
});

describe("extractCurrentTask (edge cases)", () => {
  test("returns null for empty file", () => {
    writePlan("");
    expect(extractCurrentTask(planPath)).toBeNull();
  });

  test("returns null for nonexistent file", () => {
    expect(extractCurrentTask("/tmp/nonexistent-plan-file.md")).toBeNull();
  });

  test("mixed formats: checkboxes and headers", () => {
    writePlan("## 1. Section\ndetails\n\n- [x] done\n- [ ] pending checkbox\n");
    const result = extractCurrentTask(planPath);
    // checkbox takes priority
    expect(result).toEqual({ task: "pending checkbox", checkbox: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// markSectionDone
// ═══════════════════════════════════════════════════════════════════════════

describe("markSectionDone", () => {
  test("wraps ## header text in strikethrough", () => {
    writePlan("## 1. Build the widget\nSome body text\n");
    markSectionDone(planPath, "## 1. Build the widget\nSome body text");
    expect(readPlan()).toBe("## ~~1. Build the widget~~\nSome body text\n");
  });

  test("wraps ### header text in strikethrough", () => {
    writePlan("### 2. Deploy service\nDetails here\n");
    markSectionDone(planPath, "### 2. Deploy service\nDetails here");
    expect(readPlan()).toBe("### ~~2. Deploy service~~\nDetails here\n");
  });

  test("only strikes the header line, not the body", () => {
    const plan = "## 1. First task\nBody of first\n## 2. Second task\nBody of second\n";
    writePlan(plan);
    markSectionDone(planPath, "## 1. First task\nBody of first");
    const result = readPlan();
    expect(result).toContain("## ~~1. First task~~");
    expect(result).toContain("## 2. Second task");
    expect(result).not.toContain("~~2. Second task~~");
  });

  test("no-op when header not found in plan", () => {
    const plan = "## 1. Real task\n";
    writePlan(plan);
    markSectionDone(planPath, "## 99. Ghost task");
    expect(readPlan()).toBe(plan);
  });

  test("no-op when taskText is empty", () => {
    const plan = "## 1. Task\n";
    writePlan(plan);
    markSectionDone(planPath, "");
    expect(readPlan()).toBe(plan);
  });

  test("handles regex-special characters in header", () => {
    writePlan("## 1. Fix bug (critical) [P0]\n");
    markSectionDone(planPath, "## 1. Fix bug (critical) [P0]");
    expect(readPlan()).toBe("## ~~1. Fix bug (critical) [P0]~~\n");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// markCheckboxDone
// ═══════════════════════════════════════════════════════════════════════════

describe("markCheckboxDone", () => {
  test("checks an unchecked checkbox", () => {
    writePlan("- [ ] Write tests\n- [ ] Ship it\n");
    markCheckboxDone(planPath, "Write tests");
    expect(readPlan()).toBe("- [x] Write tests\n- [ ] Ship it\n");
  });

  test("does not re-check an already checked item", () => {
    writePlan("- [x] Already done\n");
    markCheckboxDone(planPath, "Already done");
    expect(readPlan()).toBe("- [x] Already done\n");
  });

  test("exact match — no partial substring replacement", () => {
    writePlan("- [ ] Write tests for auth\n- [ ] Write tests\n");
    markCheckboxDone(planPath, "Write tests");
    const result = readPlan();
    expect(result).toContain("- [ ] Write tests for auth");
    expect(result).toMatch(/^- \[x\] Write tests$/m);
  });

  test("handles regex-special characters in task text", () => {
    writePlan("- [ ] Fix bug (critical) [P0]\n");
    markCheckboxDone(planPath, "Fix bug (critical) [P0]");
    expect(readPlan()).toBe("- [x] Fix bug (critical) [P0]\n");
  });

  test("no-op when task not found", () => {
    const plan = "- [ ] Real task\n";
    writePlan(plan);
    markCheckboxDone(planPath, "Nonexistent task");
    expect(readPlan()).toBe(plan);
  });

  test("checks correct item among many", () => {
    writePlan("- [x] Done1\n- [ ] Todo1\n- [ ] Todo2\n- [x] Done2\n");
    markCheckboxDone(planPath, "Todo2");
    expect(readPlan()).toBe("- [x] Done1\n- [ ] Todo1\n- [x] Todo2\n- [x] Done2\n");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// appendSubtasksToPlan
// ═══════════════════════════════════════════════════════════════════════════

describe("appendSubtasksToPlan", () => {
  test("appends subtasks as unchecked checkboxes", () => {
    writePlan("# Plan\n");
    appendSubtasksToPlan(planPath, ["Task A", "Task B"]);
    expect(readPlan()).toBe("# Plan\n\n- [ ] Task A\n- [ ] Task B\n");
  });

  test("strips markdown header prefixes from subtasks", () => {
    writePlan("");
    appendSubtasksToPlan(planPath, ["## Headed task", "### Sub headed"]);
    const result = readPlan();
    expect(result).toContain("- [ ] Headed task");
    expect(result).toContain("- [ ] Sub headed");
    expect(result).not.toContain("##");
  });

  test("strips strikethrough markers from subtasks", () => {
    writePlan("");
    appendSubtasksToPlan(planPath, ["~~struck~~ text", "clean text"]);
    const result = readPlan();
    expect(result).toContain("- [ ] struck text");
    expect(result).toContain("- [ ] clean text");
    expect(result).not.toContain("~~");
  });

  test("filters out empty/whitespace-only subtasks", () => {
    writePlan("");
    appendSubtasksToPlan(planPath, ["Real task", "", "  ", "Another task"]);
    const result = readPlan();
    const checkboxes = result.match(/- \[ \] /g);
    expect(checkboxes?.length).toBe(2);
  });

  test("preserves existing plan content", () => {
    writePlan("# Plan\n\n- [x] Done task\n- [ ] Pending task\n");
    appendSubtasksToPlan(planPath, ["New subtask"]);
    const result = readPlan();
    expect(result).toContain("- [x] Done task");
    expect(result).toContain("- [ ] Pending task");
    expect(result).toContain("- [ ] New subtask");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseSubtasks
// ═══════════════════════════════════════════════════════════════════════════

describe("parseSubtasks", () => {
  test("extracts subtasks from valid block", () => {
    const output = "some preamble\n<subtasks>\ntask one\ntask two\ntask three\n</subtasks>\npostamble";
    expect(parseSubtasks(output)).toEqual(["task one", "task two", "task three"]);
  });

  test("returns null when no subtasks block", () => {
    expect(parseSubtasks("just some output with no subtasks")).toBeNull();
  });

  test("returns empty array for empty subtasks block", () => {
    expect(parseSubtasks("<subtasks>\n\n\n</subtasks>")).toEqual([]);
  });

  test("trims whitespace from each subtask", () => {
    const output = "<subtasks>\n  padded task  \n   another one   \n</subtasks>";
    expect(parseSubtasks(output)).toEqual(["padded task", "another one"]);
  });

  test("filters out empty lines", () => {
    const output = "<subtasks>\ntask one\n\n\ntask two\n\n</subtasks>";
    expect(parseSubtasks(output)).toEqual(["task one", "task two"]);
  });

  test("handles single subtask", () => {
    const output = "<subtasks>\njust one task\n</subtasks>";
    expect(parseSubtasks(output)).toEqual(["just one task"]);
  });

  test("uses first subtasks block if multiple present", () => {
    const output = "<subtasks>\nfirst\n</subtasks>\nmore text\n<subtasks>\nsecond\n</subtasks>";
    expect(parseSubtasks(output)).toEqual(["first"]);
  });

  test("returns null for empty string", () => {
    expect(parseSubtasks("")).toBeNull();
  });

  test("handles malformed block (no closing tag)", () => {
    expect(parseSubtasks("<subtasks>\ntask one\ntask two")).toBeNull();
  });

  test("handles malformed block (no opening tag)", () => {
    expect(parseSubtasks("task one\ntask two\n</subtasks>")).toBeNull();
  });
});
