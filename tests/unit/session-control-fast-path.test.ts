import { describe, expect, test } from "bun:test";
import {
  SESSION_EXIT,
  parseAgentCommand,
  parseSessionCommand,
} from "../../src/cli/session-control.ts";

describe("session control fast-path parsing", () => {
  test("parses top-level create with harness, prompt, and json", () => {
    expect(parseSessionCommand([
      "create",
      "branchout",
      "--harness",
      "pi",
      "--prompt",
      "execute .plans/000-publish-branchout.md",
      "--json",
    ])).toEqual({
      ok: true,
      action: "create",
      project: "branchout",
      harness: "pi",
      prompt: "execute .plans/000-publish-branchout.md",
      output: "json",
    });
  });

  test("parses concise status by opaque selector", () => {
    expect(parseSessionCommand(["status", "broker-session-id", "--json"])).toEqual({
      ok: true,
      action: "status",
      session: "broker-session-id",
      output: "json",
    });
  });

  test("reports agent-native usage for invalid child-agent spawn", () => {
    expect(parseAgentCommand(["spawn"])).toEqual({
      ok: false,
      message: "Usage: wolfpack agent spawn <project> [--prompt <instruction>] [--json]",
    });
  });

  test("parses unambiguous child-agent spawn", () => {
    expect(parseAgentCommand([
      "spawn",
      "branchout",
      "--prompt",
      "review the plan",
      "--json",
    ])).toEqual({
      ok: true,
      action: "spawn",
      project: "branchout",
      prompt: "review the plan",
      output: "json",
    });
  });
});

describe("session control fast-path requests", () => {
  test("create performs one atomic server request without parent context", () => {
    const script = `
      delete process.env.WOLFPACK_SESSION_NAME;
      delete process.env.WOLFPACK_AGENT_KIND;
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
        return Response.json({
          ok: true,
          session: "branchout",
          sessionId: "id-branchout",
          project: "branchout",
          harness: "pi",
        });
      };
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      const code = await runSessionCommand([
        "create", "branchout", "--harness", "pi",
        "--prompt", "execute the plan", "--json",
      ]);
      const expected = [{
        url: "http://127.0.0.1:18790/api/session-create",
        method: "POST",
        body: { project: "branchout", harness: "pi", initialPrompt: "execute the plan" },
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
      session: "branchout",
      sessionId: "id-branchout",
      project: "branchout",
      harness: "pi",
    });
  });

  test("create reports create-specific structured failures", () => {
    const script = `
      globalThis.fetch = async () => Response.json({
        error: "initial prompt requires an agent harness",
        code: "UNSUPPORTED_HARNESS",
      }, { status: 400 });
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      process.exit(await runSessionCommand(["create", "branchout", "--prompt", "execute", "--json"]));
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
        code: "UNSUPPORTED_HARNESS",
        message: "selected session command cannot accept an initial prompt",
      },
    });
  });

  test("agent spawn performs the existing one-request child flow", () => {
    const script = `
      process.env.WOLFPACK_SESSION_NAME = "wolfpack";
      process.env.WOLFPACK_AGENT_KIND = "pi";
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
        return Response.json({
          ok: true,
          session: "wolfpack-sub-agent",
          sessionId: "id-child",
          project: "branchout",
          harness: "pi",
        });
      };
      const { runAgentCommand } = await import("./src/cli/session-control.ts");
      const code = await runAgentCommand(["spawn", "branchout", "--prompt", "execute the plan", "--json"]);
      const expected = [{
        url: "http://127.0.0.1:18790/api/session-open",
        method: "POST",
        body: { project: "branchout", parentSession: "wolfpack", initialPrompt: "execute the plan" },
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
    expect(JSON.parse(child.stdout.toString()).sessionId).toBe("id-child");
  });

  test("status returns one json error envelope for an ambiguous selector", () => {
    const script = `
      globalThis.fetch = async () => Response.json({ error: "ambiguous session selector" }, { status: 409 });
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      process.exit(await runSessionCommand(["status", "collision", "--json"]));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(SESSION_EXIT.GENERAL);
    expect(child.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      ok: false,
      error: { code: "AMBIGUOUS_SELECTOR", message: "ambiguous session selector" },
    });
  });

  test("status preserves canonical name and id returned for an id selector", () => {
    const script = `
      globalThis.fetch = async (url) => {
        if (!String(url).includes("/api/session-control/status?session=id-branchout")) process.exit(98);
        return Response.json({
          ok: true,
          session: "branchout",
          sessionId: "id-branchout",
          state: "active",
          projectPath: "/tmp/branchout",
          harness: "pi",
        });
      };
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      process.exit(await runSessionCommand(["status", "id-branchout", "--json"]));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(SESSION_EXIT.OK);
    expect(JSON.parse(child.stdout.toString())).toMatchObject({
      session: "branchout",
      sessionId: "id-branchout",
      state: "active",
      harness: "pi",
    });
  });
});
