import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_FILE_MAX_BYTES } from "../../src/remote-ops-contract.ts";

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

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-cli-remote-ops-")));
  dirs.push(dir);
  return dir;
}

interface Run { readonly code: number; readonly stdout: Buffer; readonly calls: Array<{ url: string; body: Record<string, unknown> }> }

/**
 * Run `fileCommand` in a child bun with a fetch stub. `reply` is the JSON body and
 * `status` the stub answers with; calls go to stderr after a `CALLS:` marker.
 */
function runFile(args: readonly string[], options: { target?: boolean; reply?: unknown; status?: number; stdin?: Buffer; cwd?: string } = {}): Run {
  const script = `
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return Response.json(${JSON.stringify(options.reply ?? { ok: true })}, { status: ${options.status ?? 200} });
    };
    const { fileCommand } = await import(${JSON.stringify(join(process.cwd(), "src/cli/remote-ops.ts"))});
    const code = await fileCommand(${JSON.stringify(args)}, ${options.target ? JSON.stringify(TARGET) : "undefined"});
    process.stderr.write("\\nCALLS:" + JSON.stringify(calls));
    process.exit(code);
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, NO_COLOR: "1" },
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = child.stderr.toString();
  const marker = stderr.lastIndexOf("CALLS:");
  if (marker < 0) throw new Error(`fileCommand did not finish: ${stderr}`);
  return { code: child.exitCode ?? -1, stdout: child.stdout, calls: JSON.parse(stderr.slice(marker + "CALLS:".length)) };
}

describe("wolfpack file", () => {
  test("routes read, write and edit to the verified machine and adds its identity once", () => {
    const dir = tempDir();
    const local = join(dir, "payload.bin");
    writeFileSync(local, Buffer.from([0, 1, 2, 255]));

    const readRun = runFile(["read", "/srv/notes.txt", "--json"], { target: true, reply: { ok: true, path: "/srv/notes.txt", resolvedPath: "/srv/notes.txt", size: 2, binary: false, encoding: "utf8", content: "hi" } });
    expect(readRun.code).toBe(0);
    expect(readRun.calls).toEqual([{ url: `${ORIGIN}/api/file/read`, body: { path: "/srv/notes.txt" } }]);
    expect(JSON.parse(readRun.stdout.toString())).toMatchObject({ content: "hi", machine: TARGET.machine });

    const writeRun = runFile(["write", "/srv/payload.bin", "--from", local, "--create-only", "--json"], { target: true, reply: { ok: true, path: "/srv/payload.bin", resolvedPath: "/srv/payload.bin", size: 4, created: true } });
    expect(writeRun.code).toBe(0);
    expect(writeRun.calls).toEqual([{ url: `${ORIGIN}/api/file/write`, body: { path: "/srv/payload.bin", encoding: "base64", content: "AAEC/w==", createOnly: true } }]);
    expect(JSON.parse(writeRun.stdout.toString()).machine).toEqual(TARGET.machine);

    const editRun = runFile(["edit", "/srv/a.ts", "--old", "-x", "--new", "", "--all", "--json"], { target: true, reply: { ok: true, path: "/srv/a.ts", resolvedPath: "/srv/a.ts", size: 1, replacements: 2 } });
    expect(editRun.code).toBe(0);
    expect(editRun.calls).toEqual([{ url: `${ORIGIN}/api/file/edit`, body: { path: "/srv/a.ts", old: "-x", new: "", all: true } }]);
  });

  test("refuses a relative path with --machine before any request", () => {
    const run = runFile(["read", "notes.txt", "--json"], { target: true });
    expect(run.code).toBe(2);
    expect(run.calls).toEqual([]);
    expect(JSON.parse(run.stdout.toString()).error.code).toBe("INVALID_ARGUMENTS");
  });

  test("resolves a relative path against the local working directory without --machine", () => {
    const dir = tempDir();
    const run = runFile(["read", "sub/notes.txt", "--json"], { cwd: dir, reply: { ok: true } });
    expect(run.code).toBe(0);
    expect(run.calls).toEqual([{ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/api\/file\/read$/), body: { path: join(dir, "sub/notes.txt") } }]);
  });

  test("read without --json writes the exact bytes with no added newline", () => {
    const bytes = Buffer.from([0x00, 0xff, 0x0a, 0x41]);
    const binary = runFile(["read", "/srv/blob"], { target: true, reply: { ok: true, binary: true, encoding: "base64", content: bytes.toString("base64") } });
    expect(binary.code).toBe(0);
    expect(Buffer.from(binary.stdout)).toEqual(bytes);
    const text = runFile(["read", "/srv/t"], { target: true, reply: { ok: true, binary: false, encoding: "utf8", content: "no newline" } });
    expect(text.stdout.toString()).toBe("no newline");
  });

  test("write --stdin sends the piped bytes", () => {
    const run = runFile(["write", "/srv/in.txt", "--stdin", "--json"], { target: true, stdin: Buffer.from("piped\n"), reply: { ok: true, created: false } });
    expect(run.code).toBe(0);
    expect(run.calls[0]!.body).toEqual({ path: "/srv/in.txt", encoding: "base64", content: Buffer.from("piped\n").toString("base64") });
  });

  test("refuses local content above the cap before any request", () => {
    const dir = tempDir();
    const large = join(dir, "large.bin");
    writeFileSync(large, "");
    truncateSync(large, REMOTE_FILE_MAX_BYTES + 1);
    const run = runFile(["write", "/srv/large.bin", "--from", large, "--json"], { target: true });
    expect(run.code).toBe(1);
    expect(run.calls).toEqual([]);
    expect(JSON.parse(run.stdout.toString())).toMatchObject({ ok: false, error: { code: "FILE_TOO_LARGE" }, size: REMOTE_FILE_MAX_BYTES + 1 });
  });

  test("reports a server refusal with its code and details", () => {
    const run = runFile(["edit", "/srv/a.ts", "--old", "x", "--new", "y", "--json"], {
      target: true,
      status: 409,
      reply: { error: "old text matched 3 times; expected exactly 1", code: "EDIT_MATCH_COUNT", matches: 3 },
    });
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout.toString())).toEqual({
      ok: false,
      error: { code: "EDIT_MATCH_COUNT", message: "old text matched 3 times; expected exactly 1" },
      matches: 3,
      machine: TARGET.machine,
    });
  });

  test("an auth refusal exits with the auth code", () => {
    const run = runFile(["read", "/srv/a.txt", "--json"], { target: true, status: 401, reply: { error: "Unauthorized" } });
    expect(run.code).toBe(5);
    expect(JSON.parse(run.stdout.toString())).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" }, machine: TARGET.machine });
  });

  test("rejects invalid arguments", () => {
    for (const args of [
      ["read"],
      ["read", "/a", "/b"],
      ["write", "/a"],
      ["write", "/a", "--stdin", "--from", "/x"],
      ["edit", "/a", "--old", "x"],
      ["edit", "/a", "--new", "y"],
      ["edit", "/a", "--old", "", "--new", "y"],
      ["edit", "/a", "--old", "x", "--new", "y", "--old", "z"],
      ["move", "/a"],
    ]) {
      const run = runFile([...args, "--json"], { target: true });
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.calls, args.join(" ")).toEqual([]);
    }
  });
});
