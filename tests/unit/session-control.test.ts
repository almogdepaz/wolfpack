import { describe, expect, test } from "bun:test";
import {
  SESSION_EXIT,
  parseSessionCommand,
  resolveSessionOpenContext,
} from "../../src/cli/session-control.ts";

describe("session control cli parsing", () => {
  test("parses open with project and json output", () => {
    expect(parseSessionCommand(["open", "wolfpack", "--json"])).toEqual({
      ok: true,
      action: "open",
      selector: { kind: "project", project: "wolfpack" },
      prompt: undefined,
      output: "json",
    });
  });

  test("parses an explicit launch instruction and model without inherited context", () => {
    expect(parseSessionCommand([
      "open",
      "wolfpack",
      "--model",
      "anthropic/claude-opus-4-1",
      "--prompt",
      "perform differential review only",
      "--json",
    ])).toEqual({
      ok: true,
      action: "open",
      selector: { kind: "project", project: "wolfpack" },
      model: "anthropic/claude-opus-4-1",
      prompt: "perform differential review only",
      output: "json",
    });
  });

  test("preserves ordinary flag-shaped prompt text and supports explicit known-option text", () => {
    expect(parseSessionCommand(["open", "wolfpack", "--prompt", "--review-only"])).toEqual({
      ok: true,
      action: "open",
      selector: { kind: "project", project: "wolfpack" },
      prompt: "--review-only",
      output: "plain",
    });
    expect(parseSessionCommand(["open", "wolfpack", "--prompt=--json"])).toEqual({
      ok: true,
      action: "open",
      selector: { kind: "project", project: "wolfpack" },
      prompt: "--json",
      output: "plain",
    });
  });

  test("rejects open without a project, invalid prompts, or unsupported flags", () => {
    expect(parseSessionCommand(["open"]).ok).toBe(false);
    expect(parseSessionCommand(["open", "wolfpack", "--prompt"]).ok).toBe(false);
    expect(parseSessionCommand(["open", "wolfpack", "--prompt", "--json"]).ok).toBe(false);
    expect(parseSessionCommand(["open", "wolfpack", "--prompt", " "]).ok).toBe(false);
    expect(parseSessionCommand(["open", "wolfpack", "--prompt", "x".repeat(32_769)]).ok).toBe(false);
    expect(parseSessionCommand(["open", "wolfpack", "--harness", "claude"]).ok).toBe(false);
  });

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

  test("accepts an astral prompt below the Unicode code-point maximum", () => {
    const prompt = "🚀".repeat(20_000);
    const parsed = parseSessionCommand([
      "prompt",
      "alpha",
      prompt,
      "--until",
      "READY",
    ]);

    expect(parsed).toMatchObject({ ok: true, action: "prompt", prompt });
  });

  test("parses one-request prompt and output wait", () => {
    expect(parseSessionCommand([
      "prompt",
      "alpha",
      "run",
      "the",
      "check",
      "--until",
      "READY",
      "--timeout-ms",
      "250",
      "--no-enter",
      "--json",
    ])).toEqual({
      ok: true,
      action: "prompt",
      session: "alpha",
      prompt: "run the check",
      outputContains: "READY",
      timeoutMs: 250,
      noEnter: true,
      output: "json",
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

  test("prompt performs exactly one server-owned prompt-and-wait request", () => {
    const script = `
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
        return Response.json({
          ok: true,
          session: "alpha",
          sessionId: "id-alpha",
          outcome: "matched",
          outputBoundarySeq: "12",
        });
      };
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      const code = await runSessionCommand([
        "prompt", "alpha", "run", "check", "--until", "READY", "--timeout-ms", "250", "--json",
      ]);
      const expected = [{
        url: "http://127.0.0.1:18790/api/session-control/prompt",
        method: "POST",
        body: {
          session: "alpha",
          prompt: "run check",
          outputContains: "READY",
          noEnter: false,
          timeoutMs: 250,
        },
      }];
      if (JSON.stringify(calls) !== JSON.stringify(expected)) process.exit(99);
      process.exit(code);
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(SESSION_EXIT.OK);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      ok: true,
      session: "alpha",
      sessionId: "id-alpha",
      outcome: "matched",
      outputBoundarySeq: "12",
    });
  });

  test("prompt maps every phase-1 terminal outcome to a stable exit code", () => {
    const cases = [
      ["matched", SESSION_EXIT.OK],
      ["timed_out", SESSION_EXIT.TIMEOUT],
      ["target_exited", SESSION_EXIT.NOT_FOUND],
      ["target_unavailable", SESSION_EXIT.NOT_FOUND],
      ["replay_gap", SESSION_EXIT.GENERAL],
      ["backend_unavailable", SESSION_EXIT.BACKEND_UNAVAILABLE],
    ] as const;

    for (const [outcome, expectedExit] of cases) {
      const script = `
        globalThis.fetch = async () => Response.json({
          ok: ${outcome === "matched"},
          session: "alpha",
          sessionId: "id-alpha",
          outcome: ${JSON.stringify(outcome)},
          outputBoundarySeq: "12",
        });
        const { runSessionCommand } = await import("./src/cli/session-control.ts");
        process.exit(await runSessionCommand(["prompt", "alpha", "run", "--until", "READY", "--json"]));
      `;
      const child = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: process.cwd(),
        env: { ...process.env, NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, outcome).toBe(expectedExit);
      expect(JSON.parse(child.stdout.toString()).outcome).toBe(outcome);
    }
  });

  test("open performs exactly one server-owned session-open request", () => {
    const script = `
      process.env.WOLFPACK_SESSION_NAME = "pi-main";
      process.env.WOLFPACK_AGENT_KIND = "pi";
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
        return Response.json({
          ok: true,
          session: "pi-main-sub-agent-2",
          sessionId: "id-child-2",
          project: "wolfpack",
          harness: "pi",
        });
      };
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      const code = await runSessionCommand([
        "open",
        "wolfpack",
        "--model",
        "anthropic/claude-opus-4-1",
        "--prompt",
        "perform differential review only",
        "--json",
      ]);
      const expected = [{
        url: "http://127.0.0.1:18790/api/session-open",
        method: "POST",
        body: {
          project: "wolfpack",
          parentSession: "pi-main",
          model: "anthropic/claude-opus-4-1",
          initialPrompt: "perform differential review only",
        },
      }];
      if (JSON.stringify(calls) !== JSON.stringify(expected)) {
        console.error(JSON.stringify({ calls, expected }));
        process.exit(99);
      }
      process.exit(code);
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(SESSION_EXIT.OK);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      ok: true,
      session: "pi-main-sub-agent-2",
      sessionId: "id-child-2",
      project: "wolfpack",
      harness: "pi",
    });
  });

  test("open preserves a structured server failure", () => {
    const script = `
      process.env.WOLFPACK_SESSION_NAME = "pi-main";
      process.env.WOLFPACK_AGENT_KIND = "pi";
      globalThis.fetch = async (url) => {
        if (!String(url).endsWith("/api/session-open")) process.exit(98);
        return Response.json({
          error: "parent session not found",
          code: "PARENT_SESSION_NOT_FOUND",
        }, { status: 404 });
      };
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      process.exit(await runSessionCommand(["open", "wolfpack", "--json"]));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(SESSION_EXIT.NOT_FOUND);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      ok: false,
      error: {
        code: "PARENT_SESSION_NOT_FOUND",
        message: "parent Wolfpack session is not active",
      },
    });
  });

  test("open preserves structured parent-change failures", () => {
    const script = `
      process.env.WOLFPACK_SESSION_NAME = "pi-main";
      process.env.WOLFPACK_AGENT_KIND = "pi";
      globalThis.fetch = async () => Response.json({
        error: "parent session identity changed",
        code: "PARENT_SESSION_CHANGED",
      }, { status: 409 });
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      process.exit(await runSessionCommand(["open", "wolfpack", "--json"]));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(SESSION_EXIT.GENERAL);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      ok: false,
      error: {
        code: "PARENT_SESSION_CHANGED",
        message: "parent Wolfpack session changed",
      },
    });
  });

  test("open returns one JSON error when Wolfpack parent context is missing", () => {
    const script = `
      delete process.env.WOLFPACK_SESSION_NAME;
      process.env.WOLFPACK_AGENT_KIND = "pi";
      globalThis.fetch = async () => { throw new Error("fetch must not run"); };
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      process.exit(await runSessionCommand(["open", "wolfpack", "--json"]));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(SESSION_EXIT.NOT_FOUND);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      ok: false,
      error: {
        code: "MISSING_PARENT_SESSION",
        message: "wolfpack session context is missing",
      },
    });
  });

  test("keeps JWT warnings on stderr so JSON stdout is one envelope", () => {
    const script = `
      process.env.WOLFPACK_SESSION_NAME = "pi-main";
      process.env.WOLFPACK_AGENT_KIND = "pi";
      process.env.WOLFPACK_JWT_SECRET = "too-short";
      globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      process.exit(await runSessionCommand(["open", "wolfpack", "--json"]));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(SESSION_EXIT.AUTH);
    expect(child.stderr.toString()).toContain("WOLFPACK_JWT_SECRET is set but only 9 chars; >=32 required");
    expect(child.stderr.toString()).not.toContain("\x1b[");
    expect(child.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      ok: false,
      error: { code: "AUTH_REQUIRED", message: "auth required" },
    });
  });

  test("human usage failures write uncolored diagnostics to stderr", () => {
    const script = `
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      process.exit(await runSessionCommand(["definitely-not-an-action"]));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode).toBe(SESSION_EXIT.USAGE);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toContain("Unknown session command: definitely-not-an-action");
    expect(child.stderr.toString()).not.toContain("\x1b[");
  });

  test("resolves open context only from a supported Wolfpack parent", () => {
    expect(resolveSessionOpenContext({
      WOLFPACK_SESSION_NAME: "pi-main",
      WOLFPACK_AGENT_KIND: "pi",
    })).toEqual({ ok: true, parentSession: "pi-main", harness: "pi" });
    expect(resolveSessionOpenContext({ WOLFPACK_AGENT_KIND: "pi" })).toEqual({
      ok: false,
      code: "MISSING_PARENT_SESSION",
      message: "wolfpack session context is missing",
    });
    expect(resolveSessionOpenContext({
      WOLFPACK_SESSION_NAME: "shell-main",
      WOLFPACK_AGENT_KIND: "shell",
    })).toEqual({
      ok: false,
      code: "UNSUPPORTED_HARNESS",
      message: "current Wolfpack session is not running a supported agent harness",
    });
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
