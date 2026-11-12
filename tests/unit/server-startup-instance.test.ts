import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("startup returns its owned server/wss and constructs only one WebSocketServer", () => {
  const home = mkdtempSync(join(tmpdir(), "wolfpack-startup-instance-"));
  try {
    const result = spawnSync(process.execPath, ["-e", `
      import { mock } from "bun:test";
      const ws = await import("ws");
      let constructed = 0;
      class CountingWebSocketServer extends ws.WebSocketServer {
        constructor(options) { super(options); constructed++; }
      }
      mock.module("ws", () => ({ ...ws, WebSocketServer: CountingWebSocketServer }));
      const module = await import("./src/server/index.ts");
      const { startServer } = module;
      const { MockBackend } = await import("./src/server/mock-backend.ts");
      const { server, wss } = await startServer(0, "127.0.0.1", { backend: new MockBackend({ sessions: ["injected"], capturePane: async () => "injected-output" }) });
      if (!server.listening) await new Promise(resolve => server.once("listening", resolve));
      const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/poll?session=injected");
      console.log("RESULT:" + JSON.stringify({
        noSingletonExports: !("server" in module) && !("wss" in module),
        listening: server.listening, constructed, response: await response.json(),
      }));
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      wss.close();
    `], { encoding: "utf8", timeout: 10000, env: {
      ...process.env, HOME: home, WOLFPACK_TEST: "1", WOLFPACK_JWT_SECRET: "",
      WOLFPACK_TASK_ROOT: join(home, "tasks"), WOLFPACK_TASK_RELAY_ROOT: join(home, "relay"),
    } });
    expect(result.status, result.stderr).toBe(0);
    const line = result.stdout.split("\n").find(line => line.startsWith("RESULT:"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice(7))).toEqual({
      noSingletonExports: true, listening: true, constructed: 1,
      response: { pane: "injected-output" },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
