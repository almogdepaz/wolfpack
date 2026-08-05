import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("parses explicit shell selection for a top-level session", () => {
    expect(parseSessionCommand([
      "create",
      "branchout",
      "--harness",
      "shell",
      "--json",
    ])).toEqual({
      ok: true,
      action: "create",
      project: "branchout",
      harness: "shell",
      prompt: undefined,
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
      message: "Usage: wolfpack agent spawn <project> [--name <session>] [--prompt|--prompt-file|--plan <value>] [--notify-parent] [--json]",
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

  test("parses child-agent spawn with meaningful requested name", () => {
    expect(parseAgentCommand([
      "spawn",
      "branchout",
      "--name",
      "issue-200-reviewer",
      "--prompt",
      "review the plan",
      "--json",
    ])).toEqual({
      ok: true,
      action: "spawn",
      project: "branchout",
      sessionName: "issue-200-reviewer",
      prompt: "review the plan",
      output: "json",
    });
  });

  test("parses compact plan spawn with parent notification", () => {
    expect(parseAgentCommand([
      "spawn",
      "branchout",
      "--plan",
      ".plans/009-subagent-token-cost-optimizations.md",
      "--notify-parent",
      "--json",
    ])).toEqual({
      ok: true,
      action: "spawn",
      project: "branchout",
      prompt: undefined,
      plan: ".plans/009-subagent-token-cost-optimizations.md",
      notifyParent: true,
      output: "json",
    });
  });

  test("rejects ambiguous launch prompt sources", () => {
    expect(parseAgentCommand(["spawn", "branchout", "--prompt", "x", "--plan", ".plans/x.md"]).ok).toBe(false);
    expect(parseAgentCommand(["spawn", "branchout", "--prompt-file", "prompt.txt", "--plan", ".plans/x.md"]).ok).toBe(false);
    expect(parseSessionCommand(["create", "branchout", "--notify-parent"]).ok).toBe(false);
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
      const code = await runAgentCommand(["spawn", "branchout", "--name", "issue-200-reviewer", "--prompt", "execute the plan", "--json"]);
      const expected = [{
        url: "http://127.0.0.1:18790/api/session-open",
        method: "POST",
        body: { project: "branchout", parentSession: "wolfpack", sessionName: "issue-200-reviewer", initialPrompt: "execute the plan" },
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

  test("agent spawn plan mode sends a compact prompt, not the plan contents", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "wolfpack-plan-spawn-"));
    try {
      const planPath = join(tempRoot, ".plans/009-token.md");
      mkdirSync(join(tempRoot, ".plans"), { recursive: true });
      writeFileSync(planPath, "# huge plan body that must not be copied into the prompt\n");
      const script = `
        process.env.WOLFPACK_SESSION_NAME = "wolfpack";
        process.env.WOLFPACK_AGENT_KIND = "pi";
        const calls = [];
        globalThis.fetch = async (url, init) => {
          calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
          return Response.json({ ok: true, session: "wolfpack-sub-agent", sessionId: "id-child", project: "branchout", harness: "pi" });
        };
        const { runAgentCommand } = await import("${process.cwd()}/src/cli/session-control.ts");
        const code = await runAgentCommand(["spawn", "branchout", "--plan", "${planPath}", "--notify-parent", "--json"]);
        const prompt = calls[0]?.body?.initialPrompt ?? "";
        if (!prompt.includes("implement ${planPath}")) process.exit(97);
        if (!prompt.includes("wolfpack agent notify-parent")) process.exit(98);
        if (prompt.includes("huge plan body")) process.exit(99);
        process.exit(code);
      `;
      const child = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: tempRoot,
        env: { ...process.env, NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.stderr.toString()).toBe("");
      expect(child.exitCode).toBe(SESSION_EXIT.OK);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("prompt-file passes file contents without requiring shell heredocs", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "wolfpack-prompt-file-"));
    try {
      const promptPath = join(tempRoot, "prompt.txt");
      writeFileSync(promptPath, "review the diff; don't deploy\n");
      const script = `
        process.env.WOLFPACK_SESSION_NAME = "wolfpack";
        process.env.WOLFPACK_AGENT_KIND = "pi";
        const calls = [];
        globalThis.fetch = async (url, init) => {
          calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
          return Response.json({ ok: true, session: "wolfpack-sub-agent", sessionId: "id-child", project: "branchout", harness: "pi" });
        };
        const { runAgentCommand } = await import("${process.cwd()}/src/cli/session-control.ts");
        const code = await runAgentCommand(["spawn", "branchout", "--prompt-file", "${promptPath}", "--json"]);
        const expectedPrompt = ${JSON.stringify("review the diff; don't deploy\n")};
        if (calls[0]?.body?.initialPrompt !== expectedPrompt) process.exit(99);
        process.exit(code);
      `;
      const child = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: tempRoot,
        env: { ...process.env, NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.stderr.toString()).toBe("");
      expect(child.exitCode).toBe(SESSION_EXIT.OK);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("agent notify-parent wraps the existing notify endpoint", () => {
    const script = `
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
        return Response.json({ ok: true, sent: 1 });
      };
      process.env.WOLFPACK_PARENT_SESSION_ID = "stable-parent-id";
      process.env.WOLFPACK_PARENT_SESSION_NAME = "parent-agent";
      const { runAgentCommand } = await import("./src/cli/session-control.ts");
      const code = await runAgentCommand(["notify-parent", "--message", "ready for review", "--json"]);
      const expected = [{
        url: "http://127.0.0.1:18790/api/notify",
        method: "POST",
        body: {
          message: "ready for review",
          sessionId: "stable-parent-id",
          sessionName: "parent-agent",
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
    expect(JSON.parse(child.stdout.toString())).toEqual({ ok: true, sent: 1 });
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

  test("status preserves canonical name/id and exposes bounded terminal liveness facts for an id selector", () => {
    const script = `
      globalThis.fetch = async (url) => {
        if (!String(url).includes("/api/session-control/status?session=id-branchout")) process.exit(98);
        return Response.json({
          ok: true,
          selector: "id-branchout",
          session: "branchout",
          sessionId: "id-branchout",
          state: "active",
          project: "branchout",
          projectPath: "/tmp/branchout",
          projectDir: "/tmp/branchout",
          harness: "pi",
          terminal: { exists: true, alive: true, status: "ready" },
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
      selector: "id-branchout",
      session: "branchout",
      sessionId: "id-branchout",
      state: "active",
      project: "branchout",
      projectDir: "/tmp/branchout",
      harness: "pi",
      terminal: { exists: true, alive: true, status: "ready" },
    });
  });

  test("status maps structured dead-session liveness failures without terminal output", () => {
    const script = `
      globalThis.fetch = async () => Response.json({
        ok: false,
        selector: "id-dead",
        session: "dead-session",
        sessionId: "id-dead",
        terminal: { exists: true, alive: false, status: "dead" },
        error: { code: "SESSION_DEAD", message: "session is not alive" },
      }, { status: 410 });
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      process.exit(await runSessionCommand(["status", "id-dead", "--json"]));
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
      selector: "id-dead",
      session: "dead-session",
      sessionId: "id-dead",
      terminal: { exists: true, alive: false, status: "dead" },
      error: { code: "SESSION_DEAD", message: "session is not alive" },
    });
  });

  test("status bounds untrusted structured failure messages", () => {
    const script = `
      globalThis.fetch = async () => Response.json({
        ok: false,
        selector: "id-dead",
        session: "dead-session",
        sessionId: "id-dead",
        terminal: { exists: true, alive: false, status: "dead" },
        error: { code: "SESSION_DEAD", message: "x".repeat(10_000) },
      }, { status: 410 });
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      process.exit(await runSessionCommand(["status", "id-dead", "--json"]));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(SESSION_EXIT.NOT_FOUND);
    expect(JSON.parse(child.stdout.toString())).toMatchObject({
      ok: false,
      error: { code: "SESSION_DEAD", message: "session is not alive" },
    });
    expect(child.stdout.length).toBeLessThan(1_000);
  });
});
