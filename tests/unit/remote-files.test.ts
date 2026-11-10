import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  rmSync, statSync, symlinkSync, truncateSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteOpsRoutes } from "../../src/server/remote-ops-routes.ts";
import { routes } from "../../src/server/routes.ts";
import { shouldAuthenticateApiPath } from "../../src/server/http.ts";
import {
  REMOTE_FILE_ERROR,
  REMOTE_FILE_MAX_BYTES,
  REMOTE_FILE_ROUTE,
} from "../../src/remote-ops-contract.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;
type Reply = { status: number; body: Record<string, unknown> };

const fileRoutes = createRemoteOpsRoutes();
const route = (path: string): Handler => fileRoutes[`POST ${path}`]!;

/** In-process request: the sandbox that runs these checks cannot bind ports. */
async function call(path: string, body: unknown): Promise<Reply> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Object.assign(Readable.from([Buffer.from(raw)]), { headers: {}, method: "POST", url: path }) as unknown as IncomingMessage;
  let status = 0;
  let text = "";
  const done = new Promise<void>(resolve => {
    const res = {
      headersSent: false,
      writeHead(code: number) { status = code; return res; },
      setHeader() { return res; },
      end(chunk?: string) { text = chunk ?? ""; resolve(); return res; },
    };
    void route(path)(req, res as unknown as ServerResponse);
  });
  await done;
  return { status, body: JSON.parse(text) as Record<string, unknown> };
}

const read = (path: string) => call(REMOTE_FILE_ROUTE.READ, { path });
const write = (path: string, bytes: Buffer | string, extra: Record<string, unknown> = {}) =>
  call(REMOTE_FILE_ROUTE.WRITE, { path, encoding: "base64", content: Buffer.from(bytes).toString("base64"), ...extra });
const edit = (path: string, oldText: string, newText: string, extra: Record<string, unknown> = {}) =>
  call(REMOTE_FILE_ROUTE.EDIT, { path, old: oldText, new: newText, ...extra });

let dir = "";
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "wolfpack-remote-files-"))); });
afterEach(() => {
  try { chmodSync(dir, 0o755); } catch { /* already removed */ }
  rmSync(dir, { recursive: true, force: true });
});

function captureLog<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const original = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  return run().then(
    (result) => { process.stdout.write = original; return { result, lines }; },
    (error: unknown) => { process.stdout.write = original; throw error; },
  );
}

