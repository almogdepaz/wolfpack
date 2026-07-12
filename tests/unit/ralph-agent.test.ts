import { describe, expect, test } from "bun:test";
import {
  configuredRalphAgents,
  selectConfiguredRalphAgent,
} from "../../src/ralph-agent.ts";

describe("configuredRalphAgents", () => {
  test("keeps only exact supported agent commands in configured order", () => {
    expect(configuredRalphAgents([
      "shell",
      "codex",
      "claude --dangerously-skip-permissions",
      "gemini",
      "codex",
      "pi",
    ])).toEqual(["codex", "gemini"]);
  });
});

describe("selectConfiguredRalphAgent", () => {
  test("accepts an explicitly configured agent", () => {
    expect(selectConfiguredRalphAgent("gemini", ["codex", "gemini"])).toBe("gemini");
  });

  test("rejects an agent outside the configured set", () => {
    expect(selectConfiguredRalphAgent("claude", ["codex", "gemini"])).toBeNull();
  });

  test("defaults to the first configured agent", () => {
    expect(selectConfiguredRalphAgent(undefined, ["codex", "gemini"])).toBe("codex");
  });

  test("rejects launch when no ralph-capable agents are configured", () => {
    expect(selectConfiguredRalphAgent(undefined, [])).toBeNull();
  });
});
