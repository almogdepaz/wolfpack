import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("startup preserves early server/wss references and constructs only one WebSocketServer", () => {
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
      const { server, wss, startServer } = module;
      const { MockBackend } = await import("./src/server/mock-backend.ts");
      await startServer(0, "127.0.0.1", { backend: new MockBackend({ sessions: ["injected"], capturePane: async () => "injected-output" }) });
      if (!module.server.listening) await new Promise(resolve => module.server.once("listening", resolve));
      const response = await fetch("http://127.0.0.1:" + module.server.address().port + "/api/poll?session=injected");
      console.log("RESULT:" + JSON.stringify({
        sameServer: server === module.server, sameWss: wss === module.wss,
        listening: server.listening, constructed, response: await response.json(),
      }));
      await new Promise(resolve => { module.server.close(resolve); module.server.closeAllConnections(); });
    `], { encoding: "utf8", timeout: 10000, env: {
      ...process.env, HOME: home, WOLFPACK_TEST: "1", WOLFPACK_JWT_SECRET: "",
      WOLFPACK_TASK_ROOT: join(home, "tasks"), WOLFPACK_TASK_RELAY_ROOT: join(home, "relay"),
    } });
    expect(result.status, result.stderr).toBe(0);
    const line = result.stdout.split("\n").find(line => line.startsWith("RESULT:"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice(7))).toEqual({
      sameServer: true, sameWss: true, listening: true, constructed: 1,
      response: { pane: "injected-output" },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
