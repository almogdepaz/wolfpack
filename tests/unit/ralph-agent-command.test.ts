import { describe, expect, test } from "bun:test";
import { buildAgentArgs, RALPH_RESPONSE_JSON_SCHEMA } from "../../src/ralph-agent-command.js";

describe("buildAgentArgs", () => {
  test("codex uses native structured output files instead of prompt-only response handling", () => {
    const args = buildAgentArgs("codex", {
      prompt: "do the task",
      responseFile: "/tmp/work/.ralph-response.json",
      responseSchemaFile: "/tmp/project/.ralph-response-schema.json",
    });

    expect(args).toEqual([
      "exec",
      "--disable", "apps",
      "--dangerously-bypass-approvals-and-sandbox",
      "--output-last-message", "/tmp/work/.ralph-response.json",
      "--output-schema", "/tmp/project/.ralph-response-schema.json",
      "do the task",
    ]);
    expect(args).not.toContain("--yolo");
  });

  test("all agents receive the same ralph response file contract", () => {
    for (const agent of ["claude", "codex", "gemini", "cursor"] as const) {
      const args = buildAgentArgs(agent, {
        prompt: "write /tmp/work/.ralph-response.json before exiting",
        responseFile: "/tmp/work/.ralph-response.json",
        responseSchemaFile: "/tmp/project/.ralph-response-schema.json",
      });

      expect(args.join("\n")).toContain("/tmp/work/.ralph-response.json");
    }
  });

  test("other agents keep their existing prompt-driven invocation", () => {
    expect(buildAgentArgs("claude", {
      prompt: "do the task",
      responseFile: "/tmp/work/.ralph-response.json",
      responseSchemaFile: "/tmp/project/.ralph-response-schema.json",
    })).toContain("do the task");

    expect(buildAgentArgs("gemini", {
      prompt: "do the task",
      responseFile: "/tmp/work/.ralph-response.json",
      responseSchemaFile: "/tmp/project/.ralph-response-schema.json",
    })).toEqual(["-p", "do the task", "--yolo"]);

    expect(buildAgentArgs("cursor", {
      prompt: "do the task",
      responseFile: "/tmp/work/.ralph-response.json",
      responseSchemaFile: "/tmp/project/.ralph-response-schema.json",
    })).toEqual(["-p", "do the task", "--yolo"]);
  });
});

describe("RALPH_RESPONSE_JSON_SCHEMA", () => {
  test("pins the response status enum to runner-supported values", () => {
    expect(RALPH_RESPONSE_JSON_SCHEMA.properties.status).toEqual({
      type: "string",
      enum: ["done", "needs_subtasks"],
    });
  });

  test("uses codex/openai-compatible typed const fields", () => {
    expect(RALPH_RESPONSE_JSON_SCHEMA.properties.version).toEqual({
      type: "number",
      const: 1,
    });
  });
});
