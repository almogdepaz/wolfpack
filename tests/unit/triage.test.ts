import { describe, expect, test } from "bun:test";
import { isJunkLine } from "../../src/triage.ts";

describe("isJunkLine", () => {
  // ── box-drawing lines ──
  test("matches lines of box-drawing chars", () => {
    expect(isJunkLine("─────────────────────")).toBe(true);
    expect(isJunkLine("━━━━━━━━━━━━")).toBe(true);
    expect(isJunkLine("═══════════════")).toBe(true);
    expect(isJunkLine("╔═══════════════╗")).toBe(true);
    expect(isJunkLine("│               │")).toBe(true);
    expect(isJunkLine("┌───────────────┐")).toBe(true);
    expect(isJunkLine("╭───────────────╮")).toBe(true);
  });

  test("does not match lines with text content among box-drawing", () => {
    expect(isJunkLine("│ hello world │")).toBe(false);
    expect(isJunkLine("┌ error: something ┐")).toBe(false);
  });

  // ── Claude Code hint bar ──
  test("matches Claude Code hint bar (accept edits)", () => {
    expect(isJunkLine("  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt")).toBe(true);
  });

  test("matches esc to interrupt", () => {
    expect(isJunkLine("esc to interrupt")).toBe(true);
  });

  // ── bare prompts ──
  test("matches bare shell prompts", () => {
    expect(isJunkLine("$ ")).toBe(true);
    expect(isJunkLine("❯ ")).toBe(true);
    expect(isJunkLine("% ")).toBe(true);
    expect(isJunkLine("> ")).toBe(true);
    expect(isJunkLine("  $ ")).toBe(true);
  });

  test("does not match prompts with commands after them", () => {
    expect(isJunkLine("$ ls -la")).toBe(false);
    expect(isJunkLine("❯ npm test")).toBe(false);
  });

  // ── whitespace ──
  test("matches whitespace-only lines", () => {
    expect(isJunkLine("")).toBe(true);
    expect(isJunkLine("   ")).toBe(true);
    expect(isJunkLine("\t")).toBe(true);
    expect(isJunkLine("  \t  ")).toBe(true);
  });

  // ── real content is not junk ──
  test("does not match real content", () => {
    expect(isJunkLine("Error: module not found")).toBe(false);
    expect(isJunkLine("✽ Cerebrating…")).toBe(false);
    expect(isJunkLine("compiling...")).toBe(false);
    expect(isJunkLine("Running 10 tests using 5 workers")).toBe(false);
    expect(isJunkLine("Do you want to continue? (y/n)")).toBe(false);
  });
});
