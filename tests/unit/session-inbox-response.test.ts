import { describe, expect, test } from "bun:test";
import { SESSION_EXIT } from "../../src/cli/session-control.ts";

const SELF_ID = "11111111-1111-4111-8111-111111111111";
const AT = "2026-10-11T00:00:00.000Z";
const entry = { seq: 1, at: AT, message: "ready", from: "child" };
const inbox = { session: "parent", sessionId: SELF_ID, notifications: [entry] };

function runInbox(body: unknown, family: "session" | "agent", output: "plain" | "json", options: { selfId?: string; selector?: string; since?: number } = {}) {
  const args = ["inbox", ...(family === "session" ? [options.selector ?? SELF_ID] : []), ...(options.since !== undefined ? ["--since", String(options.since)] : []), ...(output === "json" ? ["--json"] : [])];
  const script = `
    process.env.WOLFPACK_SESSION_NAME = "parent";
    process.env.WOLFPACK_SESSION_ID = ${JSON.stringify(options.selfId ?? SELF_ID)};
    process.env.WOLFPACK_AGENT_KIND = "pi";
    globalThis.fetch = async () => Response.json(${JSON.stringify(body)});
    const { runSessionCommand, runAgentCommand } = await import("./src/cli/session-control.ts");
    process.exit(await ${family === "session" ? "runSessionCommand" : "runAgentCommand"}(${JSON.stringify(args)}));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: process.cwd(), env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

const invalidBodies: Array<[string, unknown]> = [
  ["null", null],
  ["array", []],
  ["empty object", {}],
  ["error envelope", { error: "broken server" }],
  ["missing session", { sessionId: SELF_ID, notifications: [] }],
  ["numeric session", { ...inbox, session: 1 }],
  ["empty session", { ...inbox, session: "" }],
  ["invalid session name", { ...inbox, session: "parent\nother" }],
  ["overlong session", { ...inbox, session: "x".repeat(257) }],
  ["missing id", { session: "parent", notifications: [] }],
  ["numeric id", { ...inbox, sessionId: 7 }],
  ["empty id", { ...inbox, sessionId: "" }],
  ["overlong id", { ...inbox, sessionId: "x".repeat(257) }],
  ["different self id", { ...inbox, sessionId: "other-parent-id" }],
  ["missing notifications", { session: "parent", sessionId: SELF_ID }],
  ["non-array notifications", { ...inbox, notifications: {} }],
  ["overfull notifications", { ...inbox, notifications: Array.from({ length: 101 }, (_, i) => ({ ...entry, seq: i + 1 })) }],
  ...[
    ["null entry", null],
    ["array entry", []],
    ["missing entry fields", {}],
    ["zero seq", { ...entry, seq: 0 }],
    ["negative seq", { ...entry, seq: -1 }],
    ["fractional seq", { ...entry, seq: 1.5 }],
    ["string seq", { ...entry, seq: "1" }],
    ["unsafe seq", { ...entry, seq: Number.MAX_SAFE_INTEGER + 1 }],
    ["missing at", { seq: 1, message: "ready" }],
    ["numeric at", { ...entry, at: 0 }],
    ["empty at", { ...entry, at: "" }],
    ["invalid timestamp", { ...entry, at: "not-a-timestamp" }],
    ["non-string message", { ...entry, message: { fake: true } }],
    ["missing message", { seq: 1, at: AT }],
    ["overlong message", { ...entry, message: "x".repeat(501) }],
    ["numeric sender", { ...entry, from: 7 }],
    ["null sender", { ...entry, from: null }],
    ["overlong sender", { ...entry, from: "😀".repeat(101) }],
  ].map(([name, notification]) => [String(name), { ...inbox, notifications: [notification] }] as [string, unknown]),
  ["duplicate seq", { ...inbox, notifications: [entry, entry] }],
  ["descending seq", { ...inbox, notifications: [{ ...entry, seq: 2 }, entry] }],
];

describe("inbox response boundary", () => {
  const invalidCases = invalidBodies.flatMap(([name, body]) => (["session", "agent"] as const).flatMap(family => (["plain", "json"] as const).map(output => [name, family, output, body] as const)));
  test.each(invalidCases)("rejects %s (%s %s)", (_name, family, output, body) => {
      const result = runInbox(body, family, output);
      expect(result.exitCode, `${family} ${output}: ${result.stderr}`).toBe(SESSION_EXIT.GENERAL);
      if (output === "json") {
        expect(JSON.parse(result.stdout)).toEqual({ ok: false, error: { code: "INVALID_INBOX_RESPONSE", message: "invalid /api/session-control/inbox response" } });
        expect(result.stderr).toBe("");
      } else {
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("invalid /api/session-control/inbox response\n");
      }
  });

  test("rejects entries at or before the requested since cursor", () => {
    for (const family of ["session", "agent"] as const) for (const output of ["plain", "json"] as const) {
      expect(runInbox(inbox, family, output, { since: 1 }).exitCode).toBe(SESSION_EXIT.GENERAL);
    }
  });

  test("accepts valid bounded entries and empty inboxes for both aliases and output modes", () => {
    const bounded = { ...inbox, notifications: Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, at: AT, message: "😀".repeat(500), from: "😀".repeat(100) })) };
    for (const body of [inbox, { ...inbox, notifications: [] }, bounded, { ...inbox, notifications: [{ seq: Number.MAX_SAFE_INTEGER, at: AT, message: "" }] }]) {
      for (const family of ["session", "agent"] as const) for (const output of ["plain", "json"] as const) {
        const result = runInbox(body, family, output);
        expect(result.exitCode, result.stderr).toBe(SESSION_EXIT.OK);
        expect(result.stderr).toBe("");
        if (output === "json") expect(JSON.parse(result.stdout)).toEqual(body);
      }
    }
  });

  test("retains name selectors and the agent name fallback when stable self identity is absent", () => {
    expect(runInbox(inbox, "session", "json", { selector: "parent" }).exitCode).toBe(SESSION_EXIT.OK);
    expect(runInbox(inbox, "agent", "json", { selfId: "" }).exitCode).toBe(SESSION_EXIT.OK);
  });
});
