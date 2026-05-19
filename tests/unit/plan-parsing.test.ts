import { describe, expect, test } from "bun:test";
import { parseSubtasks } from "../../src/ralph-subtasks.js";
import { TASK_HEADER, countTasksInContent, detectOldPlanFormat, migratePlanFormat } from "../../src/wolfpack-context.js";

// ── Plan-parsing functions from ralph-macchio.ts and serve.ts ──
// These are module-private, replicated here as pure functions for testing.

/**
 * Mirrors ralph-macchio.ts extractCurrentTask() logic, but takes plan content
 * directly instead of reading from disk.
 */
function extractCurrentTask(plan: string): { task: string; checkbox: boolean } | null {
  // try checkboxes first (subtasks appended at bottom)
  const cbMatch = plan.match(/^- \[ \] (.+)$/m);
  if (cbMatch) return { task: cbMatch[1], checkbox: true };

  // then section headers: find first ## or ### numbered header not struck through
  const lines = plan.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (TASK_HEADER.test(line) && !line.includes("~~")) {
      const level = line.match(/^(#{2,3})/)?.[1] || "##";
      const sectionLines = [line];
      for (let j = i + 1; j < lines.length; j++) {
        const nextMatch = lines[j].match(/^(#{1,3}) /);
        if (nextMatch && nextMatch[1].length <= level.length) break;
        sectionLines.push(lines[j]);
      }
      // skip sections where all child checkboxes are already done
      const childChecked = sectionLines.filter(l => /^- \[x\] /.test(l)).length;
      const childUnchecked = sectionLines.filter(l => /^- \[ \] /.test(l)).length;
      if (childChecked > 0 && childUnchecked === 0) continue;
      return { task: sectionLines.join("\n").trim(), checkbox: false };
    }
  }
  return null;
}

/** Mirrors serve.ts countPlanTasks() but takes content instead of path */
function countPlanTasks(plan: string): { done: number; total: number } {
  // checkbox mode
  if (/^- \[[ x]\] /m.test(plan)) {
    const done = (plan.match(/^- \[x\] /gm) || []).length;
    const pending = (plan.match(/^- \[ \] /gm) || []).length;
    return { done, total: done + pending };
  }
  // section mode: ## or ### numbered headers (with optional ~~ strikethrough)
  let total = 0;
  let done = 0;
  for (const line of plan.split("\n")) {
    if (TASK_HEADER.test(line)) {
      total++;
      if (line.includes("~~")) done++;
    }
  }
  return { done, total };
}

// ── extractCurrentTask tests — checkbox mode ──

describe("extractCurrentTask (checkbox mode)", () => {
  test("returns first unchecked task", () => {
    const plan = "- [ ] first task\n- [ ] second task";
    const result = extractCurrentTask(plan);
    expect(result).toEqual({ task: "first task", checkbox: true });
  });

  test("skips checked tasks, returns first unchecked", () => {
    const plan = "- [x] done one\n- [x] done two\n- [ ] pending one\n- [ ] pending two";
    const result = extractCurrentTask(plan);
    expect(result).toEqual({ task: "pending one", checkbox: true });
  });

  test("returns null when all tasks checked", () => {
    const plan = "- [x] done one\n- [x] done two\n- [x] done three";
    expect(extractCurrentTask(plan)).toBeNull();
  });

  test("handles plan with header and description before checkboxes", () => {
    const plan = "# Implementation Plan\n\nSome description.\n\n- [x] setup\n- [ ] implement feature\n- [ ] write tests";
    const result = extractCurrentTask(plan);
    expect(result).toEqual({ task: "implement feature", checkbox: true });
  });

  test("handles task text with special characters", () => {
    const plan = "- [ ] fix `contentUsesCheckboxes()` regex in ralph-macchio.ts";
    const result = extractCurrentTask(plan);
    expect(result).toEqual({ task: "fix `contentUsesCheckboxes()` regex in ralph-macchio.ts", checkbox: true });
  });

  test("checkbox takes priority over section headers", () => {
    const plan = "## 1. Section task\ndetails\n\n- [ ] checkbox task";
    const result = extractCurrentTask(plan);
    expect(result).toEqual({ task: "checkbox task", checkbox: true });
  });
});

// ── extractCurrentTask tests — section mode ──

describe("extractCurrentTask (section mode)", () => {
  test("returns first numbered ## section", () => {
    const plan = "## 1. First task\ndo the thing\n\n## 2. Second task\nother thing";
    const result = extractCurrentTask(plan);
    expect(result).toEqual({
      task: "## 1. First task\ndo the thing",
      checkbox: false,
    });
  });

  test("returns first numbered ### section", () => {
    const plan = "### 1. First sub-task\nimplementation details\n\n### 2. Second sub-task\nmore details";
    const result = extractCurrentTask(plan);
    expect(result).toEqual({
      task: "### 1. First sub-task\nimplementation details",
      checkbox: false,
    });
  });

  test("skips struck-through section headers", () => {
    const plan = "## ~~1. Done task~~\nold stuff\n\n## 2. Active task\nnew stuff";
    const result = extractCurrentTask(plan);
    expect(result).toEqual({
      task: "## 2. Active task\nnew stuff",
      checkbox: false,
    });
  });

  test("skips all struck-through headers, returns null", () => {
    const plan = "## ~~1. Done~~\nstuff\n\n## ~~2. Also done~~\nmore stuff";
    expect(extractCurrentTask(plan)).toBeNull();
  });

  test("collects full section content until next same-level header", () => {
    const plan = "## 1. Task\nline 1\nline 2\nline 3\n\n## 2. Next task\nother";
    const result = extractCurrentTask(plan);
    expect(result).toEqual({
      task: "## 1. Task\nline 1\nline 2\nline 3",
      checkbox: false,
    });
  });

  test("## section stops at # header (higher level)", () => {
    const plan = "## 1. Task\ncontent\n\n# Top level header\nother";
    const result = extractCurrentTask(plan);
    expect(result).toEqual({
      task: "## 1. Task\ncontent",
      checkbox: false,
    });
  });

  test("## section includes ### subsections", () => {
    const plan = "## 1. Big task\noverview\n### Implementation\ndetails\n### Testing\ntest stuff\n\n## 2. Next";
    const result = extractCurrentTask(plan);
    expect(result).toEqual({
      task: "## 1. Big task\noverview\n### Implementation\ndetails\n### Testing\ntest stuff",
      checkbox: false,
    });
  });

  test("matches numbered header with paren (1) instead of dot", () => {
    const plan = "## 1) First task\ndo it";
    const result = extractCurrentTask(plan);
    expect(result).toEqual({
      task: "## 1) First task\ndo it",
      checkbox: false,
    });
  });

  test("matches lettered sub-numbering like 1a.", () => {
    const plan = "### 1a. Sub-task alpha\ndetails\n\n### 1b. Sub-task beta\nmore";
    const result = extractCurrentTask(plan);
    expect(result).toEqual({
      task: "### 1a. Sub-task alpha\ndetails",
      checkbox: false,
    });
  });

  test("does not match unnumbered section headers", () => {
    const plan = "## Overview\nsome text\n\n## Architecture\nmore text";
    expect(extractCurrentTask(plan)).toBeNull();
  });

  test("does not match #### (4-level) headers", () => {
    const plan = "#### 1. Deep header\nstuff";
    expect(extractCurrentTask(plan)).toBeNull();
  });

  test("skips non-task content before first numbered header", () => {
    const plan = "# Plan Title\n\nIntro paragraph.\n\n## Context\nbackground\n\n## 1. Real task\naction items";
    const result = extractCurrentTask(plan);
    expect(result).toEqual({
      task: "## 1. Real task\naction items",
      checkbox: false,
    });
  });
});

// ── extractCurrentTask tests — edge cases ──

describe("extractCurrentTask (edge cases)", () => {
  test("returns null for empty string", () => {
    expect(extractCurrentTask("")).toBeNull();
  });

  test("returns null for plan with no tasks", () => {
    expect(extractCurrentTask("# Just a title\n\nSome notes.")).toBeNull();
  });

  test("returns null for whitespace-only content", () => {
    expect(extractCurrentTask("   \n\n  \n")).toBeNull();
  });
});

// ── same-task-twice detection scenario ──

describe("same-task-twice detection", () => {
  test("extractCurrentTask returns same section task when parent not marked done", () => {
    const plan = "## 1. Big task\ndetails\n\n## 2. Other task\nmore";
    // simulate: first call returns "Big task", subtasks emitted but parent NOT marked done
    const first = extractCurrentTask(plan);
    expect(first).not.toBeNull();
    // plan unchanged → same task picked again
    const second = extractCurrentTask(plan);
    expect(second).not.toBeNull();
    expect(second!.task).toBe(first!.task);
  });

  test("extractCurrentTask returns different task after parent marked done (checkbox)", () => {
    const planBefore = "- [ ] Big task\n- [ ] Sub A\n- [ ] Sub B\n";
    const first = extractCurrentTask(planBefore);
    expect(first).toEqual({ task: "Big task", checkbox: true });
    // simulate marking parent done
    const planAfter = planBefore.replace("- [ ] Big task", "- [x] Big task");
    const second = extractCurrentTask(planAfter);
    expect(second).toEqual({ task: "Sub A", checkbox: true });
  });

  test("extractCurrentTask returns different task after parent marked done (section)", () => {
    const planBefore = "## 1. Big task\ndetails\n\n## 2. Other task\nmore";
    const first = extractCurrentTask(planBefore);
    expect(first!.task).toContain("## 1. Big task");
    // simulate marking parent done
    const planAfter = planBefore.replace("## 1. Big task", "## ~~1. Big task~~");
    const second = extractCurrentTask(planAfter);
    expect(second!.task).toContain("## 2. Other task");
  });
});

// ── parseSubtasks tests ──

describe("parseSubtasks", () => {
  test("extracts subtasks from valid block", () => {
    const output = "some preamble\n<subtasks>\ntask one\ntask two\ntask three\n</subtasks>\npostamble";
    expect(parseSubtasks(output)).toEqual(["task one", "task two", "task three"]);
  });

  test("returns empty array when no subtasks block", () => {
    expect(parseSubtasks("just some output with no subtasks")).toEqual([]);
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

  test("handles multi-word subtasks", () => {
    const output = "<subtasks>\nimplement the authentication module with OAuth2\nwrite unit tests for login flow\n</subtasks>";
    expect(parseSubtasks(output)).toEqual([
      "implement the authentication module with OAuth2",
      "write unit tests for login flow",
    ]);
  });

  test("handles single subtask", () => {
    const output = "<subtasks>\njust one task\n</subtasks>";
    expect(parseSubtasks(output)).toEqual(["just one task"]);
  });

  test("uses first subtasks block if multiple present", () => {
    const output = "<subtasks>\nfirst\n</subtasks>\nmore text\n<subtasks>\nsecond\n</subtasks>";
    // non-greedy match means first block wins
    expect(parseSubtasks(output)).toEqual(["first"]);
  });

  test("handles subtasks with special characters", () => {
    const output = "<subtasks>\nfix `parseSubtasks()` in ralph-macchio.ts\nadd tests for <edge> cases\n</subtasks>";
    expect(parseSubtasks(output)).toEqual([
      "fix `parseSubtasks()` in ralph-macchio.ts",
      "add tests for <edge> cases",
    ]);
  });

  test("returns empty array for empty string", () => {
    expect(parseSubtasks("")).toEqual([]);
  });

  test("codex output is ignored because codex can echo prompt transcript tags", () => {
    const output = [
      "starting codex session",
      "OUTPUT (always include):",
      "<subtasks>",
      "- prompt text that must not become a task",
      "later transcript chunk says </subtasks> after unrelated echoed content",
    ].join("\n");
    expect(parseSubtasks(output, "codex")).toEqual([]);
  });
});

// ── countPlanTasks tests — checkbox mode ──

describe("countPlanTasks (checkbox mode)", () => {
  test("counts all pending tasks", () => {
    const plan = "- [ ] task one\n- [ ] task two\n- [ ] task three";
    expect(countPlanTasks(plan)).toEqual({ done: 0, total: 3 });
  });

  test("counts all done tasks", () => {
    const plan = "- [x] done one\n- [x] done two";
    expect(countPlanTasks(plan)).toEqual({ done: 2, total: 2 });
  });

  test("counts mixed done and pending", () => {
    const plan = "- [x] done\n- [ ] pending\n- [x] also done\n- [ ] also pending";
    expect(countPlanTasks(plan)).toEqual({ done: 2, total: 4 });
  });

  test("ignores non-checkbox lines in count", () => {
    const plan = "# Plan\n\nSome notes.\n\n- [x] done\n- [ ] pending\n\n- regular bullet";
    expect(countPlanTasks(plan)).toEqual({ done: 1, total: 2 });
  });

  test("handles single checkbox task", () => {
    const plan = "- [ ] only task";
    expect(countPlanTasks(plan)).toEqual({ done: 0, total: 1 });
  });
});

// ── countPlanTasks tests — section mode ──

describe("countPlanTasks (section mode)", () => {
  test("counts all pending section tasks", () => {
    const plan = "## 1. First task\nstuff\n\n## 2. Second task\nmore";
    expect(countPlanTasks(plan)).toEqual({ done: 0, total: 2 });
  });

  test("counts struck-through sections as done", () => {
    const plan = "## ~~1. Done task~~\nold\n\n## 2. Pending task\nnew";
    expect(countPlanTasks(plan)).toEqual({ done: 1, total: 2 });
  });

  test("all sections struck through", () => {
    const plan = "## ~~1. Done~~\nstuff\n\n## ~~2. Also done~~\nmore";
    expect(countPlanTasks(plan)).toEqual({ done: 2, total: 2 });
  });

  test("counts ### headers too", () => {
    const plan = "### 1. Sub-task one\ndetails\n\n### 2. Sub-task two\nmore";
    expect(countPlanTasks(plan)).toEqual({ done: 0, total: 2 });
  });

  test("counts mixed ## and ### numbered headers", () => {
    const plan = "## 1. Big task\n\n### 2. Sub task\n\n## ~~3. Done~~\n";
    expect(countPlanTasks(plan)).toEqual({ done: 1, total: 3 });
  });

  test("ignores unnumbered section headers", () => {
    const plan = "## Overview\nblah\n\n## 1. Real task\nstuff\n\n## Architecture\nmore";
    expect(countPlanTasks(plan)).toEqual({ done: 0, total: 1 });
  });

  test("handles lettered sub-numbering", () => {
    const plan = "### 1a. Part A\ndetails\n\n### ~~1b. Part B~~\ndone";
    expect(countPlanTasks(plan)).toEqual({ done: 1, total: 2 });
  });

  test("handles paren numbering style", () => {
    const plan = "## 1) First\nstuff\n\n## 2) Second\nmore";
    expect(countPlanTasks(plan)).toEqual({ done: 0, total: 2 });
  });
});

// ── countPlanTasks tests — edge cases ──

describe("countPlanTasks (edge cases)", () => {
  test("returns zero for empty plan", () => {
    expect(countPlanTasks("")).toEqual({ done: 0, total: 0 });
  });

  test("returns zero for plan with no tasks", () => {
    expect(countPlanTasks("# Just a title\n\nSome notes.")).toEqual({ done: 0, total: 0 });
  });

  test("returns zero for plain text only", () => {
    expect(countPlanTasks("no headers here\njust text")).toEqual({ done: 0, total: 0 });
  });
});

// ── countTasksInContent (shared, exported from wolfpack-context.ts) ──

describe("countTasksInContent", () => {
  test("counts checkbox tasks", () => {
    const plan = "- [x] done\n- [ ] pending\n- [ ] also pending";
    expect(countTasksInContent(plan)).toEqual({ done: 1, total: 3 });
  });

  test("counts section header tasks", () => {
    const plan = "## ~~1. Done~~\nstuff\n\n## 2. Pending\nmore";
    expect(countTasksInContent(plan)).toEqual({ done: 1, total: 2 });
  });

  test("counts mixed checkboxes and section headers — headers win (ISS-09)", () => {
    const plan = "## ~~1. Done task~~\nstuff\n\n## 2. Open task\nmore\n\n- [x] checked\n- [ ] unchecked";
    // Headers present → only headers counted, checkboxes ignored to prevent double-counting
    expect(countTasksInContent(plan)).toEqual({ done: 1, total: 2 });
  });

  test("returns zero for empty content", () => {
    expect(countTasksInContent("")).toEqual({ done: 0, total: 0 });
  });

  test("returns zero for no tasks", () => {
    expect(countTasksInContent("# Title\n\nJust prose.")).toEqual({ done: 0, total: 0 });
  });
});

// ── plan corruption detection scenario ──

describe("plan corruption detection", () => {
  test("detects task count shrinkage (section headers removed)", () => {
    const before = "## 1. Task A\nstuff\n\n## 2. Task B\nmore\n\n## 3. Task C\nend";
    const after = "## 1. Task A\nstuff\n\n## Some Rewritten Header\nmore\n\n## 3. Task C\nend";
    const totalBefore = countTasksInContent(before).total;
    const totalAfter = countTasksInContent(after).total;
    expect(totalBefore).toBe(3);
    expect(totalAfter).toBe(2); // "Some Rewritten Header" doesn't match TASK_HEADER
    expect(totalAfter < totalBefore).toBe(true);
  });

  test("detects task count shrinkage (checkboxes deleted)", () => {
    const before = "- [ ] Task A\n- [ ] Task B\n- [ ] Task C";
    const after = "- [ ] Task A\n- [ ] Task C"; // Task B deleted
    const totalBefore = countTasksInContent(before).total;
    const totalAfter = countTasksInContent(after).total;
    expect(totalBefore).toBe(3);
    expect(totalAfter).toBe(2);
    expect(totalAfter < totalBefore).toBe(true);
  });

  test("no false positive when task is marked done (section)", () => {
    const before = "## 1. Task A\nstuff\n\n## 2. Task B\nmore";
    const after = "## ~~1. Task A~~\nstuff\n\n## 2. Task B\nmore";
    const totalBefore = countTasksInContent(before).total;
    const totalAfter = countTasksInContent(after).total;
    expect(totalBefore).toBe(2);
    expect(totalAfter).toBe(2); // marking done doesn't change total
    expect(totalAfter < totalBefore).toBe(false);
  });

  test("no false positive when task is marked done (checkbox)", () => {
    const before = "- [ ] Task A\n- [ ] Task B";
    const after = "- [x] Task A\n- [ ] Task B";
    const totalBefore = countTasksInContent(before).total;
    const totalAfter = countTasksInContent(after).total;
    expect(totalBefore).toBe(2);
    expect(totalAfter).toBe(2);
    expect(totalAfter < totalBefore).toBe(false);
  });

  test("no false positive when subtasks are added (ISS-09)", () => {
    const before = "## 1. Big task\nstuff\n\n## 2. Other\nmore";
    const after = "## 1. Big task\nstuff\n\n## 2. Other\nmore\n\n- [ ] Sub A\n- [ ] Sub B";
    const totalBefore = countTasksInContent(before).total;
    const totalAfter = countTasksInContent(after).total;
    expect(totalBefore).toBe(2);
    // Headers still present → checkboxes ignored → total unchanged, no corruption false positive
    expect(totalAfter).toBe(2);
    expect(totalAfter < totalBefore).toBe(false);
  });

  test("detects agent rewriting headers to unparseable format", () => {
    const before = "## 1. Setup auth\n\n## 2. Add tests\n\n## 3. Deploy";
    const after = "## Setup auth\n\n## Add tests\n\n## Deploy"; // numbers stripped
    const totalBefore = countTasksInContent(before).total;
    const totalAfter = countTasksInContent(after).total;
    expect(totalBefore).toBe(3);
    expect(totalAfter).toBe(0); // unnumbered headers don't match
    expect(totalAfter < totalBefore).toBe(true);
  });

  test("detects completed count shrinkage (strikethrough removed)", () => {
    const before = "## ~~1. Done~~\n\n## ~~2. Also done~~\n\n## 3. Pending";
    const after = "## 1. Done\n\n## 2. Also done\n\n## 3. Pending"; // ~~ stripped
    const beforeCounts = countTasksInContent(before);
    const afterCounts = countTasksInContent(after);
    expect(beforeCounts).toEqual({ done: 2, total: 3 });
    expect(afterCounts).toEqual({ done: 0, total: 3 }); // total same, done shrank
    expect(afterCounts.total < beforeCounts.total).toBe(false); // total-only check misses this
    expect(afterCounts.done < beforeCounts.done).toBe(true); // done check catches it
  });

  test("detects completed count shrinkage (checkbox unchecked)", () => {
    const before = "- [x] Task A\n- [x] Task B\n- [ ] Task C";
    const after = "- [ ] Task A\n- [ ] Task B\n- [ ] Task C"; // all unchecked
    const beforeCounts = countTasksInContent(before);
    const afterCounts = countTasksInContent(after);
    expect(beforeCounts).toEqual({ done: 2, total: 3 });
    expect(afterCounts).toEqual({ done: 0, total: 3 });
    expect(afterCounts.total < beforeCounts.total).toBe(false);
    expect(afterCounts.done < beforeCounts.done).toBe(true);
  });

  test("no false positive when total stable and done increases", () => {
    const before = "## 1. Task A\n\n## 2. Task B";
    const after = "## ~~1. Task A~~\n\n## 2. Task B";
    const beforeCounts = countTasksInContent(before);
    const afterCounts = countTasksInContent(after);
    expect(afterCounts.total < beforeCounts.total).toBe(false);
    expect(afterCounts.done < beforeCounts.done).toBe(false);
  });
});

// ── #74: skip fully-completed sections ──

describe("extractCurrentTask skips fully-completed sections", () => {
  test("skips section where all child checkboxes are [x]", () => {
    const plan = [
      "## 1. Package setup",
      "- [x] Create package.json",
      "- [x] Add dependencies",
      "",
      "## 2. Implementation",
      "Some description",
    ].join("\n");
    const result = extractCurrentTask(plan);
    expect(result).not.toBeNull();
    expect(result!.task).toContain("## 2. Implementation");
    expect(result!.checkbox).toBe(false);
  });

  test("does not skip section with mix of checked and unchecked", () => {
    const plan = [
      "## 1. Setup",
      "- [x] Done subtask",
      "- [ ] Pending subtask",
      "",
      "## 2. Next",
      "stuff",
    ].join("\n");
    // unchecked checkbox found first (checkbox mode takes priority)
    const result = extractCurrentTask(plan);
    expect(result).toEqual({ task: "Pending subtask", checkbox: true });
  });

  test("does not skip section with zero checkboxes (backward compat)", () => {
    const plan = [
      "## 1. Design the API",
      "Write the spec document",
      "",
      "## 2. Implement",
      "Build it",
    ].join("\n");
    const result = extractCurrentTask(plan);
    expect(result).not.toBeNull();
    expect(result!.task).toContain("## 1. Design the API");
  });

  test("skips multiple completed sections to find active one", () => {
    const plan = [
      "## 1. Phase one",
      "- [x] Step A",
      "- [x] Step B",
      "",
      "## 2. Phase two",
      "- [x] Step C",
      "- [x] Step D",
      "",
      "## 3. Phase three",
      "- [x] Step E",
      "- [ ] Step F",
      "",
      "## 4. Phase four",
      "Details",
    ].join("\n");
    // unchecked checkbox found first
    const result = extractCurrentTask(plan);
    expect(result).toEqual({ task: "Step F", checkbox: true });
  });

  test("returns null when all sections fully completed and no unchecked checkboxes", () => {
    const plan = [
      "## ~~1. Done one~~",
      "- [x] Sub A",
      "",
      "## 2. Done two",
      "- [x] Sub B",
      "- [x] Sub C",
    ].join("\n");
    // section 1 is struck through → skipped
    // section 2 has all [x] → skipped by new logic
    expect(extractCurrentTask(plan)).toBeNull();
  });

  test("skips completed section even with non-checkbox content mixed in", () => {
    const plan = [
      "## 1. Setup",
      "Some description paragraph",
      "- [x] Install deps",
      "More notes here",
      "- [x] Configure build",
      "",
      "## 2. Next task",
      "Do things",
    ].join("\n");
    const result = extractCurrentTask(plan);
    expect(result).not.toBeNull();
    expect(result!.task).toContain("## 2. Next task");
  });
});

// ── detectOldPlanFormat tests ──

describe("detectOldPlanFormat", () => {
  test("detects 'Task N: Title' format", () => {
    expect(detectOldPlanFormat("Task 1: Setup project\nTask 2: Add tests")).toBe(true);
  });

  test("detects 'Task N. Title' format", () => {
    expect(detectOldPlanFormat("Task 1. Setup project")).toBe(true);
  });

  test("returns false for ## Task N: (already matches TASK_HEADER)", () => {
    // ## Task 1: matches TASK_HEADER via (?:\w+ )?\d+[\.\):] so it's already parseable
    expect(detectOldPlanFormat("## Task 1: Setup\n## Task 2: Tests")).toBe(false);
  });

  test("detects bare Task N: without markdown header", () => {
    expect(detectOldPlanFormat("# Plan\n\nTask 1: Setup\nTask 2: Tests")).toBe(true);
  });

  test("detects sub-lettered tasks", () => {
    expect(detectOldPlanFormat("Task 1a: Sub-task alpha")).toBe(true);
  });

  test("case insensitive", () => {
    expect(detectOldPlanFormat("task 1: lowercase")).toBe(true);
    expect(detectOldPlanFormat("TASK 1: UPPERCASE")).toBe(true);
  });

  test("returns false for new format", () => {
    expect(detectOldPlanFormat("## 1. Setup project\n## 2. Add tests")).toBe(false);
  });

  test("returns false when both old and new format present", () => {
    // if new format headers exist, don't flag as old
    expect(detectOldPlanFormat("## 1. New style\nTask 2: Old style")).toBe(false);
  });

  test("returns false for empty content", () => {
    expect(detectOldPlanFormat("")).toBe(false);
  });

  test("returns false for plain text mentioning 'task'", () => {
    expect(detectOldPlanFormat("This task is important")).toBe(false);
  });
});

// ── migratePlanFormat tests ──

describe("migratePlanFormat", () => {
  test("converts 'Task N: Title' to '## N. Title'", () => {
    const input = "Task 1: Setup project\nTask 2: Add tests";
    const { content, count } = migratePlanFormat(input);
    expect(content).toBe("## 1. Setup project\n## 2. Add tests");
    expect(count).toBe(2);
  });

  test("converts 'Task N. Title' to '## N. Title'", () => {
    const { content } = migratePlanFormat("Task 1. Setup project");
    expect(content).toBe("## 1. Setup project");
  });

  test("converts markdown-headered old format (force migration)", () => {
    // Even though ## Task 1: matches TASK_HEADER, migratePlanFormat still converts
    // (detectOldPlanFormat gates whether to call it; migratePlanFormat itself is unconditional)
    const input = "## Task 1: Setup\n## Task 2: Tests";
    const { content, count } = migratePlanFormat(input);
    expect(content).toBe("## 1. Setup\n## 2. Tests");
    expect(count).toBe(2);
  });

  test("converts sub-lettered tasks", () => {
    const input = "Task 1a: Sub-task alpha\nTask 1b: Sub-task beta";
    const { content, count } = migratePlanFormat(input);
    expect(content).toBe("## 1a. Sub-task alpha\n## 1b. Sub-task beta");
    expect(count).toBe(2);
  });

  test("preserves non-task content", () => {
    const input = "# My Plan\n\nSome intro text.\n\nTask 1: Do thing\n\nMore details here.";
    const { content, count } = migratePlanFormat(input);
    expect(content).toBe("# My Plan\n\nSome intro text.\n\n## 1. Do thing\n\nMore details here.");
    expect(count).toBe(1);
  });

  test("returns count 0 for content with no old tasks", () => {
    const input = "## 1. Already new format";
    const { content, count } = migratePlanFormat(input);
    expect(content).toBe("## 1. Already new format");
    expect(count).toBe(0);
  });

  test("trims trailing whitespace from title", () => {
    const { content } = migratePlanFormat("Task 1: Title with trailing   ");
    expect(content).toBe("## 1. Title with trailing");
  });
});
