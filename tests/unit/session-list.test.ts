import { describe, expect, test } from "bun:test";

function run(script: string) {
  return Bun.spawnSync([process.execPath, "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("session list json", () => {
  test("emits one structured envelope with stable identities", () => {
    const child = run(`
      globalThis.fetch = async (url) => {
        if (!String(url).endsWith("/api/session-control/list")) process.exit(98);
        return Response.json({ sessions: [{
          ok: true,
          session: "branchout",
          sessionId: "id-branchout",
          state: "active",
          projectPath: "/dev/branchout",
          harness: "pi",
        }] });
      };
      const { lsSessions } = await import("./src/cli/sessions.ts");
      process.exit(await lsSessions(["--json"]));
    `);

    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toBe("");
    const lines = child.stdout.toString().trim().split("\n");
    expect(lines).toHaveLength(1);
    const session = JSON.parse(lines[0]).sessions[0];
    expect(session.sessionId).toBe("id-branchout");
    expect(session).not.toHaveProperty("lastLine");
  });

  test("human output describes observed activity without claiming process state", () => {
    const child = run(`
      globalThis.fetch = async () => Response.json({ sessions: [
        { name: "active", triage: "running" },
        { name: "still", triage: "idle" },
      ] });
      const { lsSessions } = await import("./src/cli/sessions.ts");
      process.exit(await lsSessions());
    `);

    expect(child.exitCode).toBe(0);
    const stdout = child.stdout.toString();
    expect(stdout).toContain("output");
    expect(stdout).toContain("quiet");
    expect(stdout).not.toContain("running");
    expect(stdout).not.toContain("idle");
    expect(stdout).not.toContain("\x1b[");
    expect(child.stderr.toString()).toBe("");
  });

  test("help performs no request", () => {
    const child = run(`
      globalThis.fetch = async () => { throw new Error("fetch must not run"); };
      const { lsSessions } = await import("./src/cli/sessions.ts");
      process.exit(await lsSessions(["--help"]));
    `);
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toContain("Usage: wolfpack list [--json]");
  });

  test("json kill failure emits one structured envelope", () => {
    const child = run(`
      globalThis.fetch = async () => new Response("missing", { status: 404 });
      const { killSession } = await import("./src/cli/sessions.ts");
      process.exit(await killSession(["missing-session", "--json"]));
    `);

    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toBe("");
    expect(child.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      ok: false,
      error: {
        code: "SESSION_NOT_FOUND",
        message: "session not found",
      },
    });
  });

  test("human kill failure writes an uncolored diagnostic to stderr", () => {
    const child = run(`
      globalThis.fetch = async () => new Response("missing", { status: 404 });
      const { killSession } = await import("./src/cli/sessions.ts");
      process.exit(await killSession(["missing-session"]));
    `);

    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toContain('Session "missing-session" not found.');
    expect(child.stderr.toString()).not.toContain("\x1b[");
  });

  test("json list transport failure emits one structured envelope", () => {
    const child = run(`
      globalThis.fetch = async () => { throw new Error("connection refused"); };
      const { lsSessions } = await import("./src/cli/sessions.ts");
      process.exit(await lsSessions(["--json"]));
    `);

    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toBe("");
    expect(child.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      ok: false,
      error: {
        code: "SERVER_UNREACHABLE",
        message: "could not reach the wolfpack server",
      },
    });
  });

  for (const scenario of [
    {
      name: "invalid arguments",
      response: "null",
      argv: '["unexpected", "--json"]',
      code: "INVALID_ARGUMENTS",
      message: "invalid list arguments",
    },
    {
      name: "authentication failure",
      response: 'new Response("unauthorized", { status: 401 })',
      argv: '["--json"]',
      code: "AUTH_REQUIRED",
      message: "auth required",
    },
    {
      name: "server failure",
      response: 'new Response("failure", { status: 500 })',
      argv: '["--json"]',
      code: "SERVER_ERROR",
      message: "wolfpack server request failed",
    },
    {
      name: "invalid response",
      response: 'new Response("not-json", { status: 200 })',
      argv: '["--json"]',
      code: "INVALID_RESPONSE",
      message: "wolfpack server returned invalid JSON",
    },
  ] as const) {
    test(`json list ${scenario.name} emits one stable error`, () => {
      const child = run(`
        globalThis.fetch = async () => ${scenario.response};
        const { lsSessions } = await import("./src/cli/sessions.ts");
        process.exit(await lsSessions(${scenario.argv}));
      `);

      expect(child.exitCode).not.toBe(0);
      expect(child.stderr.toString()).toBe("");
      expect(child.stdout.toString().trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(child.stdout.toString())).toEqual({
        ok: false,
        error: { code: scenario.code, message: scenario.message },
      });
    });
  }

  test("kill accepts an opaque id and returns canonical json", () => {
    const child = run(`
      globalThis.fetch = async (url, init) => {
        if (!String(url).endsWith("/api/kill")) process.exit(98);
        const body = JSON.parse(String(init?.body));
        if (body.session !== "id-branchout") process.exit(99);
        return Response.json({ ok: true, session: "branchout", sessionId: "id-branchout" });
      };
      const { killSession } = await import("./src/cli/sessions.ts");
      process.exit(await killSession(["id-branchout", "--json"]));
    `);
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      ok: true,
      session: "branchout",
      sessionId: "id-branchout",
    });
  });
});
