import { describe, expect, test } from "bun:test";

const ORIGIN = "https://peer.example.ts.net";
const TARGET = {
  kind: "remote",
  origin: ORIGIN,
  machine: {
    tailnetNodeId: "n-peer",
    installationId: "2af8af29-c4fe-44f9-9a99-9a0e35952d74",
    displayName: "peer",
    origin: ORIGIN,
  },
} as const;

function run(script: string) {
  return Bun.spawnSync([process.execPath, "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("remote machine control routing", () => {
  test("routes every planned command family and enriches json once without rewriting session ids", () => {
    const script = `
      process.env.WOLFPACK_SESSION_NAME = "parent";
      process.env.WOLFPACK_AGENT_KIND = "pi";
      const target = ${JSON.stringify(TARGET)};
      const calls = [];
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        calls.push({ url: String(input), method: init?.method ?? "GET" });
        if (url.pathname === "/api/session-control/list") return Response.json({ sessions: [{ session: "alpha", sessionId: "id-list" }] });
        if (url.pathname === "/api/session-create") return Response.json({ ok: true, session: "created", sessionId: "id-create", project: "project", harness: "pi" });
        if (url.pathname === "/api/session-open") return Response.json({ ok: true, session: "child", sessionId: "id-open", project: "project", harness: "pi" });
        if (url.pathname === "/api/session-control/status") return Response.json({ ok: true, selector: "alpha", session: "alpha", sessionId: "id-status", state: "active", project: "project", projectPath: "/tmp/project", projectDir: "/tmp/project", harness: "pi", terminal: { exists: true, alive: true, status: "ready" } });
        if (url.pathname === "/api/session-control/read") return Response.json({ session: "alpha", sessionId: "id-read", output: "ready" });
        if (url.pathname === "/api/session-control/send") return Response.json({ ok: true, session: "alpha", sessionId: "id-send" });
        if (url.pathname === "/api/session-control/wait") return Response.json({ ok: true, session: "alpha", sessionId: "id-wait", matched: true });
        if (url.pathname === "/api/session-control/prompt") return Response.json({ ok: true, session: "alpha", sessionId: "id-prompt", outcome: "matched", outputBoundarySeq: "12" });
        if (url.pathname === "/api/kill") return Response.json({ ok: true, session: "alpha", sessionId: "id-kill" });
        return new Response("unexpected", { status: 500 });
      };
      const { lsSessions, killSession } = await import("./src/cli/sessions.ts");
      const { runAgentCommand, runSessionCommand } = await import("./src/cli/session-control.ts");
      const codes = [];
      codes.push(await lsSessions(["--json"], target));
      codes.push(await runSessionCommand(["create", "project", "--harness", "pi", "--json"], target));
      codes.push(await runSessionCommand(["open", "project", "--json"], target));
      codes.push(await runAgentCommand(["spawn", "project", "--json"], target));
      codes.push(await runSessionCommand(["status", "alpha", "--json"], target));
      codes.push(await runSessionCommand(["read", "alpha", "--json"], target));
      codes.push(await runSessionCommand(["send", "alpha", "hello", "--json"], target));
      codes.push(await runSessionCommand(["wait", "alpha", "ready", "--json"], target));
      codes.push(await runSessionCommand(["prompt", "alpha", "run", "--until", "ready", "--json"], target));
      codes.push(await killSession(["alpha", "--json"], target));
      if (codes.some(code => code !== 0)) process.exit(97);
      console.error(JSON.stringify(calls));
    `;
    const child = run(script);

    expect(child.exitCode).toBe(0);
    const calls = JSON.parse(child.stderr.toString()) as Array<{ readonly url: string; readonly method: string }>;
    expect(calls).toHaveLength(10);
    expect(calls.every(({ url }) => url.startsWith(`${ORIGIN}/api/`))).toBe(true);
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/session-control/list",
      "/api/session-create",
      "/api/session-open",
      "/api/session-open",
      "/api/session-control/status",
      "/api/session-control/read",
      "/api/session-control/send",
      "/api/session-control/wait",
      "/api/session-control/prompt",
      "/api/kill",
    ]);

    const envelopes = child.stdout.toString().trim().split("\n").map((line) => JSON.parse(line));
    expect(envelopes).toHaveLength(10);
    for (const envelope of envelopes) expect(envelope.machine).toEqual(TARGET.machine);
    expect(envelopes.map((envelope) => envelope.sessionId ?? envelope.sessions?.[0]?.sessionId)).toEqual([
      "id-list",
      "id-create",
      "id-open",
      "id-open",
      "id-status",
      "id-read",
      "id-send",
      "id-wait",
      "id-prompt",
      "id-kill",
    ]);
  });

  test("keeps local request urls and json byte shape unchanged without a target", () => {
    const child = run(`
      globalThis.fetch = async (input) => {
        if (String(input) !== "http://127.0.0.1:18790/api/session-control/list") process.exit(98);
        return Response.json({ sessions: [{ session: "alpha", sessionId: "id-alpha" }] });
      };
      const { lsSessions } = await import("./src/cli/sessions.ts");
      process.exit(await lsSessions(["--json"]));
    `);

    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe('{"sessions":[{"session":"alpha","sessionId":"id-alpha"}]}\n');
  });
});
