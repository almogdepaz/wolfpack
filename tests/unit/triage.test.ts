import { describe, expect, test } from "bun:test";
import { classifySession } from "../../triage.ts";

describe("classifySession", () => {
  // ── needs-input ──

  test("detects y/n prompt", () => {
    expect(classifySession("Overwrite file? (y/n)", 999)).toBe("needs-input");
  });

  test("detects [Y/n] prompt", () => {
    expect(classifySession("Install? [Y/n]", 999)).toBe("needs-input");
  });

  test("detects [yes/no] prompt", () => {
    expect(classifySession("Are you sure? [yes/no]", 999)).toBe("needs-input");
  });

  test("detects Do you want to", () => {
    expect(classifySession("Do you want to continue?", 999)).toBe("needs-input");
  });

  test("detects Press Enter", () => {
    expect(classifySession("Press Enter to continue", 999)).toBe("needs-input");
  });

  test("detects permission keyword", () => {
    expect(classifySession("Grant permission to access", 999)).toBe("needs-input");
  });

  test("detects approve keyword", () => {
    expect(classifySession("Type approve to continue", 999)).toBe("needs-input");
  });

  test("detects waiting for", () => {
    expect(classifySession("waiting for input", 999)).toBe("needs-input");
  });

  test("detects (yes/no) prompt", () => {
    expect(classifySession("Remove entry (yes/no)", 999)).toBe("needs-input");
  });

  test("detects trailing ? $", () => {
    expect(classifySession("Continue? ", 999)).toBe("needs-input");
  });

  // ── error ──

  test("detects Error: prefix", () => {
    expect(classifySession("Error: module not found", 999)).toBe("error");
  });

  test("detects error[ prefix", () => {
    expect(classifySession("error[E0001]: type mismatch", 999)).toBe("error");
  });

  test("detects failed keyword", () => {
    expect(classifySession("Build failed with 3 errors", 999)).toBe("error");
  });

  test("detects ❌ emoji", () => {
    expect(classifySession("❌ Tests failed", 999)).toBe("error");
  });

  test("detects panic:", () => {
    expect(classifySession("panic: runtime error", 999)).toBe("error");
  });

  test("detects FATAL", () => {
    expect(classifySession("FATAL exception in main", 999)).toBe("error");
  });

  test("detects unhandled", () => {
    expect(classifySession("unhandled promise rejection", 999)).toBe("error");
  });

  test("detects segfault", () => {
    expect(classifySession("segfault at 0x0", 999)).toBe("error");
  });

  // ── running ──

  test("running when activity age <= 20s", () => {
    expect(classifySession("$ compiling...", 10)).toBe("running");
  });

  test("running at exactly 20s", () => {
    expect(classifySession("normal output", 20)).toBe("running");
  });

  // ── idle ──

  test("idle when activity age > 20s", () => {
    expect(classifySession("$ ", 21)).toBe("idle");
  });

  test("idle with old activity", () => {
    expect(classifySession("normal output", 300)).toBe("idle");
  });

  // ── priority: input > error > running > idle ──

  test("input takes priority over error patterns", () => {
    // "failed" is error pattern, but "Do you want to" is input
    expect(classifySession("Task failed. Do you want to retry?", 5)).toBe("needs-input");
  });

  test("error takes priority over running (even if recent activity)", () => {
    expect(classifySession("Error: compilation failed", 5)).toBe("error");
  });

  // ── edge cases ──

  test("empty string with old activity = idle", () => {
    expect(classifySession("", 999)).toBe("idle");
  });

  test("empty string with recent activity = running", () => {
    expect(classifySession("", 5)).toBe("running");
  });
});
