import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Plan-mutation functions from ralph-macchio.ts ──
// These are module-private; replicated here as pure-ish functions that
// operate on a configurable plan path instead of the module-level PLAN_PATH.

/** Mirrors ralph-macchio.ts markSectionDone() */
function markSectionDone(planPath: string, taskText: string): void {
  try {
    const plan = readFileSync(planPath, "utf-8");
    const headerLine = taskText.split("\n")[0];
    if (!headerLine || !plan.includes(headerLine)) return;
    const prefix = headerLine.match(/^(#{2,3} )/)?.[1] || "### ";
    const rest = headerLine.slice(prefix.length);
    const escaped = headerLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lineRegex = new RegExp("^" + escaped + "$", "m");
    const updated = plan.replace(lineRegex, `${prefix}~~${rest}~~`);
    writeFileSync(planPath, updated);
  } catch {}
}

/** Mirrors ralph-macchio.ts markCheckboxDone() */
function markCheckboxDone(planPath: string, taskText: string): void {
  try {
    const plan = readFileSync(planPath, "utf-8");
    const escaped = taskText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("^- \\[ \\] " + escaped + "$", "m");
    const updated = plan.replace(re, `- [x] ${taskText}`);
    writeFileSync(planPath, updated);
  } catch {}
}

/** Mirrors ralph-macchio.ts appendSubtasksToPlan() */
function appendSubtasksToPlan(planPath: string, subtasks: string[]): void {
  const safe = subtasks.map(t => t.replace(/^#+\s*/, "").replace(/~~/g, "").trim()).filter(Boolean);
  const lines = safe.map(t => `- [ ] ${t}`).join("\n");
  appendFileSync(planPath, "\n" + lines + "\n");
}

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
  tmpDir = mkdtempSync(join(tmpdir(), "plan-mutation-"));
  planPath = join(tmpDir, "PLAN.md");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Mirrors ralph-macchio.ts dedupCheckboxes() — operates on a configurable path */
function dedupCheckboxes(planPath: string): void {
  try {
    const plan = readFileSync(planPath, "utf-8");
    const lines = plan.split("\n");
    const seen = new Set<string>();
    const checkedTexts = new Set<string>();

    for (const line of lines) {
      const m = line.match(/^- \[x\] (.+)$/);
      if (m) checkedTexts.add(m[1]);
    }

    const out: string[] = [];
    for (const line of lines) {
      const m = line.match(/^- \[ \] (.+)$/);
      if (m) {
        const text = m[1];
        if (checkedTexts.has(text) || seen.has(text)) continue;
        seen.add(text);
      }
      out.push(line);
    }

    if (out.length !== lines.length) {
      writeFileSync(planPath, out.join("\n"));
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// dedupCheckboxes
// ═══════════════════════════════════════════════════════════════════════════

describe("dedupCheckboxes", () => {
  test("removes exact duplicate - [ ] entries", () => {
    writePlan("- [ ] Write tests\n- [ ] Deploy\n- [ ] Write tests\n");
    dedupCheckboxes(planPath);
    const result = readPlan();
    const matches = result.match(/- \[ \] Write tests/g);
    expect(matches?.length).toBe(1);
    expect(result).toContain("- [ ] Deploy");
  });

  test("removes - [ ] when - [x] exists for same text", () => {
    writePlan("- [x] Write tests\n- [ ] Write tests\n- [ ] Deploy\n");
    dedupCheckboxes(planPath);
    const result = readPlan();
    expect(result).toContain("- [x] Write tests");
    expect(result).not.toContain("- [ ] Write tests");
    expect(result).toContain("- [ ] Deploy");
  });

  test("preserves non-duplicate entries", () => {
    const plan = "- [ ] Task A\n- [x] Task B\n- [ ] Task C\n";
    writePlan(plan);
    dedupCheckboxes(planPath);
    expect(readPlan()).toBe(plan);
  });

  test("handles multiple duplicates", () => {
    writePlan("- [ ] A\n- [ ] B\n- [ ] A\n- [ ] B\n- [ ] A\n");
    dedupCheckboxes(planPath);
    const result = readPlan();
    expect((result.match(/- \[ \] A/g) || []).length).toBe(1);
    expect((result.match(/- \[ \] B/g) || []).length).toBe(1);
  });

  test("no-op on plan with no checkboxes", () => {
    const plan = "## 1. Section task\nSome body\n";
    writePlan(plan);
    dedupCheckboxes(planPath);
    expect(readPlan()).toBe(plan);
  });

  test("keeps checked duplicates (only dedup unchecked)", () => {
    writePlan("- [x] Done\n- [x] Done\n");
    dedupCheckboxes(planPath);
    const result = readPlan();
    // checked items are not deduped — they're historical markers
    expect((result.match(/- \[x\] Done/g) || []).length).toBe(2);
  });

  test("preserves non-checkbox lines interleaved", () => {
    writePlan("# Plan\n\n- [ ] Task A\nsome notes\n- [ ] Task A\n");
    dedupCheckboxes(planPath);
    const result = readPlan();
    expect((result.match(/- \[ \] Task A/g) || []).length).toBe(1);
    expect(result).toContain("some notes");
    expect(result).toContain("# Plan");
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

  test("is line-anchored — does not match partial lines", () => {
    const plan = "## 1. Setup\nSome text mentioning ## 1. Setup in prose\n";
    writePlan(plan);
    markSectionDone(planPath, "## 1. Setup");
    const result = readPlan();
    // header struck
    expect(result).toMatch(/^## ~~1\. Setup~~$/m);
    // prose line untouched
    expect(result).toContain("Some text mentioning ## 1. Setup in prose");
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

  test("only strikes the first matching header when duplicates exist", () => {
    // regex replaces first match only
    writePlan("## 1. Dup\nfirst body\n## 1. Dup\nsecond body\n");
    markSectionDone(planPath, "## 1. Dup\nfirst body");
    const result = readPlan();
    const matches = result.match(/~~1\. Dup~~/g);
    // .replace only replaces first match
    expect(matches?.length).toBe(1);
  });

  test("handles multiline taskText — uses only first line", () => {
    writePlan("### 3a. Multi\nline1\nline2\n");
    markSectionDone(planPath, "### 3a. Multi\nline1\nline2");
    expect(readPlan()).toBe("### ~~3a. Multi~~\nline1\nline2\n");
  });

  test("handles header with trailing whitespace in plan", () => {
    // the plan file has the header; taskText must match exactly
    writePlan("## 1. Trim test\nBody\n");
    markSectionDone(planPath, "## 1. Trim test\nBody");
    expect(readPlan()).toContain("## ~~1. Trim test~~");
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
    // pattern requires `- [ ] ` so nothing changes
    expect(readPlan()).toBe("- [x] Already done\n");
  });

  test("exact match — no partial substring replacement", () => {
    writePlan("- [ ] Write tests for auth\n- [ ] Write tests\n");
    markCheckboxDone(planPath, "Write tests");
    const result = readPlan();
    // "Write tests" (exact) is checked, "Write tests for auth" is NOT
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

  test("line-anchored — requires full line match", () => {
    writePlan("Some prose: - [ ] Inline checkbox\n- [ ] Inline checkbox\n");
    markCheckboxDone(planPath, "Inline checkbox");
    const result = readPlan();
    // only the line-start checkbox is replaced
    expect(result).toContain("Some prose: - [ ] Inline checkbox");
    expect(result).toMatch(/^- \[x\] Inline checkbox$/m);
  });

  test("handles task text with leading/trailing spaces literally", () => {
    writePlan("- [ ]  extra space task\n");
    // taskText without leading space won't match `- [ ]  extra space task`
    markCheckboxDone(planPath, "extra space task");
    // pattern becomes `^- \[ \] extra space task$` which doesn't match the double-space
    expect(readPlan()).toBe("- [ ]  extra space task\n");
  });

  test("checks correct item among many", () => {
    writePlan("- [x] Done1\n- [ ] Todo1\n- [ ] Todo2\n- [x] Done2\n");
    markCheckboxDone(planPath, "Todo2");
    const result = readPlan();
    expect(result).toBe("- [x] Done1\n- [ ] Todo1\n- [x] Todo2\n- [x] Done2\n");
  });

  test("handles empty taskText gracefully", () => {
    const plan = "- [ ] Something\n";
    writePlan(plan);
    markCheckboxDone(planPath, "");
    // pattern `^- \[ \] $` won't match `- [ ] Something`
    expect(readPlan()).toBe(plan);
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
    expect(result).toContain("- [ ] Real task");
    expect(result).toContain("- [ ] Another task");
    // only 2 checkboxes
    const checkboxes = result.match(/- \[ \] /g);
    expect(checkboxes?.length).toBe(2);
  });

  test("handles all-empty subtasks array", () => {
    writePlan("# Plan\n");
    appendSubtasksToPlan(planPath, ["", "  "]);
    // safe array is empty → lines is "" → appends "\n\n"
    expect(readPlan()).toBe("# Plan\n\n\n");
  });

  test("handles empty subtasks array", () => {
    writePlan("# Plan\n");
    appendSubtasksToPlan(planPath, []);
    expect(readPlan()).toBe("# Plan\n\n\n");
  });

  test("sanitizes combined header + strikethrough", () => {
    writePlan("");
    appendSubtasksToPlan(planPath, ["### ~~Old task~~"]);
    const result = readPlan();
    expect(result).toContain("- [ ] Old task");
    expect(result).not.toContain("#");
    expect(result).not.toContain("~~");
  });

  test("trims whitespace from subtask text", () => {
    writePlan("");
    appendSubtasksToPlan(planPath, ["  padded task  ", "\ttabbed\t"]);
    const result = readPlan();
    expect(result).toContain("- [ ] padded task");
    expect(result).toContain("- [ ] tabbed");
  });

  test("preserves existing plan content", () => {
    writePlan("# Plan\n\n- [x] Done task\n- [ ] Pending task\n");
    appendSubtasksToPlan(planPath, ["New subtask"]);
    const result = readPlan();
    expect(result).toContain("- [x] Done task");
    expect(result).toContain("- [ ] Pending task");
    expect(result).toContain("- [ ] New subtask");
  });

  test("handles subtasks with regex-special characters", () => {
    writePlan("");
    appendSubtasksToPlan(planPath, ["Fix (bug) in [module]", "Handle $var + *.log"]);
    const result = readPlan();
    // appendSubtasksToPlan doesn't need to escape — it just concatenates
    expect(result).toContain("- [ ] Fix (bug) in [module]");
    expect(result).toContain("- [ ] Handle $var + *.log");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// mark parent done on subtask emission (integration-style)
// ═══════════════════════════════════════════════════════════════════════════

describe("mark parent done on subtask emission", () => {
  test("checkbox parent marked done after subtask append", () => {
    writePlan("- [ ] Big task\n- [x] Already done\n");
    appendSubtasksToPlan(planPath, ["Sub A", "Sub B"]);
    markCheckboxDone(planPath, "Big task");
    const result = readPlan();
    expect(result).toContain("- [x] Big task");
    expect(result).toContain("- [ ] Sub A");
    expect(result).toContain("- [ ] Sub B");
  });

  test("section parent marked done after subtask append", () => {
    writePlan("## 1. Big task\nSome details\n\n## 2. Other task\nMore details\n");
    appendSubtasksToPlan(planPath, ["Sub A", "Sub B"]);
    markSectionDone(planPath, "## 1. Big task\nSome details");
    const result = readPlan();
    expect(result).toContain("## ~~1. Big task~~");
    expect(result).toContain("## 2. Other task");
    expect(result).toContain("- [ ] Sub A");
    expect(result).toContain("- [ ] Sub B");
  });

  test("next extractCurrentTask picks subtask, not parent", () => {
    writePlan("- [ ] Big task\n");
    appendSubtasksToPlan(planPath, ["Sub A", "Sub B"]);
    markCheckboxDone(planPath, "Big task");
    const plan = readPlan();
    // simulate extractCurrentTask: first unchecked checkbox
    const match = plan.match(/^- \[ \] (.+)$/m);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("Sub A");
  });
});
