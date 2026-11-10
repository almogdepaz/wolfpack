import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

interface FetchOptions { readonly timeout: unknown; readonly signal: "pending" | "aborted" | null }
interface Run {
  readonly code: number; readonly stdout: Buffer; readonly stderr: string;
  readonly calls: Array<{ url: string; body: Record<string, unknown> }>;
  readonly fetchOptions: FetchOptions[];
}

/** Run `execCommand` in a child bun with a fetch stub; calls go to stderr after a `CALLS:` marker. */
function runExec(args: readonly string[], options: { target?: boolean; reply?: unknown; status?: number; cwd?: string } = {}): Run {
  const script = `
    const calls = [], fetchOptions = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      fetchOptions.push({ timeout: init?.timeout ?? null, signal: init?.signal ? (init.signal.aborted ? "aborted" : "pending") : null });
      return Response.json(${JSON.stringify(options.reply ?? { ok: true })}, { status: ${options.status ?? 200} });
    };
    const { execCommand } = await import(${JSON.stringify(join(process.cwd(), "src/cli/remote-ops.ts"))});
    const code = await execCommand(${JSON.stringify(args)}, ${options.target ? JSON.stringify(TARGET) : "undefined"});
    process.stderr.write("\\nCALLS:" + JSON.stringify({ calls, fetchOptions }));
    process.exit(code);
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = child.stderr.toString();
  const marker = stderr.lastIndexOf("CALLS:");
  if (marker < 0) throw new Error(`execCommand did not finish: ${stderr}`);
  const recorded = JSON.parse(stderr.slice(marker + "CALLS:".length)) as Pick<Run, "calls" | "fetchOptions">;
  return { code: child.exitCode ?? -1, stdout: child.stdout, stderr: stderr.slice(0, marker), ...recorded };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    ok: true, cwd: "/srv", exitCode: 0, signal: null, timedOut: false, durationMs: 5,
    stdout: "", stdoutEncoding: "utf8", stdoutBytes: 0, stdoutTruncated: false,
    stderr: "", stderrEncoding: "utf8", stderrBytes: 0, stderrTruncated: false,
    ...overrides,
  };
}

describe("wolfpack exec", () => {
  test("a long exec replaces Bun's ~360 s default fetch timeout with its own deadline", () => {
    // Bun 1.4.2 fetch fails a response that stays silent ~360 s; --timeout allows 600 s.
    for (const args of [["--cwd", "/srv", "--timeout", "600", "--json", "--", "sleep", "500"], ["--cwd", "/srv", "--json", "--", "true"]]) {
      const run = runExec(args, { target: true, reply: result() });
      expect(run.code, args.join(" ")).toBe(0);
      expect(run.fetchOptions, args.join(" ")).toEqual([{ timeout: false, signal: "pending" }]);
    }
  });

  test("sends argv after -- verbatim to the verified machine; --json exits 0 with the result and machine", () => {
    const run = runExec(["--cwd", "/srv", "--timeout", "30", "--json", "--", "grep", "--json", "--help", "--machine", "z", "--"], {
      target: true, reply: result({ exitCode: 7, stdout: "x" }),
    });
    expect(run.code).toBe(0);
    expect(run.calls).toEqual([{ url: `${ORIGIN}/api/exec`, body: { argv: ["grep", "--json", "--help", "--machine", "z", "--"], cwd: "/srv", timeoutSeconds: 30 } }]);
    expect(JSON.parse(run.stdout.toString())).toMatchObject({ ok: true, exitCode: 7, stdout: "x", machine: TARGET.machine });
  });

  test("--json after -- belongs to the command, so output is the command's own", () => {
    const run = runExec(["--cwd", "/srv", "--", "tool", "--json"], { target: true, reply: result({ stdout: "plain" }) });
    expect(run.calls[0]!.body).toEqual({ argv: ["tool", "--json"], cwd: "/srv" });
    expect(run.stdout.toString()).toBe("plain");
  });

  test("without --json writes the exact output bytes and exits with the command's code", () => {
    const bytes = Buffer.from([0x00, 0xff, 0x41]);
    const run = runExec(["--cwd", "/srv", "--", "tool"], {
      target: true, reply: result({ exitCode: 7, stdout: bytes.toString("base64"), stdoutEncoding: "base64", stderr: "warn\n" }),
    });
    expect(run.code).toBe(7);
    expect(Buffer.from(run.stdout)).toEqual(bytes);
    expect(run.stderr).toContain("warn\n");
  });

  test("without --json a timeout exits 124, a signal exits 128 plus its number, and truncation is noted on stderr", () => {
    const timedOut = runExec(["--cwd", "/srv", "--timeout", "1", "--", "sleep", "9"], {
      target: true, reply: result({ exitCode: null, signal: "SIGKILL", timedOut: true, stdout: "partial", stdoutBytes: 2_000_000, stdoutTruncated: true }),
    });
    expect(timedOut.code).toBe(124);
    expect(timedOut.stdout.toString()).toBe("partial");
    expect(timedOut.stderr).toContain("timed out");
    expect(timedOut.stderr).toContain("stdout truncated");
    const signalled = runExec(["--cwd", "/srv", "--", "tool"], { target: true, reply: result({ exitCode: null, signal: "SIGTERM" }) });
    expect(signalled.code).toBe(128 + 15);
  });

  test("refuses a relative cwd with --machine before any request, and resolves it locally without", () => {
    const remote = runExec(["--cwd", "src", "--json", "--", "ls"], { target: true });
    expect(remote.code).toBe(2);
    expect(remote.calls).toEqual([]);
    expect(JSON.parse(remote.stdout.toString()).error.code).toBe("INVALID_ARGUMENTS");

    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-cli-exec-")));
    try {
      const local = runExec(["--cwd", "sub", "--json", "--", "ls"], { cwd: dir, reply: result() });
      expect(local.calls).toEqual([{ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/api\/exec$/), body: { argv: ["ls"], cwd: join(dir, "sub") } }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an auth refusal exits 5 and a busy server exits 1 with its code", () => {
    const auth = runExec(["--cwd", "/srv", "--json", "--", "ls"], { target: true, status: 401, reply: { error: "unauthorized" } });
    expect(auth.code).toBe(5);
    expect(JSON.parse(auth.stdout.toString())).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" }, machine: TARGET.machine });
    const busy = runExec(["--cwd", "/srv", "--json", "--", "ls"], { target: true, status: 429, reply: { error: "busy", code: "EXEC_BUSY", maxConcurrent: 4 } });
    expect(busy.code).toBe(1);
    expect(JSON.parse(busy.stdout.toString())).toMatchObject({ ok: false, error: { code: "EXEC_BUSY" }, maxConcurrent: 4 });
  });

  test("prints help only for exec alone or exec --help before --", () => {
    for (const args of [[], ["--help"], ["-h"]]) {
      const run = runExec(args);
      expect(run.code, args.join(" ")).toBe(0);
      expect(run.stdout.toString()).toContain("Usage: wolfpack [--machine <short-name-or-fqdn>] exec");
      expect(run.calls).toEqual([]);
    }
    expect(runExec(["--cwd", "/srv", "--", "tool", "--help"], { target: true, reply: result() }).calls).toHaveLength(1);
  });

  test("rejects invalid arguments", () => {
    for (const args of [
      ["--", "ls"],
      ["--cwd", "/srv"],
      ["--cwd", "/srv", "ls"],
      ["--cwd", "/srv", "--"],
      ["--cwd", "/srv", "--timeout", "0", "--", "ls"],
      ["--cwd", "/srv", "--timeout", "601", "--", "ls"],
      ["--cwd", "/srv", "--timeout", "1.5", "--", "ls"],
      ["--cwd", "/srv", "--cwd", "/x", "--", "ls"],
      ["--cwd", "/srv", "--env", "A=1", "--", "ls"],
      ["--cwd", "/srv", "--", ""],
    ]) {
      const run = runExec([...args, ...(args.includes("--") ? [] : ["--json"])], { target: true });
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.calls, args.join(" ")).toEqual([]);
    }
  });
});
