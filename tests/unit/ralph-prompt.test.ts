import { describe, expect, test } from "bun:test";
import { buildIterationPrompt } from "../../src/ralph-prompt.js";

describe("buildIterationPrompt", () => {
  test("prompt uses a json response file as the runner control channel", () => {
    const prompt = buildIterationPrompt({
      agent: "claude",
      workingDir: "/tmp/project",
      taskDesc: "implement the feature",
      planFile: "PLAN.md",
      progressFile: "progress.txt",
      responseFile: "/tmp/project/.ralph-response.json",
    });

    expect(prompt).toContain("/tmp/project/.ralph-response.json");
    expect(prompt).toContain('"status": "needs_subtasks"');
    expect(prompt).toContain('"subtasks": [');
    expect(prompt).not.toContain('"status": "done" | "needs_subtasks"');
    expect(prompt).not.toContain("<subtasks>");
  });

  test("prompt shows valid json examples for every supported agent", () => {
    for (const agent of ["claude", "codex", "gemini", "cursor"] as const) {
      const prompt = buildIterationPrompt({
        agent,
        workingDir: "/tmp/project",
        taskDesc: "implement the feature",
        planFile: "PLAN.md",
        progressFile: "progress.txt",
        responseFile: "/tmp/project/.ralph-response.json",
      });

      expect(prompt).toContain('"status": "done"');
      expect(prompt).toContain('"status": "needs_subtasks"');
      expect(prompt).not.toContain('"status": "done" | "needs_subtasks"');
      expect(prompt).not.toContain("<subtasks>");
    }
  });

  test("prompt tells agents not to commit runner-owned files", () => {
    const prompt = buildIterationPrompt({
      agent: "claude",
      workingDir: "/tmp/project",
      taskDesc: "implement the feature",
      planFile: "PLAN.md",
      progressFile: "progress.txt",
      responseFile: "/tmp/project/.ralph-response.json",
    });

    expect(prompt).toContain("Do NOT commit .ralph-response.json");
    expect(prompt).toContain("progress.txt");
    expect(prompt).toContain(".ralph.log");
    expect(prompt).toContain(".ralph-response-schema-*.json");
  });

  test("codex prompt uses the same json response protocol", () => {
    const prompt = buildIterationPrompt({
      agent: "codex",
      workingDir: "/tmp/project",
      taskDesc: "implement the feature",
      planFile: "PLAN.md",
      progressFile: "progress.txt",
      responseFile: "/tmp/project/.ralph-response.json",
    });

    expect(prompt).toContain("/tmp/project/.ralph-response.json");
    expect(prompt).toContain("DO NOT emit XML-ish control tags");
    expect(prompt).not.toContain("break it into subtasks");
    expect(prompt).not.toContain("<subtasks>");
  });
});
