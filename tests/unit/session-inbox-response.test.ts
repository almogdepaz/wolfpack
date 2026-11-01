import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_EXIT } from "../../src/cli/session-control.ts";

const home = mkdtempSync(join(tmpdir(), "wolfpack-cli-output-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const SELF_ID = "11111111-1111-4111-8111-111111111111";
const AT = "2026-10-11T00:00:00.000Z";
const entry = { seq: 1, at: AT, message: "ready", from: "child" };
const inbox = { session: "parent", sessionId: SELF_ID, notifications: [entry] };

function runInbox(body: unknown, family: "session" | "agent", output: "plain" | "json", options: { selfId?: string; selector?: string; since?: number } = {}) {
  const args = ["inbox", ...(family === "session" ? [options.selector ?? SELF_ID] : []), ...(options.since !== undefined ? ["--since", String(options.since)] : []), ...(output === "json" ? ["--json"] : [])];
  return runCli(body, [family, ...args], { WOLFPACK_SESSION_ID: options.selfId ?? SELF_ID });
}

function cliArgs(args: string[]) {
  return [process.execPath, "--preload", "./tests/fixtures/cli-output-preload.ts", "./src/cli/index.ts", ...args];
}

function cliEnv(env: Record<string, string> = {}) {
  return {
    ...process.env, HOME: home, WOLFPACK_DIR: join(home, ".wolfpack"), NO_COLOR: "1",
    WOLFPACK_SESSION_NAME: "parent", WOLFPACK_SESSION_ID: SELF_ID, WOLFPACK_AGENT_KIND: "pi",
    ...env,
  };
}

function runCli(body: unknown, args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawnSync(cliArgs(args), {
    cwd: process.cwd(),
    env: cliEnv(env),
    stdin: Buffer.from(JSON.stringify(body)), stdout: "pipe", stderr: "pipe", timeout: 5000,
  });
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

  test.each(["session", "agent"] as const)("drains maximum Unicode output through the real %s entrypoint", family => {
    const body = { ...inbox, notifications: Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, at: AT, message: "😀".repeat(500), from: "😀".repeat(100) })) };
    const json = runCli(body, [family, "inbox", ...(family === "session" ? [SELF_ID] : []), "--json"], { CLI_OUTPUT_KEEP_ALIVE: "1" });
    expect(json.exitCode).toBe(SESSION_EXIT.OK);
    expect(json.stderr).toBe("");
    expect(Buffer.byteLength(json.stdout)).toBe(Buffer.byteLength(JSON.stringify(body)) + 1);
    expect(json.stdout).toBe(`${JSON.stringify(body)}\n`);
    expect(JSON.parse(json.stdout)).toEqual(body);
    const plain = runInbox(body, family, "plain");
    expect(plain.exitCode).toBe(SESSION_EXIT.OK);
    expect(plain.stderr).toBe("");
    expect(plain.stdout).toBe(body.notifications.map(entry => `${entry.seq} ${AT} [${entry.from}] ${entry.message}\n`).join(""));
  });

  test("drains stdout and large stderr before a nonzero exit despite a referenced resource", () => {
    const message = "backend unavailable 😀\n".repeat(20_000);
    const body = { session: "parent", sessionId: SELF_ID, state: "active", harness: "pi", projectPath: "/project", taskEndpointError: { code: "TASK_ENDPOINT_UNAVAILABLE", message } };
    const result = runCli(body, ["session", "status", SELF_ID], { CLI_OUTPUT_KEEP_ALIVE: "1" });
    expect(result.exitCode).toBe(SESSION_EXIT.BACKEND_UNAVAILABLE);
    expect(result.stdout).toBe(`parent (${SELF_ID})\nactive pi /project\n`);
    expect(result.stderr.length).toBe(message.length + 1);
    expect(result.stderr).toBe(`${message}\n`);
    const json = runCli(body, ["session", "status", SELF_ID, "--json"]);
    expect(json.exitCode).toBe(SESSION_EXIT.BACKEND_UNAVAILABLE);
    expect(json.stderr).toBe("");
    expect(json.stdout.length).toBe(JSON.stringify(body).length + 1);
    expect(JSON.parse(json.stdout)).toEqual(body);
  });

  test.each(["session", "agent"] as const)("preserves %s API error codes and stderr separation", family => {
    for (const [status, code] of [[400, SESSION_EXIT.GENERAL], [401, SESSION_EXIT.AUTH], [404, SESSION_EXIT.NOT_FOUND], [408, SESSION_EXIT.TIMEOUT], [503, SESSION_EXIT.BACKEND_UNAVAILABLE]] as const) {
      for (const json of [false, true]) {
        const result = runCli({}, [family, "inbox", ...(family === "session" ? [SELF_ID] : []), ...(json ? ["--json"] : [])], { CLI_OUTPUT_STATUS: String(status) });
        expect(result.exitCode).toBe(code);
        if (json) {
          expect(result.stderr).toBe("");
          expect(JSON.parse(result.stdout).ok).toBe(false);
        } else {
          expect(result.stdout).toBe("");
          expect(result.stderr.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test.each(["stdout", "stderr"] as const)("fails promptly when the %s consumer closes", async stream => {
    const body = { session: "parent", sessionId: SELF_ID, state: "active", harness: "pi", projectPath: "/project", taskEndpointError: { code: "TASK_ENDPOINT_UNAVAILABLE", message: "😀".repeat(100_000) } };
    const args = ["session", "status", SELF_ID, ...(stream === "stdout" ? ["--json"] : [])];
    const child = Bun.spawn(cliArgs(args), {
      cwd: process.cwd(), env: cliEnv(), stdin: Buffer.from(JSON.stringify(body)),
      stdout: "pipe", stderr: "pipe", timeout: 5000,
    });
    await child[stream].cancel();
    const remaining = new Response(child[stream === "stdout" ? "stderr" : "stdout"]).text();
    const [exitCode, output] = await Promise.all([child.exited, remaining]);
    expect(child.signalCode).toBeNull();
    expect(exitCode).toBe(SESSION_EXIT.GENERAL);
    if (stream === "stdout") expect(output).toContain("EPIPE");
  });

  test("retains name selectors and the agent name fallback when stable self identity is absent", () => {
    expect(runInbox(inbox, "session", "json", { selector: "parent" }).exitCode).toBe(SESSION_EXIT.OK);
    expect(runInbox(inbox, "agent", "json", { selfId: "" }).exitCode).toBe(SESSION_EXIT.OK);
  });
});
