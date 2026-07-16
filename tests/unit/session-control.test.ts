import { describe, expect, test } from "bun:test";
import {
  SESSION_EXIT,
  chooseSubAgentSessionName,
  parseSessionCommand,
  resolveSessionOpenContext,
} from "../../src/cli/session-control.ts";

describe("session control cli parsing", () => {
  test("parses open with project and json output", () => {
    expect(parseSessionCommand(["open", "wolfpack", "--json"])).toEqual({
      ok: true,
      action: "open",
      project: "wolfpack",
      prompt: undefined,
      output: "json",
    });
  });

  test("parses an explicit launch instruction without inherited context", () => {
    expect(parseSessionCommand([
      "open",
      "wolfpack",
      "--prompt",
      "perform differential review only",
      "--json",
    ])).toEqual({
      ok: true,
      action: "open",
      project: "wolfpack",
      prompt: "perform differential review only",
      output: "json",
    });
  });

  test("preserves a launch instruction that resembles a CLI flag", () => {
    expect(parseSessionCommand(["open", "wolfpack", "--prompt", "--review-only"])).toEqual({
      ok: true,
      action: "open",
      project: "wolfpack",
      prompt: "--review-only",
      output: "plain",
    });
  });

  test("rejects open without a project, invalid prompts, or unsupported flags", () => {
    expect(parseSessionCommand(["open"]).ok).toBe(false);
    expect(parseSessionCommand(["open", "wolfpack", "--prompt"]).ok).toBe(false);
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

  test("opens a numbered same-harness child with structured parent context", () => {
    const script = `
      process.env.WOLFPACK_SESSION_NAME = "pi-main";
      process.env.WOLFPACK_AGENT_KIND = "pi";
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith("/api/sessions")) {
          return Response.json({ sessions: [{ name: "pi-main" }, { name: "pi-main-sub-agent" }] });
        }
        if (String(url).endsWith("/api/create")) {
          const body = JSON.parse(String(init?.body));
          const expected = {
            project: "wolfpack",
            cmd: "pi",
            sessionName: "pi-main-sub-agent-2",
            parentSession: "pi-main",
            initialPrompt: "perform differential review only",
          };
          if (JSON.stringify(body) !== JSON.stringify(expected)) {
            return Response.json({ error: "unexpected request", body }, { status: 400 });
          }
          return Response.json({ ok: true, session: "pi-main-sub-agent-2" });
        }
        return Response.json({ error: "unexpected URL" }, { status: 500 });
      };
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      process.exit(await runSessionCommand([
        "open",
        "wolfpack",
        "--prompt",
        "perform differential review only",
        "--json",
      ]));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(SESSION_EXIT.OK);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      ok: true,
      session: "pi-main-sub-agent-2",
      project: "wolfpack",
      harness: "pi",
    });
  });

  test("open retries a structured collision with the next available number", () => {
    const script = `
      process.env.WOLFPACK_SESSION_NAME = "pi-main";
      process.env.WOLFPACK_AGENT_KIND = "pi";
      let listCount = 0;
      let createCount = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith("/api/sessions")) {
          listCount++;
          return Response.json({ sessions: listCount === 1
            ? [{ name: "pi-main" }, { name: "pi-main-sub-agent" }]
            : [{ name: "pi-main" }, { name: "pi-main-sub-agent" }, { name: "pi-main-sub-agent-2" }]
          });
        }
        if (String(url).endsWith("/api/create")) {
          createCount++;
          const body = JSON.parse(String(init?.body));
          if (createCount === 1 && body.sessionName === "pi-main-sub-agent-2") {
            return Response.json({ error: "anything" }, { status: 409 });
          }
          if (createCount === 2 && body.sessionName === "pi-main-sub-agent-3") {
            return Response.json({ ok: true, session: body.sessionName });
          }
        }
        return Response.json({ error: "unexpected request" }, { status: 500 });
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
    expect(child.exitCode).toBe(SESSION_EXIT.OK);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      ok: true,
      session: "pi-main-sub-agent-3",
      project: "wolfpack",
      harness: "pi",
    });
  });

  test("open preserves a structured parent-disappeared error from create", () => {
    const script = `
      process.env.WOLFPACK_SESSION_NAME = "pi-main";
      process.env.WOLFPACK_AGENT_KIND = "pi";
      globalThis.fetch = async (url) => {
        if (String(url).endsWith("/api/sessions")) {
          return Response.json({ sessions: [{ name: "pi-main" }] });
        }
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

  test("warns when a configured JWT secret is too short", () => {
    const script = `
      process.env.WOLFPACK_JWT_SECRET = "too-short";
      globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      const code = await runSessionCommand(["read", "alpha"]);
      console.log("exit=" + code);
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = child.stdout.toString();
    expect(child.exitCode).toBe(0);
    expect(output).toContain("WOLFPACK_JWT_SECRET is set but only 9 chars; >=32 required");
    expect(output).toContain("exit=5");
  });

  test("chooses parent-scoped numbered sub-agent names", () => {
    expect(chooseSubAgentSessionName("wolfpack", [])).toBe("wolfpack-sub-agent");
    expect(chooseSubAgentSessionName("wolfpack", ["wolfpack-sub-agent"]))
      .toBe("wolfpack-sub-agent-2");
    expect(chooseSubAgentSessionName("wolfpack", ["wolfpack-sub-agent", "wolfpack-sub-agent-3"]))
      .toBe("wolfpack-sub-agent-2");
    expect(chooseSubAgentSessionName("another-parent", ["wolfpack-sub-agent"]))
      .toBe("another-parent-sub-agent");
  });

  test("truncates only the parent prefix to keep numbered names valid", () => {
    const parent = "p".repeat(100);
    const first = chooseSubAgentSessionName(parent, []);
    const second = chooseSubAgentSessionName(parent, [first]);
    expect(first).toHaveLength(100);
    expect(first.endsWith("-sub-agent")).toBe(true);
    expect(second).toHaveLength(100);
    expect(second.endsWith("-sub-agent-2")).toBe(true);
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
