import { AGENT_KIND } from "./agent-kind.js";
import type { RalphAgent } from "./ralph-agent.js";
import { RALPH_RESPONSE_VERSION, RalphResponseStatus } from "./ralph-response.js";

export const RALPH_ALLOWED_TOOLS = [
  "Edit", "Write", "Read", "Glob", "Grep",
  "Bash(git *)", "Bash(npm *)", "Bash(npx *)", "Bash(pnpm *)",
  "Bash(yarn *)", "Bash(bun *)", "Bash(cargo *)", "Bash(go *)",
  "Bash(python *)", "Bash(pip *)", "Bash(pytest *)", "Bash(make *)",
  "Bash(ls *)", "Bash(mkdir *)", "Bash(rm *)", "Bash(mv *)",
  "Bash(cp *)", "Bash(cat *)", "Bash(echo *)", "Bash(touch *)",
].join(",");

export const RALPH_RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "status", "prereqs", "tests", "done", "subtasks"],
  properties: {
    version: { type: "number", const: RALPH_RESPONSE_VERSION },
    status: { type: "string", enum: [RalphResponseStatus.done, RalphResponseStatus.needsSubtasks] },
    prereqs: { type: "array", items: { type: "string" } },
    tests: { type: "array", items: { type: "string" } },
    done: { type: "array", items: { type: "string" } },
    subtasks: { type: "array", items: { type: "string" } },
  },
} as const;

export interface BuildAgentArgsOptions {
  readonly prompt: string;
  readonly responseFile: string;
  readonly responseSchemaFile: string;
}

export function agentBinaryName(agent: RalphAgent): string {
  return agent === AGENT_KIND.CURSOR ? "agent" : agent;
}

export function buildAgentArgs(agent: RalphAgent, options: BuildAgentArgsOptions): string[] {
  switch (agent) {
    case AGENT_KIND.CLAUDE:
      return ["--model", "sonnet", "--print", "--dangerously-skip-permissions", "--allowedTools", RALPH_ALLOWED_TOOLS, "-p", options.prompt];
    case AGENT_KIND.CODEX:
      return [
        "exec",
        "--disable", "apps",
        "--dangerously-bypass-approvals-and-sandbox",
        "--output-last-message", options.responseFile,
        "--output-schema", options.responseSchemaFile,
        options.prompt,
      ];
    case AGENT_KIND.GEMINI:
      return ["-p", options.prompt, "--yolo"];
    case AGENT_KIND.CURSOR:
      return ["-p", options.prompt, "--yolo"];
  }
}
