import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteOpsRoutes } from "../../src/server/remote-ops-routes.ts";
import { routes } from "../../src/server/routes.ts";
import { shouldAuthenticateApiPath } from "../../src/server/http.ts";
import {
  REMOTE_EXEC_ERROR,
  REMOTE_EXEC_MAX_CONCURRENT,
  REMOTE_EXEC_OUTPUT_MAX_BYTES,
  REMOTE_EXEC_ROUTE,
} from "../../src/remote-ops-contract.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;
type Reply = { status: number; body: Record<string, unknown> };

const handler = (): Handler => createRemoteOpsRoutes()[`POST ${REMOTE_EXEC_ROUTE}`]!;

/** In-process request: the sandbox that runs these checks cannot bind ports. `res` emits `close` like a dropped connection. */
function start(body: unknown): { reply: Promise<Reply>; res: EventEmitter } {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Object.assign(Readable.from([Buffer.from(raw)]), { headers: {}, method: "POST", url: REMOTE_EXEC_ROUTE }) as unknown as IncomingMessage;
  const res = Object.assign(new EventEmitter(), { headersSent: false, writableFinished: false });
  const reply = new Promise<Reply>(resolve => {
    let status = 0;
    Object.assign(res, {
      writeHead(code: number) { status = code; return res; },
      setHeader() { return res; },
      end(chunk?: string) { res.writableFinished = true; resolve({ status, body: JSON.parse(chunk ?? "") as Record<string, unknown> }); return res; },
    });
    void handler()(req, res as unknown as ServerResponse);
  });
  return { reply, res };
}
const exec = (body: unknown) => start(body).reply;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function eventually(check: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (check()) return true; await Bun.sleep(20); }
  return check();
}

function captureLog<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const original = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  return run().then(
    (result) => { process.stdout.write = original; return { result, lines }; },
    (error: unknown) => { process.stdout.write = original; throw error; },
  );
}

