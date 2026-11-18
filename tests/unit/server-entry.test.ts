import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("importing the server without a test flag creates no listener, quotas or WebSocketServer and preserves PATH", () => {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-entry-import-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, WOLFPACK_DIR: join(home, "state"), WOLFPACK_PORT: "18899" };
    delete env.WOLFPACK_TEST;
    const result = spawnSync(process.execPath, ["-e", `
      import { mock } from "bun:test";
      const http = await import("node:http");
      const ws = await import("ws");
      let created = 0;
      mock.module("node:http", () => ({ ...http, createServer() { created++; throw new Error("import created a listener"); } }));
      mock.module("ws", () => ({ ...ws, WebSocketServer: class { constructor() { created++; throw new Error("import created a WebSocketServer"); } } }));
      const path = process.env.PATH;
      const module = await import("./src/server/index.ts");
      console.log(JSON.stringify({ created, samePath: path === process.env.PATH, hasServer: "server" in module, hasWss: "wss" in module }));
    `], { env, encoding: "utf8", timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ created: 0, samePath: true, hasServer: false, hasWss: false });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("context supervisor starts by default and can explicitly remain stopped without a test flag", () => {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-entry-supervisor-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, WOLFPACK_DIR: join(home, "state") };
    delete env.WOLFPACK_TEST;
    delete env.XDG_RUNTIME_DIR;
    const result = spawnSync(process.execPath, ["-e", `
      const { createServerContext } = await import("./src/server/context.ts");
      let defaultError;
      try { createServerContext(); } catch(error) { defaultError = error.message; }
      const stopped = createServerContext({ startSupervisor: false });
      console.log(JSON.stringify({ defaultStarts: defaultError?.includes("broker socket missing"), stopped: stopped.supervisor.backend() === null }));
      await stopped.close();
    `], { env, encoding: "utf8", timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ defaultStarts: true, stopped: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
