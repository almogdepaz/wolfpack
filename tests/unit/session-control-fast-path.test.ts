import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_EXIT,
  parseAgentCommand,
  parseSessionCommand,
} from "../../src/cli/session-control.ts";
import { SESSION_OPEN_MAX_MODEL_LENGTH } from "../../src/session-open-contract.ts";

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
      selector: { kind: "project", project: "branchout" },
      harness: "pi",
      prompt: "execute .plans/000-publish-branchout.md",
      output: "json",
    });
  });

  test("parses an explicit project directory without a positional project", () => {
    expect(parseSessionCommand([
      "create",
      "--project-dir",
      ".",
      "--harness",
      "pi",
    ])).toEqual({
      ok: true,
      action: "create",
      selector: { kind: "projectDir", projectDir: "." },
      harness: "pi",
      prompt: undefined,
      output: "plain",
    });
    expect(parseAgentCommand(["spawn", "--project-dir", "../workspace"])).toMatchObject({
      ok: true,
      action: "spawn",
      selector: { kind: "projectDir", projectDir: "../workspace" },
    });
  });

  test("rejects missing or ambiguous project selectors", () => {
    expect(parseSessionCommand(["create"]).ok).toBe(false);
    expect(parseSessionCommand(["create", "branchout", "--project-dir", "."]).ok).toBe(false);
    expect(parseAgentCommand(["spawn", "branchout", "--project-dir", "."]).ok).toBe(false);
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
      selector: { kind: "project", project: "branchout" },
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
      message: "Usage: wolfpack agent spawn <project> [--name <session>] [--model <provider/model>] [--prompt|--prompt-file|--plan <value>] [--notify-parent] [--task-worker [--readiness-timeout-ms <1..60000>]] [--json]",
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
      selector: { kind: "project", project: "branchout" },
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
      selector: { kind: "project", project: "branchout" },
      sessionName: "issue-200-reviewer",
      prompt: "review the plan",
      output: "json",
    });
  });

  test("parses an opaque model selection only for child launches", () => {
    expect(parseAgentCommand([
      "spawn",
      "branchout",
      "--model",
      "openrouter/anthropic/claude-sonnet-4",
    ])).toEqual({
      ok: true,
      action: "spawn",
      selector: { kind: "project", project: "branchout" },
      model: "openrouter/anthropic/claude-sonnet-4",
      prompt: undefined,
      output: "plain",
    });
    expect(parseSessionCommand([
      "open",
      "branchout",
      "--model=anthropic/claude-opus-4-1",
    ])).toMatchObject({ ok: true, action: "open", model: "anthropic/claude-opus-4-1" });
    expect(parseSessionCommand(["create", "branchout", "--model", "anthropic/claude-opus-4-1"]).ok)
      .toBe(false);
    expect(parseAgentCommand(["spawn", "branchout", "--model", "   "]).ok).toBe(false);
    expect(parseAgentCommand([
      "spawn",
      "branchout",
      "--model",
      "x".repeat(SESSION_OPEN_MAX_MODEL_LENGTH + 1),
    ]).ok).toBe(false);
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
      selector: { kind: "project", project: "branchout" },
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

  test("create resolves an explicit project directory before the atomic request", () => {
    const script = `
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
        return Response.json({
          ok: true,
          session: "wolfpack-any-directory",
          sessionId: "id-explicit",
          project: "wolfpack-any-directory",
          harness: "pi",
        });
      };
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      const code = await runSessionCommand(["create", "--project-dir", ".", "--harness", "pi", "--json"]);
      const expected = [{
        url: "http://127.0.0.1:18790/api/session-create",
        method: "POST",
        body: { projectDir: ${JSON.stringify(process.cwd())}, harness: "pi" },
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

  test("create plan mode sends the plan path, and an unreadable reply without a path stays generic", () => {
    const script = `
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return Response.json({ error: "plan file not readable", code: "PLAN_FILE_UNREADABLE", planPath: 7 }, { status: 404 });
      };
      const { runSessionCommand } = await import("./src/cli/session-control.ts");
      const code = await runSessionCommand(["create", "branchout", "--harness", "pi", "--plan", ".plans/000-task.md", "--json"]);
      const expected = [{ project: "branchout", harness: "pi", plan: { path: ".plans/000-task.md" } }];
      if (JSON.stringify(calls) !== JSON.stringify(expected)) process.exit(99);
      process.exit(code);
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
      error: { code: "PLAN_FILE_UNREADABLE", message: "plan file not readable" },
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
      const code = await runAgentCommand(["spawn", "branchout", "--name", "issue-200-reviewer", "--model", "openrouter/anthropic/claude-sonnet-4", "--prompt", "execute the plan", "--json"]);
      const expected = [{
        url: "http://127.0.0.1:18790/api/session-open",
        method: "POST",
        body: { project: "branchout", parentSession: "wolfpack", sessionName: "issue-200-reviewer", model: "openrouter/anthropic/claude-sonnet-4", initialPrompt: "execute the plan" },
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

  test("agent spawn resolves an explicit project directory before the child request", () => {
    const script = `
      process.env.WOLFPACK_SESSION_NAME = "wolfpack";
      process.env.WOLFPACK_AGENT_KIND = "pi";
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
        return Response.json({ ok: true, session: "child", sessionId: "id-child", project: "wolfpack-any-directory", harness: "pi" });
      };
      const { runAgentCommand } = await import("./src/cli/session-control.ts");
      const code = await runAgentCommand(["spawn", "--project-dir", ".", "--json"]);
      const expected = [{
        url: "http://127.0.0.1:18790/api/session-open",
        method: "POST",
        body: { projectDir: ${JSON.stringify(process.cwd())}, parentSession: "wolfpack" },
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
  });

  test("agent spawn plan mode sends the plan path for the server to resolve, not a local check or contents", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "wolfpack-plan-spawn-"));
    try {
      // The plan exists only in the target project, never in the caller's cwd.
      const script = `
        process.env.WOLFPACK_SESSION_NAME = "wolfpack";
        process.env.WOLFPACK_AGENT_KIND = "pi";
        const calls = [];
        globalThis.fetch = async (url, init) => {
          calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
          return Response.json({ ok: true, session: "wolfpack-sub-agent", sessionId: "id-child", project: "branchout", harness: "pi" });
        };
        const { runAgentCommand } = await import("${process.cwd()}/src/cli/session-control.ts");
        const code = await runAgentCommand(["spawn", "branchout", "--plan", ".plans/009-token.md", "--notify-parent", "--json"]);
        const expected = { project: "branchout", parentSession: "wolfpack", plan: { path: ".plans/009-token.md", notifyParent: true } };
        if (JSON.stringify(calls[0]?.body) !== JSON.stringify(expected)) process.exit(97);
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

  test("agent spawn reports the server-resolved path of an unreadable plan", () => {
    const script = `
      process.env.WOLFPACK_SESSION_NAME = "wolfpack";
      process.env.WOLFPACK_AGENT_KIND = "pi";
      globalThis.fetch = async () => Response.json(
        { error: "plan file not readable", code: "PLAN_FILE_UNREADABLE", planPath: "/srv/branchout/.plans/x.md" },
        { status: 404 },
      );
      const { runAgentCommand } = await import("${process.cwd()}/src/cli/session-control.ts");
      process.exit(await runAgentCommand(["spawn", "branchout", "--plan", ".plans/x.md", "--json"]));
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
      error: { code: "PLAN_FILE_UNREADABLE", message: "plan file not readable: /srv/branchout/.plans/x.md" },
      planPath: "/srv/branchout/.plans/x.md",
    });
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

  function runNotifyParentAgainst(body: unknown, output: "plain" | "json") {
    const script = `
      globalThis.fetch = async () => Response.json(${JSON.stringify(body)});
      const { runAgentCommand } = await import("./src/cli/session-control.ts");
      process.exit(await runAgentCommand(["notify-parent", "--message", "ready"${output === "json" ? ', "--json"' : ""}]));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  }

  test("agent notify-parent reports a delivered push as notified", () => {
    const body = { ok: true, sent: 1, failed: 0, pruned: 0, delivered: true };
    expect(runNotifyParentAgainst(body, "plain")).toEqual({ exitCode: SESSION_EXIT.OK, stdout: "notified\n", stderr: "" });
    const json = runNotifyParentAgainst(body, "json");
    expect(json.exitCode).toBe(SESSION_EXIT.OK);
    expect(JSON.parse(json.stdout)).toEqual(body);
    expect(json.stderr).toBe("");
  });

  test("agent notify-parent warns when some subscriptions failed but one was delivered", () => {
    const body = { ok: true, sent: 1, failed: 2, pruned: 0, delivered: true };
    expect(runNotifyParentAgainst(body, "plain")).toEqual({
      exitCode: SESSION_EXIT.OK,
      stdout: "notified\n",
      stderr: "warning: 2 push subscriptions failed\n",
    });
  });

  test("agent notify-parent exits NOT_DELIVERED when the host has no push subscriptions", () => {
    const body = { ok: true, sent: 0, failed: 0, pruned: 0, delivered: false, reason: "no_subscriptions" };
    expect(SESSION_EXIT.NOT_DELIVERED).toBe(8);
    expect(runNotifyParentAgainst(body, "plain")).toEqual({
      exitCode: SESSION_EXIT.NOT_DELIVERED,
      stdout: "",
      stderr: "not delivered: no push subscriptions on this host\n",
    });
    const json = runNotifyParentAgainst(body, "json");
    expect(json.exitCode).toBe(SESSION_EXIT.NOT_DELIVERED);
    expect(json.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(json.stdout)).toEqual(body);
    expect(json.stderr).toBe("");
  });

  test("agent notify-parent exits BACKEND_UNAVAILABLE when every push failed", () => {
    const body = { ok: true, sent: 0, failed: 3, pruned: 0, delivered: false, reason: "delivery_failed" };
    expect(runNotifyParentAgainst(body, "plain")).toEqual({
      exitCode: SESSION_EXIT.BACKEND_UNAVAILABLE,
      stdout: "",
      stderr: "not delivered: push delivery failed (3 endpoints)\n",
    });
    const json = runNotifyParentAgainst(body, "json");
    expect(json.exitCode).toBe(SESSION_EXIT.BACKEND_UNAVAILABLE);
    expect(JSON.parse(json.stdout)).toEqual(body);
  });

  test("agent notify-parent treats an older server body without delivered as success", () => {
    const body = { ok: true, sent: 0, failed: 0, pruned: 0 };
    expect(runNotifyParentAgainst(body, "plain")).toEqual({ exitCode: SESSION_EXIT.OK, stdout: "notified\n", stderr: "" });
    const json = runNotifyParentAgainst(body, "json");
    expect(json.exitCode).toBe(SESSION_EXIT.OK);
    expect(JSON.parse(json.stdout)).toEqual(body);
  });

  test("agent notify-parent reports a malformed body with delivered as a protocol error", () => {
    for (const body of [
      { ok: true, sent: 0, failed: 0, delivered: false, reason: "unknown_reason" },
      { ok: true, sent: 0, failed: 0, delivered: false },
      { ok: true, sent: "0", failed: 0, delivered: false, reason: "no_subscriptions" },
      { ok: true, sent: 0, failed: 0, delivered: "false", reason: "no_subscriptions" },
      { ok: false, sent: 0, failed: 0, delivered: false, reason: "no_subscriptions" },
    ]) {
      const plain = runNotifyParentAgainst(body, "plain");
      expect(plain.exitCode).toBe(SESSION_EXIT.GENERAL);
      expect(plain.stdout).toBe("");
      expect(plain.stderr).toStartWith("invalid /api/notify response: ");
      const json = runNotifyParentAgainst(body, "json");
      expect(json.exitCode).toBe(SESSION_EXIT.GENERAL);
      expect(JSON.parse(json.stdout)).toEqual(body);
      expect(json.stderr).toStartWith("invalid /api/notify response: ");
    }
  });

  test("agent notify-parent reports delivery claims that contradict the counts as a protocol error", () => {
    for (const body of [
      { ok: true, sent: 0, failed: 0, pruned: 0, delivered: true },
      { ok: true, sent: 1, failed: 0, pruned: 0, delivered: false, reason: "no_subscriptions" },
      { ok: true, sent: 1, failed: 0, pruned: 0, delivered: true, reason: "no_subscriptions" },
      { ok: true, sent: 0, failed: 3, pruned: 0, delivered: false, reason: "no_subscriptions" },
      { ok: true, sent: 0, failed: 0, pruned: 0, delivered: false, reason: "delivery_failed" },
    ]) {
      const plain = runNotifyParentAgainst(body, "plain");
      expect(plain.exitCode).toBe(SESSION_EXIT.GENERAL);
      expect(plain.stdout).toBe("");
      expect(plain.stderr).toStartWith("invalid /api/notify response: ");
      const json = runNotifyParentAgainst(body, "json");
      expect(json.exitCode).toBe(SESSION_EXIT.GENERAL);
      expect(JSON.parse(json.stdout)).toEqual(body);
    }
  });

  test("agent notify-parent keeps legacy success only for ok: true without delivered", () => {
    for (const body of [{ ok: true }, { ok: true, sent: "1" }]) {
      expect(runNotifyParentAgainst(body, "plain")).toEqual({ exitCode: SESSION_EXIT.OK, stdout: "notified\n", stderr: "" });
    }
  });

  test("agent notify-parent reports a body that is not an ok: true envelope as a protocol error", () => {
    for (const body of [{ ok: false, sent: 0, failed: 1 }, {}, "accepted", null, [{ ok: true }]]) {
      const plain = runNotifyParentAgainst(body, "plain");
      expect(plain.exitCode).toBe(SESSION_EXIT.GENERAL);
      expect(plain.stdout).toBe("");
      expect(plain.stderr).toStartWith("invalid /api/notify response: ");
      const json = runNotifyParentAgainst(body, "json");
      expect(json.exitCode).toBe(SESSION_EXIT.GENERAL);
      expect(JSON.parse(json.stdout)).toEqual(body);
      expect(json.stderr).toStartWith("invalid /api/notify response: ");
    }
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