describe("remote file routes", () => {
  test("sit behind the global API auth gate and in the production route map", () => {
    for (const path of Object.values(REMOTE_FILE_ROUTE)) {
      expect(shouldAuthenticateApiPath(path), path).toBe(true);
      expect(routes[`POST ${path}`], path).toBeFunction();
    }
  });

  test("read returns text, or base64 with a flag for binary content, and the resolved path", async () => {
    const text = join(dir, "notes.txt");
    writeFileSync(text, "hello\nworld\n");
    expect(await read(text)).toEqual({ status: 200, body: {
      ok: true, path: text, resolvedPath: text, size: 12, binary: false, encoding: "utf8", content: "hello\nworld\n",
    } });

    const binary = join(dir, "blob.bin");
    const bytes = Buffer.from([0xff, 0x00, 0xfe, 0x41]);
    writeFileSync(binary, bytes);
    const reply = await read(binary);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ binary: true, encoding: "base64", size: 4 });
    expect(Buffer.from(reply.body.content as string, "base64")).toEqual(bytes);

    const link = join(dir, "link.txt");
    symlinkSync(text, link);
    expect((await read(link)).body).toMatchObject({ path: link, resolvedPath: text, content: "hello\nworld\n" });
  });

  test("read refuses a relative, missing, non-regular or oversized path with explicit codes", async () => {
    expect(await read("relative/notes.txt")).toMatchObject({ status: 400, body: { code: REMOTE_FILE_ERROR.PATH_NOT_ABSOLUTE } });
    expect(await read(join(dir, "missing.txt"))).toMatchObject({ status: 404, body: { code: REMOTE_FILE_ERROR.NOT_FOUND } });
    expect(await read(dir)).toMatchObject({ status: 409, body: { code: REMOTE_FILE_ERROR.NOT_A_FILE } });
    const fifo = join(dir, "pipe");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    expect(await read(fifo)).toMatchObject({ status: 409, body: { code: REMOTE_FILE_ERROR.NOT_A_FILE } });

    const large = join(dir, "large.bin");
    writeFileSync(large, "");
    truncateSync(large, REMOTE_FILE_MAX_BYTES + 1);
    const reply = await read(large);
    expect(reply).toMatchObject({ status: 413, body: { code: REMOTE_FILE_ERROR.FILE_TOO_LARGE, size: REMOTE_FILE_MAX_BYTES + 1, maxBytes: REMOTE_FILE_MAX_BYTES } });
    expect(String(reply.body.error)).toContain(String(REMOTE_FILE_MAX_BYTES + 1));
  });

  test("write creates a file with the default mode, replaces atomically and preserves an existing mode", async () => {
    const reference = join(dir, "reference.txt");
    writeFileSync(reference, "x");
    const created = join(dir, "new.txt");
    expect(await write(created, "first")).toEqual({ status: 200, body: { ok: true, path: created, resolvedPath: created, size: 5, created: true } });
    expect(readFileSync(created, "utf8")).toBe("first");
    expect(statSync(created).mode & 0o777).toBe(statSync(reference).mode & 0o777);

    chmodSync(created, 0o750);
    expect((await write(created, "second")).body).toMatchObject({ ok: true, size: 6, created: false });
    expect(readFileSync(created, "utf8")).toBe("second");
    expect(statSync(created).mode & 0o777).toBe(0o750);
    expect(readdirSync(dir).sort()).toEqual(["new.txt", "reference.txt"]);
  });

  test("write accepts a body above the default 64 KiB limit and refuses content above the cap", async () => {
    const path = join(dir, "big.txt");
    const body = Buffer.alloc(100 * 1024, 0x61);
    expect((await write(path, body)).body).toMatchObject({ ok: true, size: body.length });
    expect(readFileSync(path)).toEqual(body);

    const over = await write(path, Buffer.alloc(REMOTE_FILE_MAX_BYTES + 1, 0x62));
    expect(over).toMatchObject({ status: 413, body: { code: REMOTE_FILE_ERROR.FILE_TOO_LARGE, size: REMOTE_FILE_MAX_BYTES + 1 } });
    expect(readFileSync(path)).toEqual(body);

    const tooLargeBody = await call(REMOTE_FILE_ROUTE.WRITE, { path, encoding: "utf8", content: "c".repeat(REMOTE_FILE_MAX_BYTES * 2) });
    expect(tooLargeBody).toMatchObject({ status: 413, body: { code: REMOTE_FILE_ERROR.REQUEST_TOO_LARGE } });
    expect(readFileSync(path)).toEqual(body);
  });

  test("write --create-only refuses an existing file and leaves it unchanged", async () => {
    const path = join(dir, "keep.txt");
    writeFileSync(path, "original");
    expect(await write(path, "replacement", { createOnly: true })).toMatchObject({ status: 409, body: { code: REMOTE_FILE_ERROR.FILE_EXISTS } });
    expect(readFileSync(path, "utf8")).toBe("original");
    const fresh = join(dir, "fresh.txt");
    expect((await write(fresh, "made", { createOnly: true })).body).toMatchObject({ ok: true, created: true });
    expect(readFileSync(fresh, "utf8")).toBe("made");
    expect(readdirSync(dir).sort()).toEqual(["fresh.txt", "keep.txt"]);
  });

  test("write follows a symlink like a shell and refuses a dangling one", async () => {
    const target = join(dir, "target.txt");
    writeFileSync(target, "old");
    const link = join(dir, "link.txt");
    symlinkSync(target, link);
    expect((await write(link, "through link")).body).toMatchObject({ path: link, resolvedPath: target, created: false });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("through link");

    const dangling = join(dir, "dangling.txt");
    symlinkSync(join(dir, "nowhere.txt"), dangling);
    expect(await write(dangling, "x")).toMatchObject({ status: 409, body: { code: REMOTE_FILE_ERROR.DANGLING_SYMLINK } });
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
  });

  test("a failed write leaves the existing file unchanged and no temp file behind", async () => {
    const locked = join(dir, "locked");
    mkdirSync(locked);
    const path = join(locked, "file.txt");
    writeFileSync(path, "intact");
    chmodSync(locked, 0o555);
    try {
      expect(await write(path, "clobber")).toMatchObject({ status: 403, body: { code: REMOTE_FILE_ERROR.PERMISSION_DENIED } });
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(readFileSync(path, "utf8")).toBe("intact");
    expect(readdirSync(locked)).toEqual(["file.txt"]);
    expect(await write(join(dir, "no-dir", "file.txt"), "x")).toMatchObject({ status: 404, body: { code: REMOTE_FILE_ERROR.NOT_FOUND } });
  });

  test("write rejects malformed requests", async () => {
    const path = join(dir, "file.txt");
    for (const body of [
      { path, encoding: "base64", content: "not base64!" },
      { path, encoding: "base64", content: "YQ" },
      { path, encoding: "hex", content: "61" },
      { path, encoding: "utf8" },
      { path, encoding: "utf8", content: "x", createOnly: false },
      { path, encoding: "utf8", content: "x", extra: 1 },
      { path: "", encoding: "utf8", content: "x" },
      { path: `${dir}/a\u0000b`, encoding: "utf8", content: "x" },
    ]) {
      expect(await call(REMOTE_FILE_ROUTE.WRITE, body), JSON.stringify(body)).toMatchObject({ status: 400, body: { code: REMOTE_FILE_ERROR.INVALID_REQUEST } });
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  test("edit replaces exactly one match and treats the replacement literally", async () => {
    const path = join(dir, "code.ts");
    writeFileSync(path, "const a = 1;\nconst b = 2;\n");
    chmodSync(path, 0o640);
    expect(await edit(path, "const b = 2;", "const b = '$&';")).toEqual({ status: 200, body: {
      ok: true, path, resolvedPath: path, size: 29, replacements: 1,
    } });
    expect(readFileSync(path, "utf8")).toBe("const a = 1;\nconst b = '$&';\n");
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  test("edit with zero or several matches reports the count and leaves the file unchanged", async () => {
    const path = join(dir, "repeat.txt");
    writeFileSync(path, "x y x y x");
    expect(await edit(path, "z", "w")).toMatchObject({ status: 409, body: { code: REMOTE_FILE_ERROR.EDIT_MATCH_COUNT, matches: 0 } });
    expect(await edit(path, "x", "w")).toMatchObject({ status: 409, body: { code: REMOTE_FILE_ERROR.EDIT_MATCH_COUNT, matches: 3 } });
    expect(readFileSync(path, "utf8")).toBe("x y x y x");
    expect(await edit(path, "z", "w", { all: true })).toMatchObject({ status: 409, body: { matches: 0 } });
    expect((await edit(path, "x", "w", { all: true })).body).toMatchObject({ ok: true, replacements: 3 });
    expect(readFileSync(path, "utf8")).toBe("w y w y w");
    expect(readdirSync(dir)).toEqual(["repeat.txt"]);
  });

  test("edit keeps a byte order mark, follows a symlink, and refuses binary, empty-old and oversized results", async () => {
    const target = join(dir, "bom.txt");
    writeFileSync(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("alpha beta")]));
    const link = join(dir, "bom-link.txt");
    symlinkSync(target, link);
    expect((await edit(link, "beta", "gamma")).body).toMatchObject({ ok: true, resolvedPath: target, replacements: 1 });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target)).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("alpha gamma")]));

    const binary = join(dir, "blob.bin");
    writeFileSync(binary, Buffer.from([0x61, 0xff, 0x62]));
    expect(await edit(binary, "a", "b")).toMatchObject({ status: 409, body: { code: REMOTE_FILE_ERROR.BINARY_FILE } });
    expect(await edit(target, "", "x")).toMatchObject({ status: 400, body: { code: REMOTE_FILE_ERROR.INVALID_REQUEST } });

    const growing = join(dir, "grow.txt");
    writeFileSync(growing, "ab");
    const result = await edit(growing, "b", "b".repeat(REMOTE_FILE_MAX_BYTES));
    expect(result).toMatchObject({ status: 413, body: { code: REMOTE_FILE_ERROR.FILE_TOO_LARGE, size: REMOTE_FILE_MAX_BYTES + 1 } });
    expect(readFileSync(growing, "utf8")).toBe("ab");
  });

  test("a replace-all whose result would exceed the cap is refused with its size before it is built", async () => {
    const target = join(dir, "amplify.txt");
    writeFileSync(target, "a".repeat(100_000));
    const result = await edit(target, "a", "b".repeat(100_000), { all: true });
    // 100,000 matches each grow by 99,999 bytes: 100,000 + 100,000 * 99,999 = 10,000,000,000 bytes.
    expect(result).toMatchObject({ status: 413, body: { code: REMOTE_FILE_ERROR.FILE_TOO_LARGE, size: 10_000_000_000, maxBytes: REMOTE_FILE_MAX_BYTES } });
    expect(readFileSync(target, "utf8")).toBe("a".repeat(100_000));
  });

  test("write and edit log an audit line with the path and byte count, never the content", async () => {
    const path = join(dir, "secret.txt");
    const { lines } = await captureLog(async () => {
      await write(path, "TOP-SECRET-CONTENT");
      await edit(path, "SECRET", "HIDDEN-REPLACEMENT");
      await edit(path, "NOT-THERE-OLD-TEXT", "x");
    });
    const entries = lines.map(line => JSON.parse(line) as Record<string, unknown>);
    expect(entries.map(entry => entry.msg)).toEqual(["remote file write", "remote file edit", "remote file edit failed"]);
    expect(entries[0]).toMatchObject({ level: "info", component: "remote-ops", path, bytes: 18, created: true });
    expect(entries[1]).toMatchObject({ level: "info", path, bytes: 30, replacements: 1 });
    expect(entries[2]).toMatchObject({ level: "info", path, code: REMOTE_FILE_ERROR.EDIT_MATCH_COUNT });
    for (const entry of entries) expect(typeof entry.durationMs).toBe("number");
    const all = lines.join("");
    for (const secret of ["TOP-SECRET", "HIDDEN-REPLACEMENT", "NOT-THERE-OLD-TEXT"]) expect(all).not.toContain(secret);
  });
});
