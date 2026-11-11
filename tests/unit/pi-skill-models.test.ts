import { describe, expect, test } from "bun:test";
import { WOLFPACK_PI_CONTROL_SKILL_FILES } from "../../src/cli/pi-skill.ts";

// concrete model IDs belong to user configuration (pi settings, role env vars), not to the shipped skill.
const MODEL_ID_PATTERN = /openai-codex\/|\bgpt-\d|\bclaude-(?:opus|sonnet|haiku|fable)-/i;

describe("wolfpack-tailnet-control skill role models", () => {
  test("names no concrete model", () => {
    for (const { filename, content } of WOLFPACK_PI_CONTROL_SKILL_FILES) {
      expect({ filename, match: content.match(MODEL_ID_PATTERN)?.[0] }).toEqual({ filename, match: undefined });
    }
  });

  test("passes the role variable when set and otherwise falls back to the pi default", () => {
    const skill = WOLFPACK_PI_CONTROL_SKILL_FILES.find(({ filename }) => filename === "SKILL.md")?.content ?? "";
    expect(skill).toContain('--model "$WOLFPACK_IMPLEMENTER_MODEL"');
    expect(skill).toContain('--model "$WOLFPACK_REVIEWER_MODEL"');
    expect(skill).toContain("otherwise omit `--model`");
  });
});
