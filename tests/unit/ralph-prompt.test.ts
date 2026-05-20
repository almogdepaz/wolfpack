import { describe, expect, test } from "bun:test";
import { buildIterationPrompt } from "../../src/ralph-prompt.js";

describe("buildIterationPrompt", () => {
  test("claude prompt advertises the subtask control channel", () => {
    const prompt = buildIterationPrompt({
      agent: "claude",
      workingDir: "/tmp/project",
      taskDesc: "implement the feature",
      planFile: "PLAN.md",
      progressFile: "progress.txt",
    });

    expect(prompt).toContain("<subtasks>");
    expect(prompt).toContain("The task runner handles all plan mutations");
  });

  test("codex prompt does not advertise subtasks because codex stdout is not a trusted control channel", () => {
    const prompt = buildIterationPrompt({
      agent: "codex",
      workingDir: "/tmp/project",
      taskDesc: "implement the feature",
      planFile: "PLAN.md",
      progressFile: "progress.txt",
    });

    expect(prompt).not.toContain("<subtasks>");
    expect(prompt).not.toContain("break it into subtasks");
    expect(prompt).toContain("Do NOT emit XML-ish control tags");
  });
});
