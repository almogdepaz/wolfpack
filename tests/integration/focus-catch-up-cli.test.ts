import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

test("catch-up CLI posts only to the resolved local home, returns status and surfaces refusal/offline without writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "focus-catch-up-cli-"));
  const requests: string[] = [];
  let local = true, refuse = false;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/focus") res.end(JSON.stringify({ local, home: "home-id", document: null }));
    else if (req.url === "/api/tailnet/v1/candidates") res.end(JSON.stringify({ candidates: [] }));
    else if (req.url === "/api/focus/catch-up" && req.method === "POST") { res.statusCode = refuse ? 409 : 200; res.end(JSON.stringify(refuse ? { error: "assistant is off" } : { pending: true })); }
    else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(root, "config.json"), JSON.stringify({ devDir: root, port: (server.address() as AddressInfo).port }));
  const run = async () => {
    const child = Bun.spawn([process.execPath, "src/cli/index.ts", "focus", "catch-up", "--json"], { env: { ...process.env, WOLFPACK_DIR: root, WOLFPACK_TEST: "1", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exit, stdout, stderr };
  };
  try {
    const ok = await run();
    expect(ok.exit).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({ pending: true });
    expect(requests).toEqual(["GET /api/focus", "POST /api/focus/catch-up"]);
    requests.length = 0; refuse = true;
    const off = await run();
    expect(off.exit).toBe(1);
    expect(JSON.parse(off.stdout).error).toBe("assistant is off");
    requests.length = 0; local = false;
    const offline = await run();
    expect(offline.exit).toBe(1);
    expect(JSON.parse(offline.stdout).error).toContain("offline");
    expect(requests.every(r => r.startsWith("GET "))).toBe(true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
