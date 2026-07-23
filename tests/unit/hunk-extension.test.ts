import { afterEach, describe, expect, test } from "bun:test";
import hunkExtension from "../../extensions/hunk.ts";

interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed?: boolean;
}

interface ExecOptions {
  readonly timeout?: number;
}

interface ExecCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ExecOptions | undefined;
}

interface RegisteredCommand {
  readonly description: string;
  readonly handler: (args: string, ctx: FakeCommandContext) => Promise<void> | void;
}

interface FakeCommandContext {
  readonly ui: {
    readonly notify: (message: string, level: "info" | "warning" | "error") => void;
  };
}

const ORIGINAL_ENV = { ...process.env };
const HUNK_PREFLIGHT_TIMEOUT_MS = 5_000;
const WOLFPACK_CREATE_TIMEOUT_MS = 15_000;
const WOLFPACK_SEND_TIMEOUT_MS = 5_000;
const MAX_STRUCTURED_ERROR_CHARS = 160;

const HUNK_PREFLIGHT_CALL = {
  command: "hunk",
  args: ["--version"],
  options: { timeout: HUNK_PREFLIGHT_TIMEOUT_MS },
} as const;

const WOLFPACK_CREATE_CALL = {
  command: "wolfpack",
  args: ["session", "create", "my-app", "--harness", "shell", "--grid", "--json"],
  options: { timeout: WOLFPACK_CREATE_TIMEOUT_MS },
} as const;

