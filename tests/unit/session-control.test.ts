import { describe, expect, test } from "bun:test";
import { SESSION_EXIT, parseSessionCommand } from "../../src/cli/session-control.ts";

describe("session control cli parsing", () => {
  test("parses read with json output", () => {
    expect(parseSessionCommand(["read", "alpha", "--json"])).toEqual({
      ok: true,
      action: "read",
      session: "alpha",
      output: "json",
    });
  });

  test("parses send text and no-enter flag", () => {
    expect(parseSessionCommand(["send", "alpha", "echo", "hi", "--no-enter"])).toEqual({
      ok: true,
      action: "send",
      session: "alpha",
      text: "echo hi",
      noEnter: true,
      output: "plain",
    });
  });

  test("parses wait timeout", () => {
    expect(parseSessionCommand(["wait", "alpha", "ready", "--timeout-ms", "250"])).toEqual({
      ok: true,
      action: "wait",
      session: "alpha",
      text: "ready",
      timeoutMs: 250,
      output: "plain",
    });
  });

  test("rejects invalid wait timeout", () => {
    const parsed = parseSessionCommand(["wait", "alpha", "ready", "--timeout-ms", "0"]);
    expect(parsed.ok).toBe(false);
  });

  test("parses current context shell output", () => {
    expect(parseSessionCommand(["current-context", "--shell"])).toEqual({
      ok: true,
      action: "current-context",
      output: "shell",
    });
  });

  test("rejects shell output for server-backed commands", () => {
    const parsed = parseSessionCommand(["read", "alpha", "--shell"]);
    expect(parsed.ok).toBe(false);
  });

  test("exit code map is stable", () => {
    expect(SESSION_EXIT).toEqual({
      OK: 0,
      GENERAL: 1,
      USAGE: 2,
      NOT_FOUND: 3,
      TIMEOUT: 4,
      AUTH: 5,
      BACKEND_UNAVAILABLE: 6,
    });
  });
});