let dir = "";
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-remote-exec-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("remote exec route", () => {
  test("sits behind the global API auth gate and in the production route map", () => {
    expect(shouldAuthenticateApiPath(REMOTE_EXEC_ROUTE)).toBe(true);
    expect(routes[`POST ${REMOTE_EXEC_ROUTE}`]).toBeFunction();
  });

  test("runs argv without a shell in the cwd and returns the exit code and both outputs", async () => {
    expect(await exec({ argv: ["sh", "-c", "printf out; printf err >&2; pwd >&2; exit 3"], cwd: dir })).toMatchObject({ status: 200, body: {
      ok: true, cwd: dir, exitCode: 3, signal: null, timedOut: false,
      stdout: "out", stdoutEncoding: "utf8", stdoutBytes: 3, stdoutTruncated: false,
      stderr: `err${dir}\n`, stderrEncoding: "utf8", stderrTruncated: false,
    } });
    // No shell: metacharacters and variables reach the program verbatim.
    expect((await exec({ argv: ["echo", "$HOME", "a;b", "*"], cwd: dir })).body).toMatchObject({ exitCode: 0, stdout: "$HOME a;b *\n" });
  });

  test("uses the server environment, closes stdin and refuses a request environment", async () => {
    process.env.WOLFPACK_EXEC_TEST_PROBE = "server-side";
    try {
      expect((await exec({ argv: ["sh", "-c", "printf %s \"$WOLFPACK_EXEC_TEST_PROBE\""], cwd: dir })).body).toMatchObject({ stdout: "server-side" });
    } finally {
      delete process.env.WOLFPACK_EXEC_TEST_PROBE;
    }
    const started = Date.now();
    expect((await exec({ argv: ["cat"], cwd: dir, timeoutSeconds: 5 })).body).toMatchObject({ exitCode: 0, stdout: "", timedOut: false });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await exec({ argv: ["true"], cwd: dir, env: { A: "1" } })).toMatchObject({ status: 400, body: { code: REMOTE_EXEC_ERROR.INVALID_REQUEST } });
  });

  test("refuses a bad cwd or a missing command with distinct codes", async () => {
    const file = join(dir, "file.txt");
    writeFileSync(file, "x");
    expect(await exec({ argv: ["true"], cwd: "relative" })).toMatchObject({ status: 400, body: { code: REMOTE_EXEC_ERROR.CWD_NOT_ABSOLUTE } });
    expect(await exec({ argv: ["true"], cwd: join(dir, "missing") })).toMatchObject({ status: 404, body: { code: REMOTE_EXEC_ERROR.CWD_NOT_FOUND } });
    expect(await exec({ argv: ["true"], cwd: file })).toMatchObject({ status: 409, body: { code: REMOTE_EXEC_ERROR.CWD_NOT_DIRECTORY } });
    expect(await exec({ argv: ["wolfpack-no-such-command-x"], cwd: dir })).toMatchObject({ status: 404, body: { code: REMOTE_EXEC_ERROR.COMMAND_NOT_FOUND } });
  });

  test("rejects invalid requests", async () => {
    for (const body of [
      {}, { cwd: dir }, { argv: [], cwd: dir }, { argv: [""], cwd: dir }, { argv: ["true", 1], cwd: dir },
      { argv: ["true", "a\0b"], cwd: dir }, { argv: "true", cwd: dir }, { argv: ["true"] },
      { argv: ["true"], cwd: dir, timeoutSeconds: 0 }, { argv: ["true"], cwd: dir, timeoutSeconds: 601 },
      { argv: ["true"], cwd: dir, timeoutSeconds: 1.5 }, { argv: ["true"], cwd: dir, shell: true },
    ]) {
      expect(await exec(body), JSON.stringify(body)).toMatchObject({ status: 400, body: { code: REMOTE_EXEC_ERROR.INVALID_REQUEST } });
    }
  });

  test("a timeout kills the whole process group and reports timedOut", async () => {
    const started = Date.now();
    const reply = await exec({ argv: ["sh", "-c", "sleep 300 & echo $!; wait"], cwd: dir, timeoutSeconds: 1 });
    expect(reply.body).toMatchObject({ ok: true, timedOut: true, exitCode: null, signal: "SIGKILL" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(Date.now() - started).toBeLessThan(5000);
    const grandchild = Number(String(reply.body.stdout).trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(await eventually(() => !alive(grandchild))).toBe(true);
  });

  test("a background child holding the output pipe does not hang the request and dies with the command", async () => {
    const started = Date.now();
    const reply = await exec({ argv: ["sh", "-c", "sleep 300 & echo $!"], cwd: dir, timeoutSeconds: 30 });
    expect(reply.body).toMatchObject({ exitCode: 0, timedOut: false });
    expect(Date.now() - started).toBeLessThan(5000);
    const grandchild = Number(String(reply.body.stdout).trim());
    expect(await eventually(() => !alive(grandchild))).toBe(true);
  });

  test("output beyond the cap is drained and discarded, with truncated flags and total byte counts", async () => {
    const flood = await exec({ argv: ["sh", "-c", "head -c 3000000 /dev/zero; printf tail >&2"], cwd: dir, timeoutSeconds: 30 });
    expect(flood.body).toMatchObject({
      exitCode: 0, timedOut: false, stdoutEncoding: "base64", stdoutBytes: 3_000_000, stdoutTruncated: true,
      stderr: "tail", stderrTruncated: false,
    });
    expect(Buffer.from(String(flood.body.stdout), "base64").length).toBe(REMOTE_EXEC_OUTPUT_MAX_BYTES);

    // The cap splits a two-byte character; the partial tail is dropped and the text stays UTF-8.
    const text = await exec({ argv: [process.execPath, "-e", "process.stdout.write('a' + 'é'.repeat(600000))"], cwd: dir, timeoutSeconds: 30 });
    expect(text.body).toMatchObject({ exitCode: 0, stdoutEncoding: "utf8", stdoutTruncated: true, stdoutBytes: 1_200_001 });
    expect(Buffer.byteLength(String(text.body.stdout))).toBe(REMOTE_EXEC_OUTPUT_MAX_BYTES - 1);
  });

  test("refuses a command above the concurrency limit and admits one again after the others finish", async () => {
    const long = Array.from({ length: REMOTE_EXEC_MAX_CONCURRENT }, () => exec({ argv: ["sleep", "30"], cwd: dir, timeoutSeconds: 1 }));
    await Bun.sleep(200);
    expect(await exec({ argv: ["true"], cwd: dir })).toMatchObject({ status: 429, body: { code: REMOTE_EXEC_ERROR.EXEC_BUSY, maxConcurrent: REMOTE_EXEC_MAX_CONCURRENT } });
    for (const reply of await Promise.all(long)) expect(reply.body).toMatchObject({ timedOut: true });
    // Failed requests release their slot too.
    for (let index = 0; index <= REMOTE_EXEC_MAX_CONCURRENT; index++) {
      expect((await exec({ argv: ["true"], cwd: join(dir, "missing") })).status).toBe(404);
    }
    expect((await exec({ argv: ["true"], cwd: dir })).body).toMatchObject({ exitCode: 0 });
  });

  test("a dropped connection kills the command's process group", async () => {
    const running = start({ argv: ["sh", "-c", "echo $! >&2; sleep 300 & echo $!; wait"], cwd: dir, timeoutSeconds: 600 });
    await Bun.sleep(300);
    const started = Date.now();
    running.res.emit("close");
    const reply = await running.reply;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(reply.body).toMatchObject({ timedOut: false, signal: "SIGKILL" });
    const grandchild = Number(String(reply.body.stdout).trim());
    expect(await eventually(() => !alive(grandchild))).toBe(true);
  });

  test("audit lines name the cwd, argv[0], byte counts, exit and duration, and never other argv or output", async () => {
    const { lines } = await captureLog(async () => {
      await exec({ argv: ["sh", "-c", "printf SECRET_OUTPUT_1; printf SECRET_OUTPUT_2 >&2", "SECRET_ARG_0"], cwd: dir });
      await exec({ argv: ["sh", "-c", "sleep 30", "SECRET_ARG_1"], cwd: dir, timeoutSeconds: 1 });
      await exec({ argv: ["wolfpack-no-such-command-x", "SECRET_ARG_2"], cwd: dir });
    });
    const records = lines.filter(line => line.includes("remote exec")).map(line => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ level: "info", component: "remote-ops", cwd: dir, command: "sh", exitCode: 0, stdoutBytes: 15, stderrBytes: 15, timedOut: false });
    expect(typeof records[0]!.durationMs).toBe("number");
    expect(records[1]).toMatchObject({ command: "sh", timedOut: true, signal: "SIGKILL" });
    expect(records[2]).toMatchObject({ command: "wolfpack-no-such-command-x", code: REMOTE_EXEC_ERROR.COMMAND_NOT_FOUND });
    for (const line of lines) expect(line).not.toMatch(/SECRET_|printf|sleep 30/);
  });
});
