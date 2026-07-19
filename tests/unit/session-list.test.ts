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

  test("help performs no request", () => {
    const child = run(`
      globalThis.fetch = async () => { throw new Error("fetch must not run"); };
      const { lsSessions } = await import("./src/cli/sessions.ts");
      process.exit(await lsSessions(["--help"]));
    `);
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toContain("Usage: wolfpack list [--json]");
  });

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
