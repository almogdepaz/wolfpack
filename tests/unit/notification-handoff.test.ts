import { describe, expect, test } from "bun:test";
import { parseAgentCommand, SESSION_EXIT } from "../../src/cli/session-control.ts";

const accepted = {
  ok: true, sent: 0, failed: 0, delivered: false, reason: "no_subscriptions",
  parentInbox: { queued: true, seq: 1 },
};

/** Isolate CLI output, environment, and the HTTP boundary from other tests. */
function runCommands(commands: string[][], outcome: "accepted" | "timeout" | "malformed" = "accepted") {
  const script = `
    process.env.WOLFPACK_SESSION_NAME = "child";
    process.env.WOLFPACK_PARENT_SESSION_ID = "parent-id";
    process.env.WOLFPACK_PARENT_SESSION_NAME = "parent";
    process.env.WOLFPACK_AGENT_KIND = "pi";
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ path: new URL(url).pathname, method: init?.method, body: JSON.parse(init.body) });
      if (${JSON.stringify(outcome)} === "timeout") throw new DOMException("response lost", "TimeoutError");
      if (${JSON.stringify(outcome)} === "malformed") return Response.json({ ok: true, parentInbox: {} });
      return Response.json(${JSON.stringify(accepted)});
    };
    const { runAgentCommand } = await import("./src/cli/session-control.ts");
    const results = [];
    for (const args of ${JSON.stringify(commands)}) {
      const code = await runAgentCommand(args);
      results.push({ code, requests: requests.length });
    }
    console.log(JSON.stringify({ results, requests }));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: process.cwd(), env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const lines = child.stdout.toString().trimEnd().split("\n");
  const state = JSON.parse(lines.pop()!) as {
    results: Array<{ code: number; requests: number }>;
    requests: Array<{ path: string; method: string; body: { message?: string } }>;
  };
  return { ...state, stdout: lines.join("\n"), stderr: child.stderr.toString() };
}

describe("bounded parent notification refusal diagnostics", () => {
  test("parser retains the 500 UTF-16 code unit bound without truncation", () => {
    for (const message of ["x".repeat(500), "😀".repeat(250)]) {
      expect(parseAgentCommand(["notify-parent", "--message", message, "--json"]))
        .toEqual({ ok: true, action: "notify-parent", message, output: "json" });
    }
    for (const message of ["x".repeat(518), "x".repeat(528), "😀".repeat(251)]) {
      const result = parseAgentCommand(["notify-parent", "--message", message]);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected local validation refusal");
      expect(result.message).toContain(`received ${message.length}`);
      expect(result.message).toContain("500 UTF-16 code units");
      expect(result.message).toContain("not sent");
    }
  });

  test("blank messages have actionable preflight diagnostics", () => {
    const result = runCommands([["notify-parent", "--message", "   ", "--json"]]);
    expect(result.results).toEqual([{ code: SESSION_EXIT.USAGE, requests: 0 }]);
    expect(result.stderr).toContain("non-whitespace");
    expect(result.stderr).toContain("not sent");
  });

  for (const length of [518, 528]) {
    test(`${length}-unit refusal sends nothing; a shortened message sends one untruncated report`, () => {
      const message = "x".repeat(500);
      const result = runCommands([
        ["notify-parent", "--message", "x".repeat(length), "--json"],
        ["notify-parent", "--message", message, "--json"],
      ]);
      expect(result.results).toEqual([
        { code: SESSION_EXIT.USAGE, requests: 0 }, { code: SESSION_EXIT.OK, requests: 1 },
      ]);
      expect(result.stderr).toContain(`received ${length}`);
      expect(result.stderr).toContain("not sent");
      expect(JSON.parse(result.stdout)).toEqual(accepted);
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toMatchObject({ path: "/api/notify", method: "POST", body: { message } });
    });
  }

  for (const outcome of ["timeout", "malformed"] as const) {
    test(`${outcome} after request is not replayed or described as a preflight refusal`, () => {
      const result = runCommands([["notify-parent", "--message", "ready", "--json"]], outcome);
      expect(result.results).toEqual([{ code: SESSION_EXIT.GENERAL, requests: 1 }]);
      expect(result.requests).toHaveLength(1);
      expect(result.stderr + result.stdout).not.toContain("not sent");
    });
  }
});