const WOLFPACK_SEND_CALL = {
  command: "wolfpack",
  args: ["session", "send", "stable-hunk", "exec hunk diff --watch", "--json"],
  options: { timeout: WOLFPACK_SEND_TIMEOUT_MS },
} as const;

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function installExtension(results: ExecResult[]): {
  readonly command: RegisteredCommand;
  readonly calls: ExecCall[];
  readonly notifications: Array<{ readonly message: string; readonly level: string }>;
} {
  const commands: Record<string, RegisteredCommand> = {};
  const calls: ExecCall[] = [];
  const notifications: Array<{ readonly message: string; readonly level: string }> = [];
  const pi = {
    registerCommand(name: string, command: RegisteredCommand): void {
      commands[name] = command;
    },
    async exec(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> {
      calls.push({ command, args, options });
      const next = results.shift();
      if (!next) throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
      return next;
    },
    sendUserMessage(): never {
      throw new Error("/hunk must not invoke a model turn");
    },
  };

  hunkExtension(pi);
  const command = commands.hunk;
  if (!command) throw new Error("/hunk was not registered");

  return {
    command,
    calls,
    notifications,
  };
}

function context(notifications: Array<{ readonly message: string; readonly level: string }>): FakeCommandContext {
  return {
    ui: {
      notify(message, level): void {
        notifications.push({ message, level });
      },
    },
  };
}

function setWolfpackEnv(): void {
  process.env.WOLFPACK_PROJECT_DIR = "/Users/home/Dev/my-app";
  process.env.WOLFPACK_SESSION_NAME = "pi-main";
}

describe("Pi /hunk extension", () => {
  test("registers /hunk and starts hunk in a Wolfpack grid shell without a model turn", async () => {
    setWolfpackEnv();
    const create = { ok: true, session: "my-app-hunk", sessionId: "stable-hunk", project: "my-app", harness: "shell" };
    const send = { ok: true, session: "my-app-hunk", sessionId: "stable-hunk" };
    const { command, calls, notifications } = installExtension([
      { code: 0, stdout: "hunk 1.0.0\n", stderr: "" },
      { code: 0, stdout: `${JSON.stringify(create)}\n`, stderr: "" },
      { code: 0, stdout: `${JSON.stringify(send)}\n`, stderr: "" },
    ]);

    await command.handler("", context(notifications));

    expect(calls).toEqual([
      HUNK_PREFLIGHT_CALL,
      WOLFPACK_CREATE_CALL,
      WOLFPACK_SEND_CALL,
    ]);
    expect(notifications).toEqual([
      { level: "info", message: "Hunk diff watcher opened in Wolfpack session my-app-hunk (stable-hunk)." },
    ]);
  });

  test("rejects arguments and missing Wolfpack context before executing commands", async () => {
    const withArgs = installExtension([]);
    await withArgs.command.handler("--staged", context(withArgs.notifications));
    expect(withArgs.calls).toEqual([]);
    expect(withArgs.notifications[0]).toEqual({ level: "warning", message: "Usage: /hunk" });

    delete process.env.WOLFPACK_PROJECT_DIR;
    delete process.env.WOLFPACK_SESSION_NAME;
    const missingContext = installExtension([]);
    await missingContext.command.handler("", context(missingContext.notifications));
    expect(missingContext.calls).toEqual([]);
    expect(missingContext.notifications[0]).toEqual({
      level: "error",
      message: "Run /hunk from Pi inside a Wolfpack session with WOLFPACK_PROJECT_DIR and WOLFPACK_SESSION_NAME set.",
    });
  });

  test("reports missing hunk before creating a Wolfpack session", async () => {
    setWolfpackEnv();
    const { command, calls, notifications } = installExtension([
      { code: 127, stdout: "", stderr: "hunk: command not found" },
    ]);

    await command.handler("", context(notifications));

    expect(calls).toEqual([HUNK_PREFLIGHT_CALL]);
    expect(notifications[0]).toEqual({
      level: "error",
      message: "hunk is not available on PATH. Install Hunk on this host, then retry /hunk.",
    });
  });

  test("rejects incompatible create successes before sending to the returned session", async () => {
    setWolfpackEnv();
    for (const create of [
      { ok: true, session: "my-app-hunk", sessionId: "stable-hunk", project: "my-app", harness: "pi" },
      { ok: true, session: "", sessionId: "stable-hunk", project: "my-app", harness: "shell" },
      { ok: true, session: "my-app-hunk", sessionId: "", project: "my-app", harness: "shell" },
      { ok: true, session: "my-app-hunk", sessionId: "stable-hunk", project: "other-app", harness: "shell" },
    ]) {
      const { command, calls, notifications } = installExtension([
        { code: 0, stdout: "hunk 1.0.0\n", stderr: "" },
        { code: 0, stdout: JSON.stringify(create), stderr: "" },
      ]);

      await command.handler("", context(notifications));

      expect(calls).toEqual([
        HUNK_PREFLIGHT_CALL,
        WOLFPACK_CREATE_CALL,
      ]);
      expect(notifications.at(-1)).toEqual({
        level: "error",
        message: "Wolfpack returned an incompatible Hunk session response.",
      });
    }
  });

  test("reports missing wolfpack, malformed create JSON, and structured create failures", async () => {
    setWolfpackEnv();
    const missingWolfpack = installExtension([
      { code: 0, stdout: "hunk 1.0.0\n", stderr: "" },
      { code: 127, stdout: "", stderr: "wolfpack: command not found" },
    ]);
    await missingWolfpack.command.handler("", context(missingWolfpack.notifications));
    expect(missingWolfpack.notifications.at(-1)).toEqual({
      level: "error",
      message: "wolfpack CLI is not available on PATH. Install or expose wolfpack, then retry /hunk.",
    });

    setWolfpackEnv();
    const malformed = installExtension([
      { code: 0, stdout: "hunk 1.0.0\n", stderr: "" },
      { code: 0, stdout: "not json", stderr: "" },
    ]);
    await malformed.command.handler("", context(malformed.notifications));
    expect(malformed.notifications.at(-1)).toEqual({
      level: "error",
      message: "Wolfpack returned malformed JSON while creating the Hunk session.",
    });

    setWolfpackEnv();
    const failedCreate = installExtension([
      { code: 0, stdout: "hunk 1.0.0\n", stderr: "" },
      { code: 1, stdout: JSON.stringify({ ok: false, error: { message: "parent Wolfpack session is not active" } }), stderr: "" },
    ]);
    await failedCreate.command.handler("", context(failedCreate.notifications));
    expect(failedCreate.notifications.at(-1)).toEqual({
      level: "error",
      message: "Could not create Wolfpack Hunk session: parent Wolfpack session is not active",
    });
  });

  test("reports a validated surviving session from post-create grid failures without sending", async () => {
    setWolfpackEnv();
    const { command, calls, notifications } = installExtension([
      { code: 0, stdout: "hunk 1.0.0\n", stderr: "" },
      {
        code: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: "PARENT_SESSION_CHANGED", message: "parent Wolfpack session changed" },
          createdSession: {
            session: "my-app-hunk",
            sessionId: "stable-hunk",
            project: "my-app",
            harness: "shell",
          },
        }),
        stderr: "",
      },
    ]);

    await command.handler("", context(notifications));

    expect(calls).toEqual([
      HUNK_PREFLIGHT_CALL,
      WOLFPACK_CREATE_CALL,
    ]);
    expect(notifications.at(-1)).toEqual({
      level: "error",
      message: "Could not attach Hunk to the Wolfpack grid: parent Wolfpack session changed. Created Wolfpack session my-app-hunk (stable-hunk) may still be running.",
    });
  });

  test("does not report malformed surviving sessions from post-create grid failures", async () => {
    setWolfpackEnv();
    const { command, calls, notifications } = installExtension([
      { code: 0, stdout: "hunk 1.0.0\n", stderr: "" },
      {
        code: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: "PARENT_SESSION_CHANGED", message: "parent Wolfpack session changed" },
          createdSession: {
            session: "my-app-hunk",
            sessionId: "stable-hunk",
            project: "my-app",
            harness: "pi",
          },
        }),
        stderr: "",
      },
    ]);

    await command.handler("", context(notifications));

    expect(calls).toEqual([
      HUNK_PREFLIGHT_CALL,
      WOLFPACK_CREATE_CALL,
    ]);
    expect(notifications.at(-1)).toEqual({
      level: "error",
      message: "Could not create Wolfpack Hunk session: parent Wolfpack session changed",
    });
  });

  test("reports killed subprocesses as concise phase-specific timeouts before trusting output", async () => {
    setWolfpackEnv();
    const preflightTimeout = installExtension([
      { code: 0, stdout: "hunk 1.0.0\n", stderr: "", killed: true },
    ]);
    await preflightTimeout.command.handler("", context(preflightTimeout.notifications));
    expect(preflightTimeout.calls).toEqual([HUNK_PREFLIGHT_CALL]);
    expect(preflightTimeout.notifications.at(-1)).toEqual({
      level: "error",
      message: "Timed out while checking whether Hunk is available.",
    });

    setWolfpackEnv();
    const createTimeout = installExtension([
      { code: 0, stdout: "hunk 1.0.0\n", stderr: "" },
      { code: 0, stdout: JSON.stringify({ ok: true, session: "my-app-hunk", sessionId: "stable-hunk", project: "my-app", harness: "shell" }), stderr: "", killed: true },
    ]);
    await createTimeout.command.handler("", context(createTimeout.notifications));
    expect(createTimeout.calls).toEqual([HUNK_PREFLIGHT_CALL, WOLFPACK_CREATE_CALL]);
    expect(createTimeout.notifications.at(-1)).toEqual({
      level: "error",
      message: "Timed out while creating the Wolfpack Hunk session.",
    });

    setWolfpackEnv();
    const sendTimeout = installExtension([
      { code: 0, stdout: "hunk 1.0.0\n", stderr: "" },
      { code: 0, stdout: JSON.stringify({ ok: true, session: "my-app-hunk", sessionId: "stable-hunk", project: "my-app", harness: "shell" }), stderr: "" },
      { code: 0, stdout: JSON.stringify({ ok: true, session: "my-app-hunk", sessionId: "stable-hunk" }), stderr: "", killed: true },
    ]);
    await sendTimeout.command.handler("", context(sendTimeout.notifications));
    expect(sendTimeout.calls).toEqual([HUNK_PREFLIGHT_CALL, WOLFPACK_CREATE_CALL, WOLFPACK_SEND_CALL]);
    expect(sendTimeout.notifications.at(-1)).toEqual({
      level: "error",
      message: "Created Wolfpack session my-app-hunk (stable-hunk), but timed out while starting Hunk.",
    });
  });

  test("clamps structured error messages and never treats arbitrary stderr as protocol", async () => {
    setWolfpackEnv();
    const longMessage = "🙂".repeat(MAX_STRUCTURED_ERROR_CHARS + 20);
    const clamped = `${"🙂".repeat(MAX_STRUCTURED_ERROR_CHARS)}…`;
    const oversizedCreate = installExtension([
      { code: 0, stdout: "hunk 1.0.0\n", stderr: "" },
      { code: 1, stdout: JSON.stringify({ ok: false, error: { message: longMessage } }), stderr: "" },
    ]);
    await oversizedCreate.command.handler("", context(oversizedCreate.notifications));
    expect(oversizedCreate.notifications.at(-1)).toEqual({
      level: "error",
      message: `Could not create Wolfpack Hunk session: ${clamped}`,
    });

    setWolfpackEnv();
    const stderrCreate = installExtension([
      { code: 0, stdout: "hunk 1.0.0\n", stderr: "" },
      { code: 1, stdout: "", stderr: "parent session changed after creating session; my-app-hunk stable-hunk" },
    ]);
    await stderrCreate.command.handler("", context(stderrCreate.notifications));
    expect(stderrCreate.notifications.at(-1)).toEqual({
      level: "error",
      message: "Could not create Wolfpack Hunk session: session creation failed",
    });

    setWolfpackEnv();
    const stderrSend = installExtension([
      { code: 0, stdout: "hunk 1.0.0\n", stderr: "" },
      { code: 0, stdout: JSON.stringify({ ok: true, session: "my-app-hunk", sessionId: "stable-hunk", project: "my-app", harness: "shell" }), stderr: "" },
      { code: 1, stdout: "", stderr: "session not found: stable-hunk" },
    ]);
    await stderrSend.command.handler("", context(stderrSend.notifications));
    expect(stderrSend.notifications.at(-1)).toEqual({
      level: "error",
      message: "Created Wolfpack session my-app-hunk (stable-hunk), but could not start Hunk: send failed",
    });
  });

  test("targets the stable session id and reports the surviving session on send failure", async () => {
    setWolfpackEnv();
    const { command, calls, notifications } = installExtension([
      { code: 0, stdout: "hunk 1.0.0\n", stderr: "" },
      { code: 0, stdout: JSON.stringify({ ok: true, session: "my-app-hunk", sessionId: "stable-hunk", project: "my-app", harness: "shell" }), stderr: "" },
      { code: 1, stdout: JSON.stringify({ ok: false, error: { message: "session not found" } }), stderr: "" },
    ]);

    await command.handler("", context(notifications));

    expect(calls[2]).toEqual(WOLFPACK_SEND_CALL);
    expect(notifications.at(-1)).toEqual({
      level: "error",
      message: "Created Wolfpack session my-app-hunk (stable-hunk), but could not start Hunk: session not found",
    });
  });
});
